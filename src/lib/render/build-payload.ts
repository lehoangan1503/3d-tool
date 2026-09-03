/**
 * Freezes everything a GPU worker needs into a job payload.
 *
 * The worker runs headless Chrome on a rented GPU with NO Supabase session, so
 * it cannot call /api/products/[id]/settings or read extractor_references
 * itself. Every scene input is resolved here, at enqueue time, and stored on
 * the job row. A side benefit: re-running an old job reproduces the same pixels
 * even if the group or the product has been edited since.
 */

import type { RenderDbClient } from "@/lib/render/supabase-surface";
import { settingsJsonToConfig } from "@/types/product";
import type { ThreeJSSettingsJson } from "@/types/product";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";
import {
  mapReferenceRow,
  REFERENCE_WITH_FRAMES_COLUMNS,
  type ReferenceRow,
} from "@/lib/render/reference-mapper";
import type { ExtractorReference } from "@/types/extractor";
import type {
  RenderImagePayload,
  RenderJobProduct,
  RenderVideoPayload,
} from "@/types/render-job";
import type { VideoStudioConfig } from "@/types/video-studio";

export class RenderPayloadError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RenderPayloadError";
    this.status = status;
  }
}

interface ProductRow {
  id: string;
  user_id: string;
  name: string;
  type: RenderJobProduct["type"];
  surface_url: string | null;
  surface_slots: RenderJobProduct["surfaceSlots"];
  shaft_config: RenderJobProduct["shaftConfig"];
  texture_type: RenderJobProduct["textureType"];
  texture_url: string | null;
  color: RenderJobProduct["color"];
  threejs_settings_id: string | null;
}

const PRODUCT_COLUMNS =
  "id, user_id, name, type, surface_url, surface_slots, shaft_config, " +
  "texture_type, texture_url, color, threejs_settings_id";

/**
 * Loads the products to render and inlines each one's three.js settings.
 * Returns them in the order the caller asked for, so job order matches the
 * product order shown in the UI.
 */
export async function loadRenderProducts(
  supabase: RenderDbClient,
  productIds: string[]
): Promise<RenderJobProduct[]> {
  if (productIds.length === 0) {
    throw new RenderPayloadError("productIds is required");
  }

  const { data: rows, error } = await supabase
    .from("products")
    .select<ProductRow>(PRODUCT_COLUMNS)
    .in("id", productIds);

  if (error) {
    throw new RenderPayloadError(`Failed to load products: ${error.message}`, 500);
  }

  const byId = new Map<string, ProductRow>();
  for (const row of rows ?? []) byId.set(row.id, row);

  const missing = productIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new RenderPayloadError(
      `Product not found (or not visible to you): ${missing.join(", ")}`,
      404
    );
  }

  // One query for every product's settings rather than one per product.
  const settingsIds = [...new Set(
    productIds.map((id) => byId.get(id)!.threejs_settings_id).filter(Boolean)
  )] as string[];

  const settingsById = new Map<string, ThreeJSSettingsJson>();
  if (settingsIds.length > 0) {
    const { data: settingsRows } = await supabase
      .from("threejs_settings")
      .select<{ id: string; settings: ThreeJSSettingsJson | null }>("id, settings")
      .in("id", settingsIds);
    for (const row of settingsRows ?? []) {
      if (row.settings) settingsById.set(row.id, row.settings);
    }
  }

  return productIds.map((id) => {
    const row = byId.get(id)!;
    const settingsJson = row.threejs_settings_id
      ? settingsById.get(row.threejs_settings_id)
      : undefined;

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      // Storage URLs are rewritten to the public host: the GPU container is
      // outside the VPS network and cannot reach the internal IP.
      surfaceUrl: resolveStorageUrl(row.surface_url) ?? null,
      textureType: row.texture_type,
      textureUrl: resolveStorageUrl(row.texture_url) ?? null,
      color: row.color,
      config: settingsJson ? settingsJsonToConfig(settingsJson) : null,
      surfaceSlots: row.surface_slots ?? null,
      shaftConfig: row.shaft_config ?? null,
    };
  });
}

/** Resolves an image group into the ordered references it points at. */
export async function loadGroupReferences(
  supabase: RenderDbClient,
  groupId: string
): Promise<{ groupName: string; references: ExtractorReference[] }> {
  const { data: group, error: groupError } = await supabase
    .from("extractor_reference_groups")
    .select<{ id: string; name: string; reference_ids: string[] | null }>(
      "id, name, reference_ids"
    )
    .eq("id", groupId)
    .maybeSingle();

  if (groupError) {
    throw new RenderPayloadError(`Failed to load image group: ${groupError.message}`, 500);
  }
  if (!group) {
    throw new RenderPayloadError("Image group not found", 404);
  }

  const referenceIds = (group.reference_ids ?? []).filter(Boolean);
  if (referenceIds.length === 0) {
    throw new RenderPayloadError("Image group is empty", 400);
  }

  const { data: refRows, error: refError } = await supabase
    .from("extractor_references")
    .select<ReferenceRow>(REFERENCE_WITH_FRAMES_COLUMNS)
    .in("id", referenceIds);

  if (refError) {
    throw new RenderPayloadError(`Failed to load references: ${refError.message}`, 500);
  }

  const byId = new Map<string, ExtractorReference>();
  for (const row of refRows ?? []) {
    const ref = mapReferenceRow(row);
    byId.set(ref.id, ref);
  }

  // Keep the group's own order; silently drop references deleted since the
  // group was saved rather than failing the whole render.
  const references = referenceIds
    .map((id) => byId.get(id))
    .filter((r): r is ExtractorReference => Boolean(r));

  if (references.length === 0) {
    throw new RenderPayloadError(
      "Image group references no existing layouts — they may have been deleted",
      400
    );
  }

  return { groupName: group.name, references };
}

export function buildImagePayload(
  product: RenderJobProduct,
  groupId: string,
  groupName: string,
  references: ExtractorReference[],
  format: "png" | "jpeg",
  quality: number
): RenderImagePayload {
  return { kind: "image", product, groupId, groupName, references, format, quality };
}

/** Loads a video studio template's saved config. */
export async function loadVideoTemplate(
  supabase: RenderDbClient,
  templateId: string
): Promise<{ templateName: string; config: VideoStudioConfig }> {
  const { data: template, error } = await supabase
    .from("video_studio_templates")
    .select<{ id: string; name: string; config: VideoStudioConfig | null }>(
      "id, name, config"
    )
    .eq("id", templateId)
    .maybeSingle();

  if (error) {
    throw new RenderPayloadError(`Failed to load video template: ${error.message}`, 500);
  }
  if (!template?.config) {
    throw new RenderPayloadError("Video template not found", 404);
  }

  return { templateName: template.name, config: template.config };
}

export function buildVideoPayload(
  product: RenderJobProduct,
  templateId: string,
  templateName: string,
  config: VideoStudioConfig,
  width: number,
  height: number,
  fps: number
): RenderVideoPayload {
  return { kind: "video", product, templateId, templateName, config, width, height, fps };
}
