/**
 * PROCEDURAL TEXTURE BLENDING
 * Blend modes and utilities for combining textures
 * Key: Linear Light blend for subtle distortion mixing
 */

/**
 * Linear Light blend mode
 * Used to mix undistorted coords with noise-distorted coords
 * Formula: result = 2 * blend + base - 1
 */
export function linearLight(base: number, blend: number): number {
  return Math.max(0, Math.min(1, 2 * blend + base - 1));
}

/**
 * Mix two values with a factor
 * factor 0 = pure base, factor 1 = pure blend
 */
export function mix(base: number, blend: number, factor: number): number {
  return base * (1 - factor) + blend * factor;
}

/**
 * Apply color ramp (contrast adjustment)
 * Maps input [0,1] to output [0,1] with contrast
 * blackPoint and whitePoint define the input range to map
 */
export function colorRamp(
  value: number,
  blackPoint: number = 0,
  whitePoint: number = 1
): number {
  const range = whitePoint - blackPoint;
  if (range <= 0) return value > blackPoint ? 1 : 0;
  return Math.max(0, Math.min(1, (value - blackPoint) / range));
}

export interface BlendTextureConfig {
  baseData: ImageData;
  blendData: ImageData;
  factor: number;
  mode: 'linearLight' | 'mix' | 'multiply' | 'add' | 'overlay';
}

/**
 * Blend two ImageData textures
 */
export function blendTextures(config: BlendTextureConfig): ImageData {
  const { baseData, blendData, factor, mode } = config;
  const width = baseData.width;
  const height = baseData.height;

  const result = new ImageData(width, height);
  const base = baseData.data;
  const blend = blendData.data;
  const out = result.data;

  for (let i = 0; i < base.length; i += 4) {
    // Get normalized values [0, 1]
    const baseR = base[i] / 255;
    const blendR = blend[i] / 255;

    let outValue: number;

    switch (mode) {
      case 'linearLight':
        // Linear light blend, then mix with factor
        const ll = linearLight(baseR, blendR);
        outValue = mix(baseR, ll, factor);
        break;

      case 'multiply':
        outValue = mix(baseR, baseR * blendR, factor);
        break;

      case 'add':
        outValue = mix(baseR, Math.min(1, baseR + blendR), factor);
        break;

      case 'overlay':
        const overlay = baseR < 0.5
          ? 2 * baseR * blendR
          : 1 - 2 * (1 - baseR) * (1 - blendR);
        outValue = mix(baseR, overlay, factor);
        break;

      case 'mix':
      default:
        outValue = mix(baseR, blendR, factor);
        break;
    }

    const byte = Math.floor(outValue * 255);
    out[i] = byte;
    out[i + 1] = byte;
    out[i + 2] = byte;
    out[i + 3] = 255;
  }

  return result;
}

/**
 * Apply color ramp to ImageData
 */
export function applyColorRamp(
  imageData: ImageData,
  blackPoint: number = 0,
  whitePoint: number = 1
): ImageData {
  const width = imageData.width;
  const height = imageData.height;
  const result = new ImageData(width, height);
  const src = imageData.data;
  const dst = result.data;

  for (let i = 0; i < src.length; i += 4) {
    const normalized = src[i] / 255;
    const ramped = colorRamp(normalized, blackPoint, whitePoint);
    const byte = Math.floor(ramped * 255);

    dst[i] = byte;
    dst[i + 1] = byte;
    dst[i + 2] = byte;
    dst[i + 3] = 255;
  }

  return result;
}

/**
 * Invert ImageData
 */
export function invertTexture(imageData: ImageData): ImageData {
  const width = imageData.width;
  const height = imageData.height;
  const result = new ImageData(width, height);
  const src = imageData.data;
  const dst = result.data;

  for (let i = 0; i < src.length; i += 4) {
    dst[i] = 255 - src[i];
    dst[i + 1] = 255 - src[i + 1];
    dst[i + 2] = 255 - src[i + 2];
    dst[i + 3] = 255;
  }

  return result;
}

/**
 * Convert heightmap to normal map
 * Uses Sobel filter for gradient detection
 */
export function heightToNormalMap(
  heightData: ImageData,
  strength: number = 1.0
): ImageData {
  const width = heightData.width;
  const height = heightData.height;
  const result = new ImageData(width, height);
  const src = heightData.data;
  const dst = result.data;

  // Helper to get height at pixel (with wrapping)
  const getHeight = (x: number, y: number): number => {
    x = ((x % width) + width) % width;
    y = ((y % height) + height) % height;
    return src[(y * width + x) * 4] / 255;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sobel filter for gradients
      const tl = getHeight(x - 1, y - 1);
      const t = getHeight(x, y - 1);
      const tr = getHeight(x + 1, y - 1);
      const l = getHeight(x - 1, y);
      const r = getHeight(x + 1, y);
      const bl = getHeight(x - 1, y + 1);
      const b = getHeight(x, y + 1);
      const br = getHeight(x + 1, y + 1);

      // Sobel gradients
      const dX = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dY = (bl + 2 * b + br) - (tl + 2 * t + tr);

      // Create normal vector
      let nx = -dX * strength;
      let ny = -dY * strength;
      let nz = 1.0;

      // Normalize
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len;
      ny /= len;
      nz /= len;

      // Map from [-1,1] to [0,255]
      const idx = (y * width + x) * 4;
      dst[idx] = Math.floor((nx * 0.5 + 0.5) * 255);     // R = X
      dst[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255); // G = Y
      dst[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255); // B = Z
      dst[idx + 3] = 255;
    }
  }

  return result;
}

/**
 * Combine multiple bump/height maps into one
 * Simulates chaining bump nodes in Blender
 */
export function combineBumpMaps(
  layers: Array<{ data: ImageData; strength: number; invert?: boolean }>
): ImageData {
  if (layers.length === 0) {
    throw new Error("At least one layer required");
  }

  const width = layers[0].data.width;
  const height = layers[0].data.height;
  const result = new ImageData(width, height);
  const dst = result.data;

  // Initialize with neutral gray (0.5)
  for (let i = 0; i < dst.length; i += 4) {
    dst[i] = 128;
    dst[i + 1] = 128;
    dst[i + 2] = 128;
    dst[i + 3] = 255;
  }

  // Blend each layer
  for (const layer of layers) {
    const src = layer.data.data;
    const strength = layer.strength;

    for (let i = 0; i < src.length; i += 4) {
      let srcValue = src[i] / 255;
      if (layer.invert) srcValue = 1 - srcValue;

      // Center around 0.5 (neutral)
      const delta = (srcValue - 0.5) * strength;

      // Add to existing value
      const current = dst[i] / 255;
      const combined = Math.max(0, Math.min(1, current + delta));
      const byte = Math.floor(combined * 255);

      dst[i] = byte;
      dst[i + 1] = byte;
      dst[i + 2] = byte;
    }
  }

  return result;
}

/**
 * Create canvas from ImageData
 */
export function imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Get ImageData from canvas
 */
export function canvasToImageData(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext("2d")!;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
