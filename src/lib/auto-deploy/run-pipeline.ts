import type { Product, ProductConfig, ThreeJSSettingsJson, LeatherColor, LeatherTextureType } from "@/types/product";
import { MODEL_PATHS, settingsJsonToConfig } from "@/types/product";
import type { ExtractorReference, ExtractorReferenceGroup } from "@/types/extractor";
import type { ShopifySkill } from "@/types/product";
import type { ShopifyDeployRequest } from "@/lib/shopify/form-data";
import * as THREE from "three";
import { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { renderReferenceToBlob } from "@/components/editor/image-extractor";
import { uploadBlobToStorage } from "@/lib/supabase/upload";
import { parseProductTitle } from "@/lib/shopify/parse-title";
import { buildPreviewPose } from "@/lib/shopify/preview-pose";
import { ensureFullConfig, type VideoStudioConfig } from "@/types/video-studio";
import type { AutoDeployConfig } from "./types";

export type RunStep = "render" | "video" | "upload" | "content" | "deploy";

export interface VideoTemplate {
  id: string;
  name: string;
  config: Partial<VideoStudioConfig>;
}

export interface RunProgress {
  step: RunStep;
  /** For the render step: how many references are done / total. */
  done?: number;
  total?: number;
}

export interface RunProductResult {
  productId: string;
  success: boolean;
  adminUrl?: string;
  storefrontUrl?: string;
  title?: string;
  isUpdate?: boolean;
  error?: string;
}

/** Shared context fetched once per run and reused for every product. */
export interface RunContext {
  references: ExtractorReference[];
  skills: ShopifySkill[];
  config: AutoDeployConfig;
  /** Resolved video template when config.videoTemplateId is set, else null. */
  videoTemplate: VideoTemplate | null;
}

interface GenerateContentResult {
  title: string;
  description: string;
}

/** Fetch each reference belonging to the selected groups (deduped, order preserved). */
export async function fetchReferencesForGroups(
  groupIds: string[],
  signal?: AbortSignal,
): Promise<ExtractorReference[]> {
  // Resolve groups → reference ids.
  const groupsRes = await fetch("/api/extractor-reference-groups", { signal });
  if (!groupsRes.ok) throw new Error("Không tải được nhóm khung ảnh");
  const groupsJson = await groupsRes.json();
  const allGroups = (groupsJson.items ?? groupsJson.data ?? groupsJson) as ExtractorReferenceGroup[];
  const picked = allGroups.filter((g) => groupIds.includes(g.id));

  const seen = new Set<string>();
  const refs: ExtractorReference[] = [];
  for (const group of picked) {
    for (const refId of group.referenceIds) {
      if (seen.has(refId)) continue;
      seen.add(refId);
      const res = await fetch(`/api/extractor-references/${refId}`, { signal });
      if (!res.ok) continue;
      refs.push((await res.json()) as ExtractorReference);
    }
  }
  return refs;
}

/** Fetch the skills referenced by the run config so we can compose the AI prompt. */
export async function fetchSkills(skillIds: string[], signal?: AbortSignal): Promise<ShopifySkill[]> {
  if (skillIds.length === 0) return [];
  const res = await fetch("/api/shopify/skills", { signal });
  if (!res.ok) return [];
  const json = await res.json();
  const all = (json.items ?? []) as ShopifySkill[];
  return all.filter((s) => skillIds.includes(s.id));
}

/** Resolve the chosen video template (with its config) from the templates list. */
export async function fetchVideoTemplate(
  videoTemplateId: string | null,
  signal?: AbortSignal,
): Promise<VideoTemplate | null> {
  if (!videoTemplateId) return null;
  const res = await fetch("/api/video-studio-templates?limit=100", { signal });
  if (!res.ok) return null;
  const json = await res.json();
  const all = (json.items ?? []) as VideoTemplate[];
  return all.find((t) => t.id === videoTemplateId) ?? null;
}

async function fetchProductConfig(productId: string, signal?: AbortSignal): Promise<ProductConfig | null> {
  try {
    const res = await fetch(`/api/products/${productId}/settings`, { signal });
    if (!res.ok) return null;
    const json = (await res.json()) as ThreeJSSettingsJson;
    return settingsJsonToConfig(json);
  } catch {
    return null;
  }
}

function composeSkillPrompt(skills: ShopifySkill[]): string {
  return skills.map((s) => s.prompt_text?.trim()).filter(Boolean).join("\n\n");
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Stream the SSE content endpoint and return the final title/description. */
async function generateContent(
  firstImageBlob: Blob,
  config: AutoDeployConfig,
  skills: ShopifySkill[],
  product: Product,
  signal?: AbortSignal,
): Promise<GenerateContentResult> {
  const dataUrl = await blobToDataUrl(firstImageBlob);
  const skillPrompt = composeSkillPrompt(skills);
  const hint = parseProductTitle(product.name, config.codeFormat).theme ?? undefined;

  const res = await fetch("/api/shopify/generate-content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      imageUrl: dataUrl,
      hint,
      skillPrompt: skillPrompt || undefined,
      model: config.aiModel,
      versions: config.versions.length ? config.versions : undefined,
    }),
  });
  if (!res.ok || !res.body) throw new Error("Tạo nội dung AI thất bại");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: GenerateContentResult | null = null;
  let errorMessage: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";
    for (const chunk of lines) {
      const line = chunk.replace(/^data:\s*/, "").trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line) as { type: string; title?: string; description?: string; message?: string };
        if (event.type === "result") {
          result = { title: event.title ?? "", description: event.description ?? "" };
        } else if (event.type === "error") {
          errorMessage = event.message ?? "Lỗi tạo nội dung AI";
        }
      } catch {
        /* skip malformed */
      }
    }
  }

  if (!result) throw new Error(errorMessage ?? "AI không trả về nội dung");
  return result;
}

/**
 * Render a studio video for the product's model into a WebM blob. Chrome throttles
 * rAF for hidden canvases, so the recording canvas is mounted into a visible (but
 * tiny, corner-pinned) container for the duration of the recording.
 */
async function renderVideo(
  model: THREE.Group,
  template: VideoTemplate,
  signal?: AbortSignal,
): Promise<Blob> {
  const esm = new ExtractorSceneManager(1920, 1080);
  const canvas = esm.getCanvas();
  const holder = document.createElement("div");
  // Visible (not display:none / off-screen) so Chrome keeps rAF running, but
  // pinned to a 1px corner so it doesn't disrupt the page.
  holder.style.cssText = "position:fixed;right:0;bottom:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1;";
  canvas.style.cssText = "width:100%;height:100%;display:block;";
  holder.appendChild(canvas);
  document.body.appendChild(holder);

  try {
    if (signal?.aborted) throw new Error("Đã hủy");
    esm.setModel(model);
    const config = ensureFullConfig(template.config);
    return await esm.startStudioRecording(config);
  } finally {
    esm.dispose();
    if (holder.parentNode) holder.parentNode.removeChild(holder);
  }
}

/**
 * Run the full deploy pipeline for ONE product:
 *   render references → upload images → generate AI content → create/update Shopify product.
 * Mirrors the Shopify deploy dialog's chain, applied headlessly with the run config.
 * `onProgress` reports the current step; throws on the first failing step (the
 * caller decides skip-vs-stop).
 */
export async function runProductDeploy(
  product: Product,
  ctx: RunContext,
  onProgress?: (p: RunProgress) => void,
  signal?: AbortSignal,
): Promise<RunProductResult> {
  const { references, skills, config, videoTemplate } = ctx;

  // ── Build an offscreen scene for this product (mirrors bulk-image-tab setup) ──
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;";
  document.body.appendChild(container);
  const sm = new SceneManager(container);

  const imageBlobs: { name: string; blob: Blob }[] = [];
  let videoBlob: Blob | null = null;

  try {
    await sm.loadModel(MODEL_PATHS[product.type]);
    const productConfig = await fetchProductConfig(product.id, signal);
    await sm.applySurface({
      surfaceUrl: product.surface_url,
      productType: product.type,
      leatherColor: product.color as LeatherColor | null,
      leatherTexture: product.texture_type as LeatherTextureType | null,
      textureScale: productConfig?.textureScale ?? 1,
      logoId: productConfig?.logoId ?? "uni",
    });

    // Match the editor render: apply per-product joint/body material settings.
    if (productConfig) {
      sm.updateBodyRoughness(productConfig.bodyRoughness);
      sm.updateJointConfig({
        roughness: productConfig.jointRoughness,
        clearcoat: productConfig.jointClearcoat,
        metalness: productConfig.jointMetalness,
      });
    }

    const model = sm.getModelForClone();

    // ── Step 1: render each reference ──
    for (let i = 0; i < references.length; i++) {
      if (signal?.aborted) throw new Error("Đã hủy");
      onProgress?.({ step: "render", done: i, total: references.length });
      const ref = references[i];
      // Same args as the deploy dialog: surface only applied to dynamic image
      // frames (cue uses each frame's snapshot surface).
      const blob = await renderReferenceToBlob(model, ref, undefined, product.surface_url);
      imageBlobs.push({ name: ref.name, blob });
    }
    onProgress?.({ step: "render", done: references.length, total: references.length });

    // ── Step 1b (optional): render a studio video for this product ──
    if (videoTemplate && model) {
      if (signal?.aborted) throw new Error("Đã hủy");
      onProgress?.({ step: "video" });
      videoBlob = await renderVideo(model, videoTemplate, signal);
    }
  } finally {
    sm.dispose();
    if (container.parentNode) container.parentNode.removeChild(container);
  }

  if (imageBlobs.length === 0) throw new Error("Không render được ảnh nào");

  // ── Step 2: upload images to storage ──
  onProgress?.({ step: "upload" });
  const ts = Date.now();
  const imageUrls: string[] = [];
  const imageNames: string[] = [];
  for (let i = 0; i < imageBlobs.length; i++) {
    if (signal?.aborted) throw new Error("Đã hủy");
    const { name, blob } = imageBlobs[i];
    const path = `shopify-mockups/${product.id}/${ts}-img-${i}.png`;
    imageUrls.push(await uploadBlobToStorage(blob, path, "image/png"));
    imageNames.push(name);
  }

  // Upload the video (if rendered) alongside the images.
  let videoUrl: string | null = null;
  if (videoBlob) {
    if (signal?.aborted) throw new Error("Đã hủy");
    const videoPath = `shopify-mockups/${product.id}/${ts}-video.webm`;
    videoUrl = await uploadBlobToStorage(videoBlob, videoPath, "video/webm");
  }

  // ── Step 3: generate AI content ──
  onProgress?.({ step: "content" });
  const content = await generateContent(imageBlobs[0].blob, config, skills, product, signal);

  // ── Step 4: create/update Shopify product ──
  onProgress?.({ step: "deploy" });
  const productCode = parseProductTitle(product.name, config.codeFormat).code ?? "";
  // Custom-text config feeds either the free or paid metafield (mutually exclusive).
  const customTextConfig =
    config.customTextMode !== "none"
      ? { label: config.customTextLabel.trim(), example: config.customTextExample.trim() }
      : null;
  const payload: ShopifyDeployRequest = {
    productId: product.id,
    storeId: config.storeId ?? undefined,
    deployTemplateId: config.deployTemplateId ?? null,
    productCode,
    title: content.title,
    description: content.description,
    collections: config.collections,
    breadcrumbCollection: config.breadcrumbCollection,
    imageUrls,
    imageNames,
    videoUrl,
    versions: config.versions,
    wrapType: config.wrapType,
    laserShaft: config.laserShaft,
    customImage: config.customImage,
    customText: config.customTextMode === "free" ? customTextConfig : null,
    customTextPaid: config.customTextMode === "paid" ? customTextConfig : null,
    aiModel: config.aiModel,
    manualTags: config.manualTags,
    skillIds: config.skillIds,
    surfaceSlots: product.surface_slots,
    surfaceImageUrl: product.surface_url ?? null,
    shaftConfig: product.shaft_config ?? null,
    // Pose of the main gallery mockup, so the storefront can swap a 3D canvas
    // over it at the identical angle. imageNames/imageUrls stay index-aligned
    // with `references` here, so the primary reference maps to its real URL.
    previewPose: buildPreviewPose(
      references,
      new Map(imageNames.map((name, i) => [name.trim().toLowerCase(), imageUrls[i]])),
    ),
  };

  const res = await fetch("/api/shopify/create-product", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error ?? `Tạo sản phẩm Shopify thất bại (${res.status})`);
  }

  return {
    productId: product.id,
    success: true,
    adminUrl: json.adminUrl,
    storefrontUrl: json.storefrontUrl,
    title: json.title,
    isUpdate: json.isUpdate,
  };
}
