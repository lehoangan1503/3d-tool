/**
 * PROCEDURAL LEATHER BUMP COMBINER
 * Combines all leather texture layers into final normal map
 * Based on Blender's realistic leather shader with dual-scale bump
 * 
 * Layer combination (like Blender's chained bump nodes):
 * - Grain (macro) + EdgeCracks (multiply) + GrainVariation (overlay) 
 * - Then add FineSurface (add) + LargeCreases (overlay)
 * - Convert combined heightmap to normal map with dual-bump technique
 */

import { combineBumpMaps, heightToNormalMap, imageDataToCanvas, blendTextures } from "./blend";
import { generateAllLeatherLayers, AllLeatherLayersConfig, LeatherLayers } from "./leather-layers";

export interface LeatherBumpConfig extends AllLeatherLayersConfig {
  // Bump strengths (based on Blender settings in setting.md)
  grainBumpStrength?: number;          // Primary grain (default 0.5)
  edgeCracksBumpStrength?: number;     // Edge definition (default 0.3)
  grainVariationBumpStrength?: number; // Size variation (default 0.3)
  fineSurfaceBumpStrength?: number;    // Micro-texture (default 0.15)
  largeCreasesBumpStrength?: number;   // Large wrinkles (default 0.25)
  
  // Legacy bump strengths (backward compatibility)
  cracksBumpStrength?: number;   // Maps to edgeCracksBumpStrength
  dotsBumpStrength?: number;     // Maps to fineSurfaceBumpStrength
  surfaceBumpStrength?: number;  // Maps to grainVariationBumpStrength
  
  // Normal map output strength
  normalStrength?: number;       // Default 1.0
  
  // Dual-scale bump technique
  useDualBump?: boolean;         // Enable layered detail (default true)
  macroBumpStrength?: number;    // Macro detail strength (default 0.6)
  microBumpStrength?: number;    // Micro detail strength (default 0.2)
}

export interface LeatherBumpResult {
  // Individual layers (for debugging/preview)
  layers: LeatherLayers;
  
  // Combined outputs
  combinedHeightMap: ImageData;
  combinedHeightCanvas: HTMLCanvasElement;
  
  // Final normal map
  normalMap: ImageData;
  normalMapCanvas: HTMLCanvasElement;
}

/**
 * Generate combined leather bump/normal map from all layers
 * 
 * Process (matches Blender realistic leather shader):
 * 1. Generate grain, edge cracks, grain variation, fine surface, large creases
 * 2. Combine with individual strengths (like chained bump nodes)
 *    - Grain + EdgeCracks (multiply) creates main structure
 *    - GrainVariation (overlay) adds size irregularity
 *    - FineSurface (add) adds micro detail
 *    - LargeCreases (overlay) adds macro wrinkles
 * 3. Convert combined heightmap to normal map
 * 4. Optional dual-scale bump for maximum realism
 */
export function generateLeatherBumpMap(config: LeatherBumpConfig): LeatherBumpResult {
  const {
    width,
    height,
    // New layer strengths (based on setting.md specs)
    grainBumpStrength = 0.5,
    edgeCracksBumpStrength,
    grainVariationBumpStrength,
    fineSurfaceBumpStrength,
    largeCreasesBumpStrength = 0.25,
    // Legacy strengths (backward compatibility)
    cracksBumpStrength = 0.3,
    dotsBumpStrength = 0.15,
    surfaceBumpStrength = 0.3,
    // Output settings
    normalStrength = 1.0,
    useDualBump = true,
    macroBumpStrength = 0.6,
    microBumpStrength = 0.2,
    ...layerConfig
  } = config;

  // Map legacy names to new names
  const edgeStrength = edgeCracksBumpStrength ?? cracksBumpStrength;
  const fineStrength = fineSurfaceBumpStrength ?? dotsBumpStrength;
  const variationStrength = grainVariationBumpStrength ?? surfaceBumpStrength;

  console.log("[LeatherBump] Generating realistic leather bump map:", {
    width,
    height,
    grainBumpStrength,
    edgeStrength,
    variationStrength,
    fineStrength,
    largeCreasesBumpStrength,
    normalStrength,
    useDualBump,
  });

  const startTime = performance.now();

  // Generate all texture layers
  const layers = generateAllLeatherLayers({
    width,
    height,
    ...layerConfig,
  });

  let combinedHeightMap: ImageData;

  if (useDualBump) {
    // DUAL-SCALE BUMP TECHNIQUE (setting.md: Advanced Technique)
    // Bump 1 (Macro detail - grain pattern): Strength 0.6
    // Bump 2 (Micro detail - fine texture): Strength 0.2
    
    // Macro layers: grain + edge cracks + large creases
    const macroHeightMap = combineBumpMaps([
      { data: layers.grain, strength: grainBumpStrength * macroBumpStrength, invert: false },
      { data: layers.edgeCracks, strength: edgeStrength * macroBumpStrength, invert: true }, // Invert for grooves
      { data: layers.grainVariation, strength: variationStrength * macroBumpStrength, invert: false },
      { data: layers.largeCreases, strength: largeCreasesBumpStrength * macroBumpStrength, invert: false },
    ]);
    
    // Micro layers: fine surface detail
    const microHeightMap = combineBumpMaps([
      { data: layers.fineSurface, strength: fineStrength * microBumpStrength, invert: false },
    ]);
    
    // Combine macro and micro (add blend)
    combinedHeightMap = blendTextures({
      baseData: macroHeightMap,
      blendData: microHeightMap,
      factor: 0.5,
      mode: 'add',
    });
  } else {
    // Single bump approach (simpler, faster)
    combinedHeightMap = combineBumpMaps([
      { data: layers.grain, strength: grainBumpStrength, invert: false },
      { data: layers.edgeCracks, strength: edgeStrength, invert: true }, // Invert for grooves
      { data: layers.grainVariation, strength: variationStrength, invert: false },
      { data: layers.fineSurface, strength: fineStrength, invert: false },
      { data: layers.largeCreases, strength: largeCreasesBumpStrength, invert: false },
    ]);
  }

  // Convert combined heightmap to normal map
  const normalMap = heightToNormalMap(combinedHeightMap, normalStrength);

  const elapsed = performance.now() - startTime;
  console.log(`[LeatherBump] ✅ Complete in ${elapsed.toFixed(0)}ms`);

  return {
    layers,
    combinedHeightMap,
    combinedHeightCanvas: imageDataToCanvas(combinedHeightMap),
    normalMap,
    normalMapCanvas: imageDataToCanvas(normalMap),
  };
}

/**
 * Quick generate just the normal map canvas (most common use case)
 */
export function generateLeatherNormalCanvas(config: LeatherBumpConfig): HTMLCanvasElement {
  const result = generateLeatherBumpMap(config);
  return result.normalMapCanvas;
}

// =====================================================
// PRESET CONFIGURATIONS (updated for realistic leather)
// Based on Blender shader settings from setting.md
// =====================================================

export interface LeatherPresetConfig {
  name: string;
  description: string;
  config: Partial<LeatherBumpConfig>;
}

export const LEATHER_BUMP_PRESETS: Record<string, LeatherPresetConfig> = {
  // Pebbled cowhide - large puffy grain cells (DEFAULT - matches reference image)
  pebbled: {
    name: "Pebbled Cowhide",
    description: "Large puffy grain cells like real pebbled leather",
    config: {
      globalScale: 1,
      // Large grain cells (lower scale = bigger cells)
      grainScale: 20,
      grainBlackPoint: 0.25,    // Soft edges
      grainWhitePoint: 0.75,    // Wide gradient for rounded bumps
      grainBumpStrength: 0.8,   // Strong bumps
      // Edge definition
      edgeCracksScale: 20,
      edgeWidth: 0.12,          // Soft wrinkle lines
      edgeCracksBumpStrength: 0.35,
      // Size variation for natural randomness
      grainVariationScale: 6,   // Very large variation
      grainVariationBumpStrength: 0.6,
      // Subtle surface texture
      fineSurfaceScale: 150,
      fineSurfaceDetail: 5,
      fineSurfaceBumpStrength: 0.08,
      // Large creases
      largeCreasesScale: 2,
      largeCreasesDetail: 2,
      largeCreasesBumpStrength: 0.25,
      // Strong dual bump
      normalStrength: 1.3,
      useDualBump: true,
      macroBumpStrength: 0.85,
      microBumpStrength: 0.1,
    },
  },
  
  // Realistic cowhide - medium grain
  realistic: {
    name: "Realistic Cowhide",
    description: "Premium cowhide with visible grain cells and natural variation",
    config: {
      globalScale: 1,
      grainScale: 30,
      grainBlackPoint: 0.3,
      grainWhitePoint: 0.7,
      grainBumpStrength: 0.65,
      edgeCracksScale: 30,
      edgeWidth: 0.1,
      edgeCracksBumpStrength: 0.3,
      grainVariationScale: 10,
      grainVariationBumpStrength: 0.45,
      fineSurfaceScale: 200,
      fineSurfaceDetail: 6,
      fineSurfaceBumpStrength: 0.12,
      largeCreasesScale: 4,
      largeCreasesDetail: 2,
      largeCreasesBumpStrength: 0.2,
      normalStrength: 1.1,
      useDualBump: true,
      macroBumpStrength: 0.7,
      microBumpStrength: 0.15,
    },
  },

  // Fine grain (like smooth calfskin)
  fineGrain: {
    name: "Fine Calfskin",
    description: "Smooth leather with subtle fine grain, minimal cracks",
    config: {
      globalScale: 1,
      grainScale: 50,           // Smaller grain
      grainBlackPoint: 0.35,
      grainWhitePoint: 0.65,
      grainBumpStrength: 0.4,
      edgeCracksScale: 50,
      edgeWidth: 0.06,
      edgeCracksBumpStrength: 0.2,
      grainVariationScale: 20,
      grainVariationBumpStrength: 0.25,
      fineSurfaceScale: 300,
      fineSurfaceDetail: 8,
      fineSurfaceBumpStrength: 0.15,
      largeCreasesScale: 6,
      largeCreasesDetail: 3,
      largeCreasesBumpStrength: 0.15,
      normalStrength: 0.9,
      useDualBump: true,
      macroBumpStrength: 0.5,
      microBumpStrength: 0.2,
    },
  },

  // Distressed/aged leather
  distressed: {
    name: "Distressed",
    description: "Aged leather with prominent cracks and wear marks",
    config: {
      globalScale: 1,
      grainScale: 25,
      grainBlackPoint: 0.2,
      grainWhitePoint: 0.8,
      grainBumpStrength: 0.75,
      edgeCracksScale: 25,
      edgeWidth: 0.18,          // Deep cracks
      edgeCracksBumpStrength: 0.5,
      grainVariationScale: 8,
      grainVariationBumpStrength: 0.55,
      fineSurfaceScale: 180,
      fineSurfaceDetail: 5,
      fineSurfaceBumpStrength: 0.1,
      largeCreasesScale: 2,
      largeCreasesDetail: 2,
      largeCreasesBumpStrength: 0.4,
      normalStrength: 1.4,
      useDualBump: true,
      macroBumpStrength: 0.9,
      microBumpStrength: 0.1,
    },
  },

  // Crocodile/exotic pattern
  crocodile: {
    name: "Crocodile",
    description: "Bold scales with deep grooves and distinctive pattern",
    config: {
      globalScale: 1,
      grainScale: 15,           // Very large scales
      grainBlackPoint: 0.2,
      grainWhitePoint: 0.6,
      grainBumpStrength: 0.9,
      edgeCracksScale: 15,
      edgeWidth: 0.2,           // Deep scale edges
      edgeCracksBumpStrength: 0.6,
      grainVariationScale: 5,
      grainVariationBumpStrength: 0.3,
      fineSurfaceScale: 250,
      fineSurfaceDetail: 5,
      fineSurfaceBumpStrength: 0.06,
      largeCreasesScale: 3,
      largeCreasesDetail: 2,
      largeCreasesBumpStrength: 0.15,
      normalStrength: 1.5,
      useDualBump: true,
      macroBumpStrength: 0.9,
      microBumpStrength: 0.08,
    },
  },

  // Matte/unfinished leather
  matteLeather: {
    name: "Matte Unfinished",
    description: "Unfinished matte leather with natural texture",
    config: {
      globalScale: 1,
      grainScale: 28,
      grainBlackPoint: 0.28,
      grainWhitePoint: 0.72,
      grainBumpStrength: 0.6,
      edgeCracksScale: 28,
      edgeWidth: 0.1,
      edgeCracksBumpStrength: 0.35,
      grainVariationScale: 10,
      grainVariationBumpStrength: 0.4,
      fineSurfaceScale: 220,
      fineSurfaceDetail: 7,
      fineSurfaceBumpStrength: 0.14,
      largeCreasesScale: 4,
      largeCreasesDetail: 2,
      largeCreasesBumpStrength: 0.25,
      normalStrength: 1.15,
      useDualBump: true,
      macroBumpStrength: 0.7,
      microBumpStrength: 0.15,
    },
  },

  // Polished/finished leather
  polishedLeather: {
    name: "Polished Finished",
    description: "High-quality polished leather with refined grain",
    config: {
      globalScale: 1,
      grainScale: 40,
      grainBlackPoint: 0.38,
      grainWhitePoint: 0.62,
      grainBumpStrength: 0.45,
      edgeCracksScale: 40,
      edgeWidth: 0.06,
      edgeCracksBumpStrength: 0.2,
      grainVariationScale: 15,
      grainVariationBumpStrength: 0.3,
      fineSurfaceScale: 350,
      fineSurfaceDetail: 9,
      fineSurfaceBumpStrength: 0.1,
      largeCreasesScale: 6,
      largeCreasesDetail: 3,
      largeCreasesBumpStrength: 0.12,
      normalStrength: 0.8,
      useDualBump: true,
      macroBumpStrength: 0.55,
      microBumpStrength: 0.2,
    },
  },
};

/**
 * Generate leather bump map from preset name
 */
export function generateFromPreset(
  presetName: string,
  width: number,
  height: number,
  overrides?: Partial<LeatherBumpConfig>
): LeatherBumpResult {
  const preset = LEATHER_BUMP_PRESETS[presetName] || LEATHER_BUMP_PRESETS.realistic;
  
  return generateLeatherBumpMap({
    width,
    height,
    ...preset.config,
    ...overrides,
  });
}
