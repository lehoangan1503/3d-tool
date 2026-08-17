/**
 * Exports many products' 3D models to a single .zip, one folder per product.
 *
 * Each product needs its own textured model, and every model means a WebGL context plus a
 * full set of decoded KTX2 textures. Loading them all at once exhausts GPU memory, so this
 * runs strictly serially: load one product off-screen, export it, tear the context down,
 * then move to the next.
 */

import { SceneManager } from "@/lib/three/scene-manager";
import { MODEL_PATHS, settingsJsonToConfig } from "@/types/product";
import type { Product, ProductConfig, ThreeJSSettingsJson, LeatherColor, LeatherTextureType } from "@/types/product";
import { buildProductGlb, zipManyProducts, type ProductGlbResult } from "./export-product-3d";

/** SceneManager's default HDRI (see `currentHdriUrl` in scene-manager.ts). */
const DEFAULT_EXPORT_HDRI = "bloem_train_track_clear_2k.hdr";

export interface BulkExport3DProgress {
  done: number;
  total: number;
  current: string;
}

export interface BulkExport3DOptions {
  shadow?: boolean;
  /** HDRI file name to bundle; defaults to the customizer's default environment. */
  hdriFile?: string | null;
  /** Embed a light rig fitted to the HDRI inside each .glb. */
  embedLights?: boolean;
  onProgress?: (progress: BulkExport3DProgress) => void;
  /** Polled between products so the user can stop a long run. */
  isCancelled?: () => boolean;
}

async function fetchProductConfig(productId: string): Promise<ProductConfig | null> {
  try {
    const response = await fetch(`/api/products/${productId}/settings`);
    if (!response.ok) return null;
    return settingsJsonToConfig((await response.json()) as ThreeJSSettingsJson);
  } catch {
    return null;
  }
}

/**
 * Loads one product into a throwaway off-screen SceneManager and exports its .glb.
 *
 * Mirrors `loadProductIntoEsm` / `bulk-image-tab`, but keeps the SceneManager alive until
 * the export finishes — the exporter reads the live canvas textures, so disposing the
 * manager first would blank the procedural body maps.
 */
async function exportOne(
  product: Product,
  options: { shadow: boolean; hdriFile: string | null; embedLights: boolean }
): Promise<ProductGlbResult> {
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;";
  document.body.appendChild(container);

  const sm = new SceneManager(container);
  try {
    await sm.loadModel(MODEL_PATHS[product.type]);
    const config = await fetchProductConfig(product.id);

    await sm.applySurface({
      surfaceUrl: product.surface_url,
      productType: product.type,
      leatherColor: product.color as LeatherColor | null,
      leatherTexture: product.texture_type as LeatherTextureType | null,
      textureScale: config?.textureScale ?? 1,
      logoId: config?.logoId ?? "uni",
    });

    if (config) {
      sm.updateBodyRoughness(config.bodyRoughness);
      sm.updateJointConfig({
        roughness: config.jointRoughness,
        clearcoat: config.jointClearcoat,
        metalness: config.jointMetalness,
      });
    }

    const model = sm.getModelForClone();
    if (!model) throw new Error(`No model loaded for product "${product.name}"`);

    return await buildProductGlb(model, {
      shadow: options.shadow,
      hdriFile: options.hdriFile,
      embedLights: options.embedLights,
    });
  } finally {
    sm.dispose();
    if (container.parentNode) container.parentNode.removeChild(container);
  }
}

export interface BulkExport3DResult {
  zip: Blob | null;
  /** Products that failed, so the caller can tell the user what is missing. */
  failed: Array<{ name: string; error: string }>;
  exported: number;
}

/**
 * Exports every product in `products` and returns one .zip containing all of them.
 * A product that fails is recorded and skipped rather than aborting the batch.
 */
export async function bulkExport3D(
  products: Product[],
  options: BulkExport3DOptions = {}
): Promise<BulkExport3DResult> {
  const {
    shadow = true,
    // Matches SceneManager's default environment, so bulk downloads are lit like the editor.
    hdriFile = DEFAULT_EXPORT_HDRI,
    embedLights = false,
    onProgress,
    isCancelled,
  } = options;

  const entries: Array<{ name: string; result: ProductGlbResult }> = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (let i = 0; i < products.length; i++) {
    if (isCancelled?.()) break;

    const product = products[i];
    onProgress?.({ done: i, total: products.length, current: product.name });

    try {
      const result = await exportOne(product, { shadow, hdriFile, embedLights });
      entries.push({ name: product.name, result });
    } catch (error) {
      console.error(`[bulkExport3D] Failed to export "${product.name}":`, error);
      failed.push({ name: product.name, error: error instanceof Error ? error.message : String(error) });
    }

    // Give the browser a moment to release the WebGL context before the next one.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }

  onProgress?.({ done: products.length, total: products.length, current: "" });

  if (entries.length === 0) return { zip: null, failed, exported: 0 };

  return { zip: await zipManyProducts(entries), failed, exported: entries.length };
}
