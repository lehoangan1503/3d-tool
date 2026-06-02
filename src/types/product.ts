export type ProductType = "smooth" | "leather";

export type LeatherTextureType = "crocodile" | "cowhide" | "snake" | "custom";

export type LeatherColor = "black" | "chestnut" | "chocolate" | "darkBrown" | "whiskey" | "tan";

// Assignable role stored on user_profiles. 'admin' is authoritative via
// auth.users.app_metadata.role and is NOT stored here. null = normal user.
export type UserRole = "mode" | null;

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
  // Optional owner info joined from user_profiles (present in list API responses)
  owner_nickname?: string | null;
  owner_email?: string | null;
  // Shopify deployment summary, attached by the list API and gated by the
  // viewer's role (admin: all products; mode: own products; normal: null).
  shopify_deployment?: ShopifyDeploymentSummary | null;
}

export interface UserProfile {
  id: string;
  user_id: string;
  nickname: string | null;
  email: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

// Shopify product versions / wrap options.
export type ShopifyVersionName = "Standard" | "Premium" | "Pro";
export type ShopifyWrapType = "wrap" | "wrapless";

export interface ShopifyCustomText {
  label: string;
  example: string;
}

// The complete deploy-form payload, persisted so a deployed product can be
// re-opened, edited and re-deployed (or deleted + re-created).
export interface ShopifyFormData {
  productCode: string;
  title: string;
  description: string;
  aiHint: string;
  aiModel: string;
  versions: ShopifyVersionName[];
  wrapType: ShopifyWrapType;
  laserShaft: boolean;
  customImage: boolean;
  // Free custom text (no surcharge) — label/example added to the design.
  customText: ShopifyCustomText | null;
  // Paid custom text (+$20) — requires extra design work.
  customTextPaid: ShopifyCustomText | null;
  collections: string[];
  imageUrls: string[];
  videoUrl: string | null;
  // IDs of the AI skills last used for this product (re-selected on reopen).
  skillIds: string[];
}

// Full Shopify deployment record (shopify_deployments table).
export interface ShopifyDeployment {
  id: string;
  product_id: string;
  shopify_product_id: number | null;
  shopify_handle: string | null;
  admin_url: string | null;
  storefront_url: string | null;
  title: string | null;
  form_data: ShopifyFormData | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Lightweight deployment info surfaced to the UI (badge + creator name + prefill).
export interface ShopifyDeploymentSummary {
  shopify_product_id: number | null;
  admin_url: string | null;
  storefront_url: string | null;
  title: string | null;
  created_by: string | null;
  creator_nickname: string | null;
  created_at: string;
  form_data: ShopifyFormData | null;
}

// A saved collection value for the deploy-form Collections picker.
export interface ShopifyCollection {
  id: string;
  value: string;
  created_by: string | null;
  created_at: string;
}

// A reusable AI prompt template ("skill") selectable in the deploy form.
export interface ShopifySkill {
  id: string;
  name: string;
  prompt_text: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Editable configuration for 3D preview
export interface ProductConfig {
  // Lighting/Environment settings (shared by all types)
  ambientLight: number; // 0-2 range (legacy, kept for DB compat)
  hemisphereLight: number; // 0-2 range (legacy, kept for DB compat)
  clearcoat: number; // 0-100 range (shared)
  bodyRoughness: number; // 0-255 range for non-leather body parts
  hdriExposure: number; // 0-3 range — HDRI intensity control
  hdriType: string; // HDRI filename under /public/hdri (e.g. "bloem_train_track_clear_2k.hdr")
  hdriRotationX: number; // 0-360 — HDRI vertical rotation (X-axis)
  hdriRotationY: number; // 0-360 — HDRI horizontal rotation (Y-axis)
  // Leather material settings (only for leather type)
  leatherRoughness: number; // 0-255 range for leather wrap
  leatherSheen: number; // 0-100 range (hidden but in JSON)
  normalStrength: number; // 0-10 range
  textureScale: number; // 1-8 range - how many times to tile the texture
  // Joint Top settings (isolated per-part config)
  jointRoughness: number; // 0-255 range
  jointClearcoat: number; // 0-100 range
  jointMetalness: number; // 0-1 range
  // Leather Cylinder settings (isolated per-part config)
  cylinderRoughness: number; // 0-255 range
  cylinderClearcoat: number; // 0-100 range
  cylinderMetalness: number; // 0-1 range
  cylinderColor: string; // hex color string
  cylinderNormalScale: number; // 0-10 range - leather texture depth
  cylinderSheen: number; // 0-100 range - leather sheen
  cylinderSheenColor: string; // hex color string
}

// JSON structure stored in threejs_settings table
export interface ThreeJSSettingsJson {
  lighting: {
    ambientLight: number;
    hemisphereLight: number;
    clearcoat: number;
    bodyRoughness: number;
    hdriExposure?: number;
    hdriType?: string;
    hdriRotationX?: number;
    hdriRotationY?: number;
  };
  material: {
    leatherRoughness: number;
    sheen: number;
    normalStrength: number;
    textureScale: number;
  };
  joint?: {
    roughness: number;
    clearcoat: number;
    metalness: number;
  };
  cylinder?: {
    roughness: number;
    clearcoat: number;
    metalness: number;
    color: string;
    normalScale?: number;
    sheen?: number;
    sheenColor?: string;
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
      hdriExposure: config.hdriExposure,
      hdriType: config.hdriType,
      hdriRotationX: config.hdriRotationX,
      hdriRotationY: config.hdriRotationY,
    },
    material: {
      leatherRoughness: config.leatherRoughness,
      sheen: config.leatherSheen,
      normalStrength: config.normalStrength,
      textureScale: config.textureScale,
    },
    joint: {
      roughness: config.jointRoughness,
      clearcoat: config.jointClearcoat,
      metalness: config.jointMetalness,
    },
    cylinder: {
      roughness: config.cylinderRoughness,
      clearcoat: config.cylinderClearcoat,
      metalness: config.cylinderMetalness,
      color: config.cylinderColor,
      normalScale: config.cylinderNormalScale,
      sheen: config.cylinderSheen,
      sheenColor: config.cylinderSheenColor,
    },
  };
}

// Convert database JSON to ProductConfig (backward-compatible with older records)
export function settingsJsonToConfig(json: ThreeJSSettingsJson): ProductConfig {
  return {
    ambientLight: json.lighting.ambientLight,
    hemisphereLight: json.lighting.hemisphereLight,
    clearcoat: json.lighting.clearcoat,
    bodyRoughness: json.lighting.bodyRoughness,
    hdriExposure: json.lighting.hdriExposure ?? 1.0,
    hdriType: json.lighting.hdriType ?? "bloem_train_track_clear_2k.hdr",
    hdriRotationX: json.lighting.hdriRotationX ?? 0,
    hdriRotationY: json.lighting.hdriRotationY ?? 300,
    leatherRoughness: json.material.leatherRoughness,
    leatherSheen: json.material.sheen,
    normalStrength: json.material.normalStrength,
    textureScale: json.material.textureScale ?? 1,
    jointRoughness: json.joint?.roughness ?? 255,
    jointClearcoat: json.joint?.clearcoat ?? 0,
    jointMetalness: json.joint?.metalness ?? 1,
    cylinderRoughness: json.cylinder?.roughness ?? 102,
    cylinderClearcoat: json.cylinder?.clearcoat ?? 10,
    cylinderMetalness: json.cylinder?.metalness ?? 0,
    cylinderColor: json.cylinder?.color ?? "#1A1A1A",
    cylinderNormalScale: json.cylinder?.normalScale ?? 1.0,
    cylinderSheen: json.cylinder?.sheen ?? 0,
    cylinderSheenColor: json.cylinder?.sheenColor ?? "#FFFFFF",
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

// Model paths per product type
export const MODEL_PATHS: Record<ProductType, string> = {
  smooth: "/models/cue-butt-leather-ktx2.glb",
  leather: "/models/cue-butt-leather-ver2-ktx2.glb",
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
  bodyRoughness: 0, // Smooth cue body (0 = very shiny)
  hdriExposure: 1.0, // HDRI intensity (1 = default)
  hdriType: "bloem_train_track_clear_2k.hdr",
  hdriRotationX: 0, // HDRI vertical rotation
  hdriRotationY: 300, // HDRI horizontal rotation (center light in front)
  leatherRoughness: 0, // Not used for smooth cue
  leatherSheen: 0, // Not used for smooth cue
  normalStrength: 0, // Not used for smooth cue
  textureScale: 1, // Not used for smooth cue
  jointRoughness: 120,
  jointClearcoat: 0,
  jointMetalness: 1,
  cylinderRoughness: 102,
  cylinderClearcoat: 10,
  cylinderMetalness: 0,
  cylinderColor: "#1A1A1A",
  cylinderNormalScale: 1.0,
  cylinderSheen: 0,
  cylinderSheenColor: "#FFFFFF",
};

// Default values for config - Leather cue type
export const DEFAULT_LEATHER_CONFIG: ProductConfig = {
  ambientLight: 0.55,
  hemisphereLight: 0.4,
  clearcoat: 5,
  bodyRoughness: 0, // Body roughness for "outside" mesh
  hdriExposure: 1.0, // HDRI intensity (1 = default)
  hdriType: "bloem_train_track_clear_2k.hdr",
  hdriRotationX: 0, // HDRI vertical rotation
  hdriRotationY: 300, // HDRI horizontal rotation (center light in front)
  leatherRoughness: 120, // Leather wrap roughness
  leatherSheen: 80, // Leather sheen
  normalStrength: 3.0, // Leather normal map strength
  textureScale: 1, // Texture tiling (1 = no repeat, 2+ = tiled)
  jointRoughness: 120,
  jointClearcoat: 0,
  jointMetalness: 1,
  cylinderRoughness: 102,
  cylinderClearcoat: 10,
  cylinderMetalness: 0,
  cylinderColor: "#1A1A1A",
  cylinderNormalScale: 1.0,
  cylinderSheen: 0,
  cylinderSheenColor: "#FFFFFF",
};

// Recommended texture settings per leather type
export const LEATHER_TEXTURE_PRESETS: Record<LeatherTextureType, Partial<ProductConfig>> = {
  crocodile: {
    normalStrength: 3.5,
    textureScale: 1, // Crocodile has large scales, no tiling needed
    leatherRoughness: 120,
  },
  cowhide: {
    normalStrength: 6.0, // Higher strength for more pronounced grain
    textureScale: 6, // Tile 6x for dense pebble pattern (grain is scaled 16x bigger)
    leatherRoughness: 230, // High roughness for matte cowhide surface (0-255)
  },
  snake: {
    normalStrength: 2.5,
    textureScale: 2, // Medium tiling for snake scales
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
