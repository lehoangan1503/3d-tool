export type ProductType = "smooth" | "leather";

export type LeatherTextureType = "crocodile" | "cowhide" | "snake" | "custom";

export type LeatherColor = "black" | "chestnut" | "chocolate" | "darkBrown" | "whiskey" | "tan";

export interface Product {
  id: string;
  user_id: string;
  name: string;
  type: ProductType;
  surface_url: string | null;
  texture_type: LeatherTextureType | null;
  texture_url: string | null;
  color: LeatherColor | null;
  threejs_settings_id: string | null;
  created_at: string;
  updated_at: string;
}

// Editable configuration for 3D preview
export interface ProductConfig {
  // Lighting/Environment settings (shared by all types)
  ambientLight: number;      // 0-2 range
  hemisphereLight: number;   // 0-2 range
  clearcoat: number;         // 0-100 range (shared)
  bodyRoughness: number;     // 0-255 range for non-leather body parts
  // Leather material settings (only for leather type)
  leatherRoughness: number;  // 0-255 range for leather wrap
  leatherSheen: number;      // 0-100 range (hidden but in JSON)
  normalStrength: number;    // 0-10 range
  textureScale: number;      // 1-8 range - how many times to tile the texture
}

// JSON structure stored in threejs_settings table
export interface ThreeJSSettingsJson {
  lighting: {
    ambientLight: number;
    hemisphereLight: number;
    clearcoat: number;
    bodyRoughness: number;
  };
  material: {
    leatherRoughness: number;
    sheen: number;
    normalStrength: number;
    textureScale: number;
  };
}

// Convert ProductConfig to database JSON format
export function configToSettingsJson(config: ProductConfig): ThreeJSSettingsJson {
  return {
    lighting: {
      ambientLight: config.ambientLight,
      hemisphereLight: config.hemisphereLight,
      clearcoat: config.clearcoat,
      bodyRoughness: config.bodyRoughness,
    },
    material: {
      leatherRoughness: config.leatherRoughness,
      sheen: config.leatherSheen,
      normalStrength: config.normalStrength,
      textureScale: config.textureScale,
    },
  };
}

// Convert database JSON to ProductConfig
export function settingsJsonToConfig(json: ThreeJSSettingsJson): ProductConfig {
  return {
    ambientLight: json.lighting.ambientLight,
    hemisphereLight: json.lighting.hemisphereLight,
    clearcoat: json.lighting.clearcoat,
    bodyRoughness: json.lighting.bodyRoughness,
    leatherRoughness: json.material.leatherRoughness,
    leatherSheen: json.material.sheen,
    normalStrength: json.material.normalStrength,
    textureScale: json.material.textureScale ?? 1,
  };
}

export interface CreateProductInput {
  name: string;
  type: ProductType;
  surface_url?: string;
  texture_type?: LeatherTextureType;
  color?: LeatherColor;
}

export interface UpdateProductInput {
  name?: string;
  surface_url?: string;
  texture_type?: LeatherTextureType;
  texture_url?: string;
  color?: LeatherColor;
}

// Color palette for leather products
export const LEATHER_COLORS: Record<LeatherColor, { name: string; hex: string }> = {
  black: { name: "Black", hex: "#1A1A1A" },
  chestnut: { name: "Chestnut", hex: "#954535" },
  chocolate: { name: "Chocolate", hex: "#3D1C02" },
  darkBrown: { name: "Dark Brown", hex: "#2C1608" },
  whiskey: { name: "Whiskey", hex: "#B5651D" },
  tan: { name: "Tan", hex: "#D2B48C" },
};

// Model paths (single model for all types)
export const MODEL_PATHS: Record<ProductType, string> = {
  smooth: "/models/cue-butt-leather.glb",
  leather: "/models/cue-butt-leather.glb",
};

// Default textures (normal maps for leather types)
export const LEATHER_TEXTURES: Record<LeatherTextureType, { name: string; path: string }> = {
  crocodile: { name: "Crocodile", path: "/textures/leathers/type1/leather-texture.webp" },
  cowhide: { name: "Cowhide", path: "/textures/leathers/type2/cowhide-normal.png" },
  snake: { name: "Snake", path: "/textures/leathers/type2/leather-texture.webp" },
  custom: { name: "Custom", path: "" },
};

// Default values for config - Smooth cue type
export const DEFAULT_SMOOTH_CONFIG: ProductConfig = {
  ambientLight: 0.55,
  hemisphereLight: 0.4,
  clearcoat: 5,
  bodyRoughness: 0,            // Smooth cue body (0 = very shiny)
  leatherRoughness: 0,         // Not used for smooth cue
  leatherSheen: 0,             // Not used for smooth cue
  normalStrength: 0,           // Not used for smooth cue
  textureScale: 1,             // Not used for smooth cue
};

// Default values for config - Leather cue type
export const DEFAULT_LEATHER_CONFIG: ProductConfig = {
  ambientLight: 0.55,
  hemisphereLight: 0.4,
  clearcoat: 5,
  bodyRoughness: 0,            // Body roughness for "outside" mesh
  leatherRoughness: 120,       // Leather wrap roughness
  leatherSheen: 80,            // Leather sheen
  normalStrength: 3.0,         // Leather normal map strength
  textureScale: 1,             // Texture tiling (1 = no repeat, 2+ = tiled)
};

// Recommended texture settings per leather type
export const LEATHER_TEXTURE_PRESETS: Record<LeatherTextureType, Partial<ProductConfig>> = {
  crocodile: {
    normalStrength: 3.5,
    textureScale: 1,           // Crocodile has large scales, no tiling needed
    leatherRoughness: 120,
  },
  cowhide: {
    normalStrength: 6.0,       // Higher strength for more pronounced grain
    textureScale: 6,           // Tile 6x for dense pebble pattern (grain is scaled 16x bigger)
    leatherRoughness: 230,     // High roughness for matte cowhide surface (0-255)
  },
  snake: {
    normalStrength: 2.5,
    textureScale: 2,           // Medium tiling for snake scales
    leatherRoughness: 100,
  },
  custom: {
    normalStrength: 3.0,
    textureScale: 1,
    leatherRoughness: 120,
  },
};

// Legacy default - kept for compatibility
export const DEFAULT_PRODUCT_CONFIG: ProductConfig = DEFAULT_LEATHER_CONFIG;
