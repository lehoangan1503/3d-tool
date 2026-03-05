/**
 * PROCEDURAL MODULE INDEX
 * Exports all procedural texture generation utilities
 */

// Core generators
export { 
  simplex2D, 
  fbmNoise, 
  generateNoiseTexture, 
  generateNoiseCanvas,
  sampleNoise,
  type NoiseTextureConfig 
} from "./noise";

export { 
  voronoiAt, 
  voronoiEdgeDistance,
  generateVoronoiTexture, 
  generateVoronoiCanvas,
  sampleVoronoi,
  type VoronoiMode,
  type VoronoiResult,
  type VoronoiTextureConfig 
} from "./voronoi";

// Blending utilities
export {
  linearLight,
  mix,
  colorRamp,
  blendTextures,
  applyColorRamp,
  invertTexture,
  heightToNormalMap,
  combineBumpMaps,
  imageDataToCanvas,
  canvasToImageData,
  type BlendTextureConfig
} from "./blend";

// Leather-specific layers (realistic leather based on Blender shader)
export {
  // New realistic leather layers
  generateGrainLayer,
  generateEdgeCracksLayer,
  generateGrainVariationLayer,
  generateFineSurfaceLayer,
  generateLargeCreasesLayer,
  // Legacy layers (backward compatibility)
  generateCracksLayer,
  generateDotsLayer,
  generateSurfaceLayer,
  generateAllLeatherLayers,
  // Types
  type GrainLayerConfig,
  type EdgeCracksLayerConfig,
  type GrainVariationLayerConfig,
  type FineSurfaceLayerConfig,
  type LargeCreasesLayerConfig,
  type CracksLayerConfig,
  type DotsLayerConfig,
  type SurfaceLayerConfig,
  type AllLeatherLayersConfig,
  type LeatherLayers
} from "./leather-layers";

// Leather bump/normal map generation
export {
  generateLeatherBumpMap,
  generateLeatherNormalCanvas,
  generateFromPreset,
  LEATHER_BUMP_PRESETS,
  type LeatherBumpConfig,
  type LeatherBumpResult,
  type LeatherPresetConfig
} from "./leather-bump";
