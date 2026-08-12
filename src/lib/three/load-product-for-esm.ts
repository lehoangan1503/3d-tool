/**
 * Loads a Product's 3D model + surface texture into an ExtractorSceneManager.
 *
 * The pattern: create a tiny off-screen container + SceneManager, load the GLTF
 * model, apply the product surface, clone the resulting model into the ESM, then
 * dispose the temporary SceneManager and remove the container.
 *
 * This lets the bulk export pipeline reuse a single ESM across many products without
 * keeping multiple WebGL contexts alive simultaneously.
 */

import { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { MODEL_PATHS, settingsJsonToConfig } from "@/types/product";
import type { Product, ProductConfig, ThreeJSSettingsJson } from "@/types/product";

async function fetchProductConfig(productId: string): Promise<ProductConfig | null> {
  try {
    const response = await fetch(`/api/products/${productId}/settings`);
    if (!response.ok) return null;
    return settingsJsonToConfig(await response.json() as ThreeJSSettingsJson);
  } catch {
    return null;
  }
}

/**
 * Loads a product model into an existing ExtractorSceneManager.
 * Creates a temporary SceneManager on a hidden off-screen container,
 * loads the GLTF model and applies the product surface, then clones
 * the model into `esm` via `esm.setModel()`.
 *
 * @throws if the model fails to load
 */
export async function loadProductIntoEsm(
  product: Product,
  esm: ExtractorSceneManager
): Promise<void> {
  // Create a hidden 1×1 container element. SceneManager appends its canvas to this.
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;";
  document.body.appendChild(container);

  const sm = new SceneManager(container);
  try {
    // Load GLTF model for this product type
    const modelPath = MODEL_PATHS[product.type];
    await sm.loadModel(modelPath);
    const config = await fetchProductConfig(product.id);

    // Apply the product's surface texture (image, color, leather pattern)
    await sm.applySurface({
      surfaceUrl: product.surface_url,
      productType: product.type,
      leatherColor: product.color as import("@/types/product").LeatherColor | null,
      leatherTexture: product.texture_type as import("@/types/product").LeatherTextureType | null,
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

    // Clone the loaded model into the ESM
    const model = sm.getModelForClone();
    if (!model) throw new Error(`No model loaded for product "${product.name}"`);
    esm.setModel(model);
  } finally {
    sm.dispose();
    if (container.parentNode) container.parentNode.removeChild(container);
  }
}
