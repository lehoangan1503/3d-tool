/**
 * PROCEDURAL VORONOI GENERATOR
 * Creates voronoi patterns for leather cracks and grain
 * Supports F1 (closest point) and distance-to-edge modes
 */

// Improved hash function for better randomness distribution
function hash2D(ix: number, iy: number, seed: number = 0): [number, number] {
  // Use multiple mixing steps for better distribution
  let n = ix + iy * 57 + seed * 131;
  n = (n << 13) ^ n;
  const n1 = ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff);
  
  let m = ix * 73 + iy * 179 + seed * 233;
  m = (m << 13) ^ m;
  const n2 = ((m * (m * m * 15731 + 789221) + 1376312589) & 0x7fffffff);
  
  return [
    (n1 % 10000) / 10000,
    (n2 % 10000) / 10000,
  ];
}

// Additional jitter for more organic cell positions
function jitteredHash2D(ix: number, iy: number, seed: number = 0, jitter: number = 0.3): [number, number] {
  const [rx, ry] = hash2D(ix, iy, seed);
  // Add extra jitter based on neighboring cells for more organic look
  const [jx, jy] = hash2D(ix + 100, iy + 100, seed + 1);
  return [
    rx + (jx - 0.5) * jitter,
    ry + (jy - 0.5) * jitter,
  ];
}

export type VoronoiMode = 'F1' | 'F2' | 'distanceToEdge';

export interface VoronoiResult {
  f1: number;           // Distance to closest point
  f2: number;           // Distance to second closest
  distanceToEdge: number;
  cellId: number;       // ID of closest cell
}

/**
 * Calculate voronoi at a point
 * Returns distances to closest cells
 */
export function voronoiAt(
  x: number,
  y: number,
  randomness: number = 1.0,
  seed: number = 0
): VoronoiResult {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);

  let minDist1 = Infinity;
  let minDist2 = Infinity;
  let closestCellId = 0;
  let closestPointX = 0;
  let closestPointY = 0;

  // Check 3x3 neighborhood
  for (let offsetY = -1; offsetY <= 1; offsetY++) {
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      const neighborX = cellX + offsetX;
      const neighborY = cellY + offsetY;

      // Get random point in this cell
      const [rx, ry] = hash2D(neighborX, neighborY, seed);
      const pointX = neighborX + 0.5 + (rx - 0.5) * randomness;
      const pointY = neighborY + 0.5 + (ry - 0.5) * randomness;

      // Distance to this point
      const dx = x - pointX;
      const dy = y - pointY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < minDist1) {
        minDist2 = minDist1;
        minDist1 = dist;
        closestCellId = neighborX * 1000 + neighborY;
        closestPointX = pointX;
        closestPointY = pointY;
      } else if (dist < minDist2) {
        minDist2 = dist;
      }
    }
  }

  // Calculate distance to edge (F2 - F1 based approximation)
  // More accurate: project point onto edge between two closest cells
  const distanceToEdge = (minDist2 - minDist1) * 0.5;

  return {
    f1: minDist1,
    f2: minDist2,
    distanceToEdge,
    cellId: closestCellId,
  };
}

/**
 * Enhanced voronoi with distance to actual edge
 * More expensive but more accurate for cracks
 */
export function voronoiEdgeDistance(
  x: number,
  y: number,
  randomness: number = 1.0,
  seed: number = 0
): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);

  // First pass: find closest point
  let minDist = Infinity;
  let closestX = 0;
  let closestY = 0;

  for (let offsetY = -1; offsetY <= 1; offsetY++) {
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      const neighborX = cellX + offsetX;
      const neighborY = cellY + offsetY;
      const [rx, ry] = hash2D(neighborX, neighborY, seed);
      const pointX = neighborX + 0.5 + (rx - 0.5) * randomness;
      const pointY = neighborY + 0.5 + (ry - 0.5) * randomness;

      const dx = x - pointX;
      const dy = y - pointY;
      const dist = dx * dx + dy * dy;

      if (dist < minDist) {
        minDist = dist;
        closestX = pointX;
        closestY = pointY;
      }
    }
  }

  // Second pass: find distance to edge with any neighbor
  let minEdgeDist = Infinity;

  for (let offsetY = -2; offsetY <= 2; offsetY++) {
    for (let offsetX = -2; offsetX <= 2; offsetX++) {
      const neighborX = cellX + offsetX;
      const neighborY = cellY + offsetY;
      const [rx, ry] = hash2D(neighborX, neighborY, seed);
      const pointX = neighborX + 0.5 + (rx - 0.5) * randomness;
      const pointY = neighborY + 0.5 + (ry - 0.5) * randomness;

      // Skip if this is the closest point
      if (Math.abs(pointX - closestX) < 0.001 && Math.abs(pointY - closestY) < 0.001) {
        continue;
      }

      // Find midpoint between closest and this point
      const midX = (closestX + pointX) * 0.5;
      const midY = (closestY + pointY) * 0.5;

      // Direction from closest to this point (edge normal)
      const dirX = pointX - closestX;
      const dirY = pointY - closestY;
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
      if (dirLen < 0.001) continue;

      const normX = dirX / dirLen;
      const normY = dirY / dirLen;

      // Distance from sample point to edge (along normal)
      const toMidX = x - midX;
      const toMidY = y - midY;
      const edgeDist = Math.abs(toMidX * normX + toMidY * normY);

      minEdgeDist = Math.min(minEdgeDist, edgeDist);
    }
  }

  return minEdgeDist;
}

export interface VoronoiTextureConfig {
  width: number;
  height: number;
  scale: number;
  mode: VoronoiMode;
  detail?: number;      // Adds sub-cell variation (0-1)
  randomness?: number;  // Cell point randomness (0-1)
  seed?: number;
  invert?: boolean;
}

/**
 * Generate voronoi texture as ImageData
 */
export function generateVoronoiTexture(config: VoronoiTextureConfig): ImageData {
  const {
    width,
    height,
    scale,
    mode,
    detail = 0,
    randomness = 1.0,
    seed = 0,
    invert = false,
  } = config;

  const imageData = new ImageData(width, height);
  const data = imageData.data;

  // Track min/max for normalization
  let minValue = Infinity;
  let maxValue = -Infinity;
  const values = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x / width) * scale;
      const ny = (y / height) * scale;

      let value: number;

      if (mode === 'distanceToEdge') {
        value = voronoiEdgeDistance(nx, ny, randomness, seed);
      } else {
        const result = voronoiAt(nx, ny, randomness, seed);
        value = mode === 'F1' ? result.f1 : result.f2;
      }

      // Add detail variation if specified
      if (detail > 0) {
        const subResult = voronoiAt(nx * 3, ny * 3, randomness, seed + 100);
        value += subResult.f1 * detail * 0.1;
      }

      values[y * width + x] = value;
      minValue = Math.min(minValue, value);
      maxValue = Math.max(maxValue, value);
    }
  }

  // Normalize to 0-255
  const range = maxValue - minValue || 1;

  for (let i = 0; i < values.length; i++) {
    let normalized = (values[i] - minValue) / range;
    if (invert) normalized = 1 - normalized;
    const value = Math.floor(normalized * 255);

    const idx = i * 4;
    data[idx] = value;
    data[idx + 1] = value;
    data[idx + 2] = value;
    data[idx + 3] = 255;
  }

  return imageData;
}

/**
 * Generate voronoi as canvas
 */
export function generateVoronoiCanvas(config: VoronoiTextureConfig): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = config.width;
  canvas.height = config.height;
  const ctx = canvas.getContext("2d")!;

  const imageData = generateVoronoiTexture(config);
  ctx.putImageData(imageData, 0, 0);

  return canvas;
}

/**
 * Sample voronoi at UV coordinate
 * Returns normalized value [0, 1]
 */
export function sampleVoronoi(
  u: number,
  v: number,
  scale: number,
  mode: VoronoiMode,
  randomness: number = 1.0
): number {
  const x = u * scale;
  const y = v * scale;

  if (mode === 'distanceToEdge') {
    // Normalize edge distance (typical range 0-0.5)
    return Math.min(1, voronoiEdgeDistance(x, y, randomness) * 2);
  }

  const result = voronoiAt(x, y, randomness);
  const value = mode === 'F1' ? result.f1 : result.f2;
  // Normalize F1/F2 (typical range 0-1)
  return Math.min(1, value);
}
