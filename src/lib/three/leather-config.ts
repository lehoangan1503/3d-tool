/**
 * LEATHER & MATERIAL CONFIGURATION
 * Configures leather textures, colors, and material properties
 */

// =====================================================
// TYPES
// =====================================================

export interface LeatherPreset {
  name: string;
  normalScaleX: number;
  normalScaleY: number;
  normalStrength: number;
  textureScaleX: number;
  textureScaleY: number;
  roughness: number;
  clearcoat: number;
  sheen: number;
}

// Procedural leather texture configuration (based on Blender realistic leather shader)
export interface ProceduralLeatherConfig {
  enabled: boolean;           // Use procedural textures instead of static normal maps
  
  // Global scale multiplier
  globalScale: number;
  
  // Primary grain pattern (Voronoi F1, scale 80-120)
  grainScale: number;
  grainBlackPoint: number;    // ColorRamp black point (default 0.45)
  grainWhitePoint: number;    // ColorRamp white point (default 0.55)
  grainBumpStrength: number;  // Bump strength (default 0.5)
  
  // Edge cracks / wrinkle lines (Voronoi edge distance)
  edgeCracksScale: number;    // Same as grain scale for alignment
  edgeWidth: number;          // Edge width 0.03-0.08 (default 0.05)
  edgeCracksBumpStrength: number; // Bump strength (default 0.3)
  
  // Grain size variation (Voronoi F1, scale 30-50)
  grainVariationScale: number;
  grainVariationBumpStrength: number; // Bump strength (default 0.3)
  
  // Fine surface texture (Noise, scale 400-600)
  fineSurfaceScale: number;
  fineSurfaceDetail: number;  // Detail 8-10
  fineSurfaceBumpStrength: number; // Bump strength (default 0.15)
  
  // Large wrinkles/creases (Noise, scale 3-8)
  largeCreasesScale: number;
  largeCreasesDetail: number; // Detail 2-3
  largeCreasesBumpStrength: number; // Bump strength (default 0.25)
  
  // Dual-scale bump technique (for maximum realism)
  useDualBump: boolean;
  macroBumpStrength: number;  // Macro detail strength (default 0.6)
  microBumpStrength: number;  // Micro detail strength (default 0.2)
  
  // Legacy layer configs (backward compatibility)
  cracksScale: number;
  cracksDistortion: number;
  cracksBumpStrength: number;
  dotsScale: number;
  dotsDetail: number;
  dotsBumpStrength: number;
  surfaceScale: number;
  surfaceDistortion: number;
  surfaceBumpStrength: number;
  
  // Shared noise settings
  noiseScale: number;
  noiseDetail: number;
  
  // Output settings
  textureResolution: number;
  normalStrength: number;
  
  // Preset name
  preset?: string;
}

export interface LeatherColorPalette {
  name: string;
  hex: string;
}

export interface LeatherTextureType {
  name: string;
  path: string;
}

export interface SurfaceType {
  name: string;
  path: string;
}

export interface NonLeatherConfig {
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  reflectivity: number;
  ior: number;
  thickness: number;
  specularIntensity: number;
}

export interface LogoConfig {
  enabled: boolean;
  path: string;
  scale: number;
  opacity: number;
  offsetX: number;
  offsetY: number;
  flipX: boolean;
  flipY: boolean;
  color: string;
  emboss: boolean;
  embossDepth: number;
  topSurfaceOnly?: boolean;
  topSurfaceUV?: {
    centerX: number;
    centerY: number;
    radius: number;
  };
}

export interface RubberConfigType {
  enabled: boolean;
  materialNames: string[];
  backgroundColor: string;
  roughness: number;
  clearcoat: number;
  metalness: number;
  reflectivity: number;
  normalScaleX: number;
  normalScaleY: number;
  logo: LogoConfig;
}

export interface TopCapConfigType {
  enabled: boolean;
  materialNames: string[];
  roughness: number;
  clearcoat: number;
  metalness: number;
  logo: LogoConfig;
}

export interface CylinderLeatherConfigType {
  enabled: boolean;
  materialNames: string[];
  roughness: number;
  clearcoat: number;
  metalness: number;
  color: string;
  normalScale: number;
  sheen: number;
  sheenColor: string;
}

export interface LeatherConfigType {
  activeColor: string;
  activeTexture: string;
  normalScaleX: number;
  normalScaleY: number;
  normalStrength: number;
  textureScaleX: number;
  textureScaleY: number;
  roughness: number;
  clearcoat: number;
  sheen: number;
  nonLeather: NonLeatherConfig;
  procedural: ProceduralLeatherConfig;  // New procedural texture config
}

// =====================================================
// PRESETS
// =====================================================

export const LEATHER_PRESETS: Record<number, LeatherPreset> = {
  1: {
    name: "Deep Crocodile",
    normalScaleX: 1,
    normalScaleY: 3.5,
    normalStrength: 3.0,
    textureScaleX: 0.6,
    textureScaleY: 0.6,
    roughness: 120, // Match working shopify code (was 245)
    clearcoat: 5,
    sheen: 80,
  },
};

export const ACTIVE_LEATHER_PRESET = 1;

// Get active preset values
const activePreset = LEATHER_PRESETS[ACTIVE_LEATHER_PRESET] || LEATHER_PRESETS[1];

// =====================================================
// PROCEDURAL LEATHER DEFAULTS (based on Blender realistic leather shader)
// Settings from setting.md for premium cowhide appearance
// =====================================================

export const DEFAULT_PROCEDURAL_CONFIG: ProceduralLeatherConfig = {
  enabled: true,  // Enable procedural textures by default
  
  // Global scale
  globalScale: 1.0,
  
  // Primary grain pattern - LARGE puffy cells like real pebbled leather
  // Lower scale = bigger cells (real leather has ~15-25 visible cells across width)
  grainScale: 20,             // Much lower for large pebbled grain (was 100)
  grainBlackPoint: 0.3,       // Softer edges for rounded bumps
  grainWhitePoint: 0.7,       // Wider range for softer gradients
  grainBumpStrength: 0.7,     // Strong bumps for puffy appearance
  
  // Edge cracks / wrinkle lines between grain cells  
  edgeCracksScale: 20,        // Match grain scale for alignment
  edgeWidth: 0.15,            // Wider, softer edges (was 0.05)
  edgeCracksBumpStrength: 0.4,
  
  // Grain size variation - adds natural irregularity to cell sizes
  grainVariationScale: 8,     // Very large variation cells (was 40)
  grainVariationBumpStrength: 0.5, // Strong variation
  
  // Fine surface texture (micro-texture within grain)
  fineSurfaceScale: 200,      // Lower for visible micro-texture (was 500)
  fineSurfaceDetail: 6,
  fineSurfaceBumpStrength: 0.1,
  
  // Large wrinkles/creases (macro features)
  largeCreasesScale: 3,       // Very large wrinkles
  largeCreasesDetail: 2,
  largeCreasesBumpStrength: 0.3,
  
  // Dual-scale bump for maximum realism
  useDualBump: true,
  macroBumpStrength: 0.8,     // Stronger macro (was 0.6)
  microBumpStrength: 0.15,
  
  // Legacy layer configs (backward compatibility)
  cracksScale: 20,
  cracksDistortion: 0.018,
  cracksBumpStrength: 0.4,
  dotsScale: 200,
  dotsDetail: 0.5,
  dotsBumpStrength: 0.1,
  surfaceScale: 8,
  surfaceDistortion: 0.07,
  surfaceBumpStrength: 0.5,
  
  // Shared noise settings
  noiseScale: 30,
  noiseDetail: 10,
  
  // Output settings
  textureResolution: 512,
  normalStrength: 1.2,        // Stronger normal for more visible bumps
  
  preset: 'pebbled',
};

// =====================================================
// SURFACE TYPES
// =====================================================

export const SURFACE_TYPES: Record<string, SurfaceType> = {
  leather: { name: "Leather", path: "/textures/surfaces/surface-leather.jpg" },
  leather1: { name: "Leather 1", path: "/textures/surfaces/surface-leather1.jpg" },
  leather6: { name: "Leather 6", path: "/textures/surfaces/surface-leather6.jpg" },
  leather9: { name: "Leather 9", path: "/textures/surfaces/surface-leather9.jpg" },
};

// =====================================================
// LEATHER CONFIG
// NOTE: Leather part is now a Cylinder object in the GLB model, not a Mesh.
// The leather texture/color/material configs below are commented out as they
// are no longer applied — the GLB model's baked-in Cylinder handles leather appearance.
// =====================================================

// // LEATHER TEXTURE TYPES
// export const LEATHER_TEXTURE_TYPES: Record<string, LeatherTextureType> = {
//   crocodile: {
//     name: "Crocodile",
//     path: "/textures/leathers/type1/leather-texture.webp",
//   },
//   cowhide: {
//     name: "Cowhide",
//     path: "/textures/leathers/type2/cowhide-normal.png",
//   },
//   snake: {
//     name: "Snake",
//     path: "/textures/leathers/type2/leather-texture.webp",
//   },
// };

// // LEATHER COLOR PALETTES
// export const LEATHER_COLOR_PALETTES: Record<string, LeatherColorPalette> = {
//   black: { name: "Black", hex: "#1A1A1A" },
//   chestnut: { name: "Chestnut", hex: "#954535" },
//   chocolate: { name: "Chocolate", hex: "#3D1C02" },
//   darkBrown: { name: "Dark Brown", hex: "#2C1608" },
//   whiskey: { name: "Whiskey", hex: "#B5651D" },
//   tan: { name: "Tan", hex: "#D2B48C" },
// };

// // LEATHER CONFIG (main config object)
// export const LEATHER_CONFIG: LeatherConfigType = {
//   activeColor: "black",
//   activeTexture: "crocodile",
//   normalScaleX: activePreset.normalScaleX,
//   normalScaleY: activePreset.normalScaleY,
//   normalStrength: activePreset.normalStrength,
//   textureScaleX: activePreset.textureScaleX,
//   textureScaleY: activePreset.textureScaleY,
//   roughness: activePreset.roughness,
//   clearcoat: activePreset.clearcoat,
//   sheen: activePreset.sheen,
//   nonLeather: {
//     roughness: 0.01,
//     clearcoat: 1.0,
//     clearcoatRoughness: 0.005,
//     reflectivity: 1.0,
//     ior: 1.52,
//     thickness: 1.5,
//     specularIntensity: 1.2,
//   },
//   procedural: DEFAULT_PROCEDURAL_CONFIG,
// };

// Stub exports to avoid breaking imports — provides default values
export const LEATHER_TEXTURE_TYPES: Record<string, LeatherTextureType> = {};
export const LEATHER_COLOR_PALETTES: Record<string, LeatherColorPalette> = {};
export const LEATHER_CONFIG: LeatherConfigType = {
  activeColor: "black",
  activeTexture: "crocodile",
  normalScaleX: activePreset.normalScaleX,
  normalScaleY: activePreset.normalScaleY,
  normalStrength: activePreset.normalStrength,
  textureScaleX: activePreset.textureScaleX,
  textureScaleY: activePreset.textureScaleY,
  roughness: activePreset.roughness,
  clearcoat: activePreset.clearcoat,
  sheen: activePreset.sheen,
  nonLeather: {
    roughness: 0.01,
    clearcoat: 1.0,
    clearcoatRoughness: 0.005,
    reflectivity: 1.0,
    ior: 1.52,
    thickness: 1.5,
    specularIntensity: 1.2,
  },
  procedural: DEFAULT_PROCEDURAL_CONFIG,
};

// =====================================================
// HELPER FUNCTIONS
// NOTE: Leather part is now a Cylinder object, not a Mesh.
// Leather helper functions are commented out as they are no longer used.
// =====================================================

// /**
//  * Get leather color hex from active color key
//  */
// export function getLeatherColorHex(colorKey: string): string {
//   return LEATHER_COLOR_PALETTES[colorKey]?.hex || "#1A1A1A";
// }

// /**
//  * Get leather texture path from active texture key
//  */
// export function getLeatherTexturePath(textureKey: string): string {
//   return LEATHER_TEXTURE_TYPES[textureKey]?.path || "";
// }

// Stub exports to avoid breaking imports
export function getLeatherColorHex(colorKey: string): string {
  return "#1A1A1A";
}

export function getLeatherTexturePath(textureKey: string): string {
  return "";
}

/**
 * Get surface path from surface key
 */
export function getSurfacePath(surfaceKey: string): string {
  return SURFACE_TYPES[surfaceKey]?.path || SURFACE_TYPES.leather6.path;
}

// =====================================================
// RUBBER CONFIG (Bumper at bottom)
// =====================================================

export const RUBBER_CONFIG: RubberConfigType = {
  enabled: true,
  materialNames: ["bumper_mat", "bumper", "rubber", "bottom", "butt_cap", "end_cap", "pad", "foot", "base", "Mat_Bumper"],
  backgroundColor: "#2a2a2a",
  roughness: 0.94,
  clearcoat: 0.01,
  metalness: 0,
  reflectivity: 0.025,
  normalScaleX: 0.78,
  normalScaleY: 0.78,
  logo: {
    enabled: true,
    path: "/logo.png",
    scale: 0.42,
    opacity: 1.0,
    offsetX: 0.25,
    offsetY: 0.25,
    flipX: false,
    flipY: true,
    color: "#4a4a4a", // Slightly brighter than background for visibility
    emboss: false,
    embossDepth: 0,
  },
};

// =====================================================
// TOP CAP CONFIG (Joint cover at top)
// =====================================================

export const TOP_CAP_CONFIG: TopCapConfigType = {
  enabled: true,
  materialNames: ["joint_mat", "joint", "jointcover", "joint_cover", "thread", "screw", "thread_cap", "top_cap", "ferrule", "connector", "adapter", "Mat_JointCover", "JointCover"],
  roughness: 255,
  clearcoat: 0,
  metalness: 1,
  logo: {
    enabled: true,
    path: "/logo.png",
    scale: 0.42, // Same as rubber bumper
    opacity: 1.0,
    offsetX: 0.25, // Same as rubber - moves to UV center (0.75, 0.75)
    offsetY: 0.25,
    flipX: false,
    flipY: true, // Same as rubber bumper
    color: "#4a4a4a", // Slightly brighter than background for visibility
    emboss: false,
    embossDepth: 0,
    topSurfaceOnly: false,
    topSurfaceUV: {
      centerX: 0.75,
      centerY: 0.75,
      radius: 0.4,
    },
  },
};

// =====================================================
// CYLINDER LEATHER CONFIG (Leather wrap body)
// =====================================================

export const CYLINDER_LEATHER_CONFIG: CylinderLeatherConfigType = {
  enabled: true,
  materialNames: ["cylinder", "wrap"],
  roughness: 102,
  clearcoat: 10,
  metalness: 0,
  color: "#1A1A1A",
  normalScale: 1.0,
  sheen: 0,
  sheenColor: "#FFFFFF",
};

// =====================================================
// MATERIAL DETECTION HELPERS
// =====================================================

/**
 * Check if material/mesh is rubber (bumper)
 */
export function isRubberMaterial(materialName: string, meshName = ""): boolean {
  if (!RUBBER_CONFIG.enabled) return false;

  const nameLower = (materialName || "").toLowerCase();
  const meshLower = (meshName || "").toLowerCase();

  return RUBBER_CONFIG.materialNames.some((keyword) => {
    const keyLower = keyword.toLowerCase();
    return nameLower.includes(keyLower) || meshLower.includes(keyLower);
  });
}

/**
 * Check if material/mesh is top cap (joint cover)
 */
export function isTopCapMaterial(materialName: string, meshName = ""): boolean {
  if (!TOP_CAP_CONFIG.enabled) return false;

  const nameLower = (materialName || "").toLowerCase();
  const meshLower = (meshName || "").toLowerCase();

  return TOP_CAP_CONFIG.materialNames.some((keyword) => {
    const keyLower = keyword.toLowerCase();
    return nameLower.includes(keyLower) || meshLower.includes(keyLower);
  });
}

/**
 * Check if material is specifically the top cap FACE (the flat top circle)
 * This is separate from the cylindrical joint cover body
 */
export function isTopCapFaceMaterial(materialName: string): boolean {
  if (!TOP_CAP_CONFIG.enabled) return false;

  const nameLower = (materialName || "").toLowerCase();
  // Specifically match "top_cap" material (the flat face)
  return nameLower.includes("top_cap");
}

/**
 * Check if material/mesh is the leather cylinder (wrap body)
 * Must be checked AFTER isRubberMaterial and isTopCapMaterial to avoid false positives
 */
export function isCylinderLeatherMaterial(materialName: string, meshName = ""): boolean {
  if (!CYLINDER_LEATHER_CONFIG.enabled) return false;

  const nameLower = (materialName || "").toLowerCase();
  const meshLower = (meshName || "").toLowerCase();

  // Exclude rubber and top cap first (they share some keywords)
  if (isRubberMaterial(materialName, meshName)) return false;
  if (isTopCapMaterial(materialName, meshName)) return false;
  if (isTopCapFaceMaterial(materialName)) return false;

  return CYLINDER_LEATHER_CONFIG.materialNames.some((keyword) => {
    const keyLower = keyword.toLowerCase();
    return nameLower.includes(keyLower) || meshLower.includes(keyLower);
  });
}
