/**
 * LEATHER SURFACE MODULE
 * Creates composite surface images with leather overlay
 */

import { LEATHER_FRAME } from "./leather-frame";

export interface LeatherMaterialConfig {
  roughness: number;
  clearcoat: number;
  normalScale: number;
}

// Preset for leather material properties
export const LEATHER_MATERIAL_CONFIG: LeatherMaterialConfig = {
  roughness: 120,
  clearcoat: 5,
  normalScale: 3.5,
};

/**
 * Load an image as a promise
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Create a mixed surface image with leather color overlay
 * Composites leather color on top of surface at the leather region
 */
export async function createLeatherSurface(
  surfacePath: string,
  leatherColorHex: string
): Promise<HTMLCanvasElement> {
  const surfaceImg = await loadImage(surfacePath);

  const canvas = document.createElement("canvas");
  canvas.width = surfaceImg.width;
  canvas.height = surfaceImg.height;
  const ctx = canvas.getContext("2d")!;

  // Draw base surface
  ctx.drawImage(surfaceImg, 0, 0);

  // Calculate scale if canvas differs from original frame dimensions
  const scaleX = canvas.width / LEATHER_FRAME.surfaceWidth;
  const scaleY = canvas.height / LEATHER_FRAME.surfaceHeight;

  // Draw leather color at frame position (scaled)
  const drawX = LEATHER_FRAME.x * scaleX;
  const drawY = LEATHER_FRAME.y * scaleY;
  const drawW = LEATHER_FRAME.width * scaleX;
  const drawH = LEATHER_FRAME.height * scaleY;

  ctx.fillStyle = leatherColorHex;
  ctx.fillRect(drawX, drawY, drawW, drawH);

  console.log("[LeatherSurface] Created mixed surface:", {
    surfaceSize: `${canvas.width}x${canvas.height}`,
    leatherAt: `${drawX.toFixed(0)},${drawY.toFixed(0)} ${drawW.toFixed(0)}x${drawH.toFixed(0)}`,
    colorHex: leatherColorHex,
  });

  return canvas;
}

/**
 * Create a roughness map for leather products
 * Leather region = leatherRoughness (matte leather texture)
 * Other regions = bodyRoughness (glossy lacquer body)
 * 
 * @param width - Canvas width
 * @param height - Canvas height
 * @param leatherRoughness - Roughness value for leather area (0-255, default 120)
 * @param bodyRoughness - Roughness value for non-leather body area (0-255, default 10)
 */
export function createLeatherRoughnessMap(
  width: number,
  height: number,
  leatherRoughness: number = 120,
  bodyRoughness: number = 10
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Calculate scale
  const scaleY = height / LEATHER_FRAME.surfaceHeight;

  // Fill entire canvas with body roughness (non-leather areas)
  ctx.fillStyle = `rgb(${bodyRoughness}, ${bodyRoughness}, ${bodyRoughness})`;
  ctx.fillRect(0, 0, width, height);

  // Fill leather region with leather roughness (matte)
  const leatherY = LEATHER_FRAME.y * scaleY;
  const leatherH = LEATHER_FRAME.height * scaleY;

  ctx.fillStyle = `rgb(${leatherRoughness}, ${leatherRoughness}, ${leatherRoughness})`;
  ctx.fillRect(0, leatherY, width, leatherH);

  console.log("[LeatherRoughnessMap] Created:", {
    canvasSize: `${width}x${height}`,
    scaleY: scaleY.toFixed(3),
    leatherRegion: `Y=${leatherY.toFixed(0)} H=${leatherH.toFixed(0)} (${(leatherY).toFixed(0)}-${(leatherY + leatherH).toFixed(0)})`,
    leatherRoughness,
    bodyRoughness,
    leatherYRatio: `${(leatherY / height * 100).toFixed(1)}% - ${((leatherY + leatherH) / height * 100).toFixed(1)}%`,
  });

  return canvas;
}

/**
 * Create a clearcoat map for leather products
 * Leather region = low/no clearcoat
 * Other regions = full clearcoat (white)
 */
export function createLeatherClearcoatMap(
  width: number,
  height: number,
  clearcoatValue: number = 5
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Calculate scale
  const scaleY = height / LEATHER_FRAME.surfaceHeight;

  // Fill entire canvas with full clearcoat (white)
  ctx.fillStyle = "rgb(255, 255, 255)";
  ctx.fillRect(0, 0, width, height);

  // Fill leather region with low clearcoat
  const leatherY = LEATHER_FRAME.y * scaleY;
  const leatherH = LEATHER_FRAME.height * scaleY;

  ctx.fillStyle = `rgb(${clearcoatValue}, ${clearcoatValue}, ${clearcoatValue})`;
  ctx.fillRect(0, leatherY, width, leatherH);

  console.log("[LeatherClearcoatMap] Created:", {
    canvasSize: `${width}x${height}`,
    leatherRegion: `Y=${leatherY.toFixed(0)} H=${leatherH.toFixed(0)}`,
    clearcoatValue,
  });

  return canvas;
}

/**
 * Get leather surface as canvas data URL
 */
export async function getLeatherSurfaceDataUrl(
  surfacePath: string,
  leatherColorHex: string
): Promise<string> {
  const canvas = await createLeatherSurface(surfacePath, leatherColorHex);
  return canvas.toDataURL("image/jpeg", 0.95);
}
