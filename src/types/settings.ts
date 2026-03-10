export interface ThreeJSSettings {
  camera: {
    fov: number;
    position: [number, number, number];
    near: number;
    far: number;
  };
  controls: {
    enableDamping: boolean;
    dampingFactor: number;
    minDistance: number;
    maxDistance: number;
  };
  lighting: {
    ambient: number;
    hemisphere: number;
  };
  background: {
    dark: string;
    light: string;
  };
}

export interface LeatherSettings {
  normalStrength: number;
  roughness: number;
  clearcoat: number;
  sheen: number;
  colorPalette: string[];
  textureTypes: string[];
}

export interface SettingsResponse {
  default: ThreeJSSettings;
  leather: LeatherSettings;
}

// Default settings (fallback if DB unavailable)
export const DEFAULT_THREEJS_SETTINGS: ThreeJSSettings = {
  camera: {
    fov: 50,
    position: [0, 1.8, 4],
    near: 0.1,
    far: 1000,
  },
  controls: {
    enableDamping: true,
    dampingFactor: 0.05,
    minDistance: 0.2,
    maxDistance: 10,
  },
  lighting: {
    ambient: 0.55,
    hemisphere: 0.4,
  },
  background: {
    dark: "#2a2a2a",
    light: "#f2f4f8",
  },
};

export const DEFAULT_LEATHER_SETTINGS: LeatherSettings = {
  normalStrength: 3.0,
  roughness: 245,
  clearcoat: 5,
  sheen: 80,
  colorPalette: ["black", "chestnut", "chocolate", "darkBrown", "whiskey", "tan"],
  textureTypes: ["crocodile", "snake"],
};
