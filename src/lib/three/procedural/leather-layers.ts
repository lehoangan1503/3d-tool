/**
 * PROCEDURAL LEATHER TEXTURE LAYERS
 * Generates realistic leather texture layers based on Blender shader techniques:
 * 1. Grain - primary polygonal grain pattern (Voronoi F1, sharp edges, scale 80-120)
 * 2. EdgeCracks - cell edge definition / wrinkle lines (Voronoi edge distance, scale 80-120)
 * 3. GrainVariation - grain size variation (larger Voronoi scale 30-50)
 * 4. FineSurface - fine micro-texture within each grain cell (Noise, scale 400-600)
 * 5. LargeCreases - large wrinkles/creases (Noise, scale 3-8, high distortion)
 */

import { generateNoiseTexture, sampleNoise } from "./noise";
import { generateVoronoiTexture, VoronoiTextureConfig } from "./voronoi";
import { blendTextures, applyColorRamp, invertTexture, imageDataToCanvas } from "./blend";

export interface LeatherLayerConfig {
  width: number;
  height: number;
  globalScale?: number;  // Multiplier for all scales
}

// =====================================================
// 1. PRIMARY GRAIN PATTERN LAYER
// Creates main polygonal cells (like cowhide leather)
// Blender: Voronoi (F1, scale 80-120) → ColorRamp (sharp edges: black 0.45, white 0.55)
// =====================================================

export interface GrainLayerConfig extends LeatherLayerConfig {
  scale?: number;           // Voronoi scale (default 100)
  randomness?: number;      // Cell randomness (default 1.0)
  blackPoint?: number;      // ColorRamp black position (default 0.45)
  whitePoint?: number;      // ColorRamp white position (default 0.55)
  seed?: number;
}

export function generateGrainLayer(config: GrainLayerConfig): ImageData {
  const {
    width,
    height,
    globalScale = 1,
    scale = 20,          // Lower scale = bigger cells
    randomness = 1.0,
    blackPoint = 0.3,    // Softer edges for rounded bumps
    whitePoint = 0.7,
    seed = 0,
  } = config;

  const finalScale = scale * globalScale;

  // Generate voronoi F1 for main grain cells
  const voronoiData = generateVoronoiTexture({
    width,
    height,
    scale: finalScale,
    mode: 'F1',
    randomness,
    seed,
  });

  // Apply softer color ramp for rounded, puffy bumps (not sharp edges)
  // Wider range creates smoother gradients = rounder looking grain
  const contrastedData = applyColorRamp(voronoiData, blackPoint, whitePoint);
  
  // Invert so cells bulge outward (bumps, not depressions)
  const invertedData = invertTexture(contrastedData);

  console.log("[GrainLayer] Generated:", { width, height, scale: finalScale, blackPoint, whitePoint });

  return invertedData;
}

// =====================================================
// 2. CELL EDGE DEFINITION / WRINKLE LINES LAYER
// Creates wrinkle lines between grain polygons
// Blender: Voronoi (Edge Distance, scale 80-120) → ColorRamp (thin edges: 0.0 to 0.05)
// =====================================================

export interface EdgeCracksLayerConfig extends LeatherLayerConfig {
  scale?: number;           // Voronoi scale (default 100)
  randomness?: number;      // Cell randomness (default 1.0)
  edgeWidth?: number;       // Edge width (ColorRamp white point, default 0.05)
  seed?: number;
}

export function generateEdgeCracksLayer(config: EdgeCracksLayerConfig): ImageData {
  const {
    width,
    height,
    globalScale = 1,
    scale = 100,
    randomness = 1.0,
    edgeWidth = 0.05,
    seed = 0,
  } = config;

  const finalScale = scale * globalScale;

  // Generate voronoi with distance-to-edge for cracks
  const voronoiData = generateVoronoiTexture({
    width,
    height,
    scale: finalScale,
    mode: 'distanceToEdge',
    randomness,
    seed,
  });

  // Apply color ramp for thin, crisp edges (0.0 to 0.05)
  const contrastedData = applyColorRamp(voronoiData, 0, edgeWidth);

  console.log("[EdgeCracksLayer] Generated:", { width, height, scale: finalScale, edgeWidth });

  return contrastedData;
}

// =====================================================
// 3. GRAIN SIZE VARIATION LAYER
// Creates size variation in natural leather grains
// Blender: Voronoi (F1, scale 30-50) → ColorRamp → Mix (0.3-0.4)
// =====================================================

export interface GrainVariationLayerConfig extends LeatherLayerConfig {
  scale?: number;           // Voronoi scale (default 40 = larger cells)
  randomness?: number;      // Cell randomness (default 1.0)
  seed?: number;
}

export function generateGrainVariationLayer(config: GrainVariationLayerConfig): ImageData {
  const {
    width,
    height,
    globalScale = 1,
    scale = 40,
    randomness = 1.0,
    seed = 0,
  } = config;

  const finalScale = scale * globalScale;

  // Generate larger voronoi cells for variation
  const voronoiData = generateVoronoiTexture({
    width,
    height,
    scale: finalScale,
    mode: 'F1',
    randomness,
    seed: seed + 300,
  });

  // Apply color ramp for contrast
  const contrastedData = applyColorRamp(voronoiData, 0.2, 0.8);

  console.log("[GrainVariationLayer] Generated:", { width, height, scale: finalScale });

  return contrastedData;
}

// =====================================================
// 4. FINE SURFACE TEXTURE LAYER
// Subtle micro-texture within each grain cell
// Blender: Noise (scale 400-600, detail 8-10, roughness 0.6, distortion 0.5)
// =====================================================

export interface FineSurfaceLayerConfig extends LeatherLayerConfig {
  scale?: number;           // Noise scale (default 500)
  detail?: number;          // Noise detail (default 8)
  roughness?: number;       // Noise roughness (default 0.6)
  seed?: number;
}

export function generateFineSurfaceLayer(config: FineSurfaceLayerConfig): ImageData {
  const {
    width,
    height,
    globalScale = 1,
    scale = 500,
    detail = 8,
    roughness = 0.6,
    seed = 0,
  } = config;

  const finalScale = scale * globalScale;

  // Generate fine noise texture
  const noiseData = generateNoiseTexture({
    width,
    height,
    scale: finalScale,
    detail,
    seed: seed + 400,
  });

  console.log("[FineSurfaceLayer] Generated:", { width, height, scale: finalScale, detail });

  return noiseData;
}

// =====================================================
// 5. LARGE WRINKLES/CREASES LAYER
// Large scale wrinkles and creases on leather
// Blender: Noise (scale 3-8, detail 2-3, roughness 0.7, distortion 2.0)
// =====================================================

export interface LargeCreasesLayerConfig extends LeatherLayerConfig {
  scale?: number;           // Noise scale (default 5)
  detail?: number;          // Noise detail (default 2)
  roughness?: number;       // Noise roughness (default 0.7)
  seed?: number;
}

export function generateLargeCreasesLayer(config: LargeCreasesLayerConfig): ImageData {
  const {
    width,
    height,
    globalScale = 1,
    scale = 5,
    detail = 2,
    roughness = 0.7,
    seed = 0,
  } = config;

  // Large creases don't scale with globalScale (they're macro features)
  const finalScale = scale;

  // Generate large-scale noise texture
  const noiseData = generateNoiseTexture({
    width,
    height,
    scale: finalScale,
    detail,
    seed: seed + 500,
  });

  console.log("[LargeCreasesLayer] Generated:", { width, height, scale: finalScale, detail });

  return noiseData;
}

// =====================================================
// LEGACY LAYERS (kept for backward compatibility)
// =====================================================

export interface CracksLayerConfig extends LeatherLayerConfig {
  scale?: number;
  distortion?: number;
  noiseScale?: number;
  noiseDetail?: number;
  contrast?: number;
  seed?: number;
}

export function generateCracksLayer(config: CracksLayerConfig): ImageData {
  // Redirect to new EdgeCracksLayer
  return generateEdgeCracksLayer({
    width: config.width,
    height: config.height,
    globalScale: config.globalScale,
    scale: config.scale || 100,
    edgeWidth: config.contrast ? 1 - config.contrast : 0.05,
    seed: config.seed,
  });
}

export interface DotsLayerConfig extends LeatherLayerConfig {
  scale?: number;
  detail?: number;
  seed?: number;
}

export function generateDotsLayer(config: DotsLayerConfig): ImageData {
  // Redirect to FineSurfaceLayer (fine grain)
  const result = generateFineSurfaceLayer({
    width: config.width,
    height: config.height,
    globalScale: config.globalScale,
    scale: config.scale || 500,
    detail: 8,
    seed: config.seed,
  });
  // Invert for consistency with old behavior
  return invertTexture(result);
}

export interface SurfaceLayerConfig extends LeatherLayerConfig {
  scale?: number;
  distortion?: number;
  noiseScale?: number;
  blackPoint?: number;
  whitePoint?: number;
  seed?: number;
}

export function generateSurfaceLayer(config: SurfaceLayerConfig): ImageData {
  // Redirect to GrainVariationLayer
  const result = generateGrainVariationLayer({
    width: config.width,
    height: config.height,
    globalScale: config.globalScale,
    scale: config.scale ? config.scale / 5 : 40,
    seed: config.seed,
  });
  // Invert for consistency with old behavior
  return invertTexture(result);
}

// =====================================================
// ALL LAYERS COMBINED - NEW REALISTIC LEATHER
// =====================================================

export interface AllLeatherLayersConfig extends LeatherLayerConfig {
  // Primary grain pattern (Voronoi F1, scale 80-120)
  grainScale?: number;
  grainBlackPoint?: number;
  grainWhitePoint?: number;
  
  // Edge cracks / wrinkle lines (Voronoi edge distance)
  edgeCracksScale?: number;
  edgeWidth?: number;
  
  // Grain size variation (larger Voronoi, scale 30-50)
  grainVariationScale?: number;
  
  // Fine surface texture (Noise, scale 400-600)
  fineSurfaceScale?: number;
  fineSurfaceDetail?: number;
  
  // Large creases (Noise, scale 3-8)
  largeCreasesScale?: number;
  largeCreasesDetail?: number;
  
  // Legacy compatibility
  cracksScale?: number;
  cracksDistortion?: number;
  dotsScale?: number;
  dotsDetail?: number;
  surfaceScale?: number;
  surfaceDistortion?: number;
  noiseScale?: number;
  noiseDetail?: number;
  seed?: number;
}

export interface LeatherLayers {
  // New layers
  grain: ImageData;
  edgeCracks: ImageData;
  grainVariation: ImageData;
  fineSurface: ImageData;
  largeCreases: ImageData;
  grainCanvas: HTMLCanvasElement;
  edgeCracksCanvas: HTMLCanvasElement;
  grainVariationCanvas: HTMLCanvasElement;
  fineSurfaceCanvas: HTMLCanvasElement;
  largeCreasesCanvas: HTMLCanvasElement;
  
  // Legacy layers (for backward compatibility)
  cracks: ImageData;
  dots: ImageData;
  surface: ImageData;
  cracksCanvas: HTMLCanvasElement;
  dotsCanvas: HTMLCanvasElement;
  surfaceCanvas: HTMLCanvasElement;
}

/**
 * Generate all leather texture layers (realistic version)
 * Based on Blender leather shader settings from setting.md
 */
export function generateAllLeatherLayers(config: AllLeatherLayersConfig): LeatherLayers {
  const {
    width,
    height,
    globalScale = 1,
    // New layer configs
    grainScale = 100,
    grainBlackPoint = 0.45,
    grainWhitePoint = 0.55,
    edgeCracksScale = 100,
    edgeWidth = 0.05,
    grainVariationScale = 40,
    fineSurfaceScale = 500,
    fineSurfaceDetail = 8,
    largeCreasesScale = 5,
    largeCreasesDetail = 2,
    // Legacy configs (for backward compatibility)
    cracksScale,
    dotsScale,
    surfaceScale,
    seed = 0,
  } = config;

  console.log("[LeatherLayers] Generating realistic leather layers:", { width, height, globalScale });
  const startTime = performance.now();

  // 1. Primary grain pattern
  const grain = generateGrainLayer({
    width,
    height,
    globalScale,
    scale: grainScale,
    blackPoint: grainBlackPoint,
    whitePoint: grainWhitePoint,
    seed,
  });

  // 2. Edge cracks / wrinkle lines (use same scale as grain for alignment)
  const edgeCracks = generateEdgeCracksLayer({
    width,
    height,
    globalScale,
    scale: cracksScale || edgeCracksScale,
    edgeWidth,
    seed,
  });

  // 3. Grain size variation
  const grainVariation = generateGrainVariationLayer({
    width,
    height,
    globalScale,
    scale: grainVariationScale,
    seed,
  });

  // 4. Fine surface texture
  const fineSurface = generateFineSurfaceLayer({
    width,
    height,
    globalScale,
    scale: dotsScale || fineSurfaceScale,
    detail: fineSurfaceDetail,
    seed,
  });

  // 5. Large wrinkles/creases
  const largeCreases = generateLargeCreasesLayer({
    width,
    height,
    globalScale,
    scale: largeCreasesScale,
    detail: largeCreasesDetail,
    seed,
  });

  const elapsed = performance.now() - startTime;
  console.log(`[LeatherLayers] ✅ All layers generated in ${elapsed.toFixed(0)}ms`);

  return {
    // New layers
    grain,
    edgeCracks,
    grainVariation,
    fineSurface,
    largeCreases,
    grainCanvas: imageDataToCanvas(grain),
    edgeCracksCanvas: imageDataToCanvas(edgeCracks),
    grainVariationCanvas: imageDataToCanvas(grainVariation),
    fineSurfaceCanvas: imageDataToCanvas(fineSurface),
    largeCreasesCanvas: imageDataToCanvas(largeCreases),
    
    // Legacy layers (map to new layers for backward compatibility)
    cracks: edgeCracks,
    dots: fineSurface,
    surface: grainVariation,
    cracksCanvas: imageDataToCanvas(edgeCracks),
    dotsCanvas: imageDataToCanvas(fineSurface),
    surfaceCanvas: imageDataToCanvas(grainVariation),
  };
}
