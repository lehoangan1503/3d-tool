/**
 * PROCEDURAL NOISE GENERATOR
 * Simplex noise for leather texture distortion
 * Based on Stefan Gustavson's implementation
 */

// Permutation table for noise
const perm = new Uint8Array(512);
const gradP = new Array(512);

// Gradient vectors for 2D
const grad3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

// Initialize permutation table with seed
function initNoise(seed: number = 0): void {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;

  // Shuffle with seed
  let n = seed;
  for (let i = 255; i > 0; i--) {
    n = (n * 16807) % 2147483647;
    const j = n % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }

  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    gradP[i] = grad3[perm[i] % 12];
  }
}

// Initialize with default seed
initNoise(0);

// Skewing factors for 2D simplex
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/**
 * 2D Simplex noise
 * Returns value in range [-1, 1]
 */
export function simplex2D(x: number, y: number): number {
  let n0 = 0, n1 = 0, n2 = 0;

  // Skew input space
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);

  // Unskew back to get the cell origin
  const t = (i + j) * G2;
  const X0 = i - t;
  const Y0 = j - t;
  const x0 = x - X0;
  const y0 = y - Y0;

  // Determine which simplex we're in
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;

  // Offsets for corners
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;

  // Hash coordinates
  const ii = i & 255;
  const jj = j & 255;

  // Calculate contributions from three corners
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 >= 0) {
    const gi0 = gradP[ii + perm[jj]];
    t0 *= t0;
    n0 = t0 * t0 * (gi0[0] * x0 + gi0[1] * y0);
  }

  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 >= 0) {
    const gi1 = gradP[ii + i1 + perm[jj + j1]];
    t1 *= t1;
    n1 = t1 * t1 * (gi1[0] * x1 + gi1[1] * y1);
  }

  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 >= 0) {
    const gi2 = gradP[ii + 1 + perm[jj + 1]];
    t2 *= t2;
    n2 = t2 * t2 * (gi2[0] * x2 + gi2[1] * y2);
  }

  // Scale to [-1, 1]
  return 70 * (n0 + n1 + n2);
}

/**
 * Fractal Brownian Motion (fBm) noise
 * Adds multiple octaves for more detail
 */
export function fbmNoise(
  x: number,
  y: number,
  octaves: number = 4,
  lacunarity: number = 2.0,
  persistence: number = 0.5
): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * simplex2D(x * frequency, y * frequency);
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return value / maxValue;
}

export interface NoiseTextureConfig {
  width: number;
  height: number;
  scale: number;
  detail: number;      // Maps to octaves (1-10 → 1-6 octaves)
  offsetX?: number;
  offsetY?: number;
  seed?: number;
}

/**
 * Generate noise texture as ImageData
 * Output: grayscale values 0-255
 */
export function generateNoiseTexture(config: NoiseTextureConfig): ImageData {
  const { width, height, scale, detail, offsetX = 0, offsetY = 0, seed } = config;
  
  if (seed !== undefined) {
    initNoise(seed);
  }

  const imageData = new ImageData(width, height);
  const data = imageData.data;

  // Map detail (1-10) to octaves (1-6)
  const octaves = Math.max(1, Math.min(6, Math.floor(detail * 0.6)));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x + offsetX) / scale;
      const ny = (y + offsetY) / scale;

      // Get noise value [-1, 1] and map to [0, 1]
      const noise = (fbmNoise(nx, ny, octaves) + 1) * 0.5;
      const value = Math.floor(noise * 255);

      const idx = (y * width + x) * 4;
      data[idx] = value;     // R
      data[idx + 1] = value; // G
      data[idx + 2] = value; // B
      data[idx + 3] = 255;   // A
    }
  }

  return imageData;
}

/**
 * Generate noise as canvas
 */
export function generateNoiseCanvas(config: NoiseTextureConfig): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = config.width;
  canvas.height = config.height;
  const ctx = canvas.getContext("2d")!;
  
  const imageData = generateNoiseTexture(config);
  ctx.putImageData(imageData, 0, 0);
  
  return canvas;
}

/**
 * Sample noise at a specific UV coordinate
 * Returns value in range [0, 1]
 */
export function sampleNoise(
  u: number,
  v: number,
  scale: number,
  detail: number = 4
): number {
  const octaves = Math.max(1, Math.min(6, Math.floor(detail * 0.6)));
  const noise = fbmNoise(u * scale, v * scale, octaves);
  return (noise + 1) * 0.5;
}
