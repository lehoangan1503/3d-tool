import type { HdriLayer, BlendMode } from "./extractor";
import { createDefaultHdriLayer } from "./extractor";

// ── Camera Position (start and end) ──

export interface CameraPosition {
  distance: number;   // Z-axis far↔close (0.5–5.0)
  panX: number;       // Horizontal offset (-2.0 to 2.0)
  panY: number;       // Vertical offset (-2.0 to 2.0)
  dutchTilt: number;  // Camera roll angle in degrees (-45 to 45)
}

export const DEFAULT_CAMERA_START: CameraPosition = {
  distance: 3.0,
  panX: 0,
  panY: 0,
  dutchTilt: 0,
};

export const DEFAULT_CAMERA_END: CameraPosition = {
  distance: 1.8,
  panX: 0,
  panY: 0,
  dutchTilt: 0,
};

// ── Cue Position (static setup matching Image Extractor CueSettings) ──

export interface VideoCuePosition {
  spinY: number;      // Model Y rotation (radians, 0–2π)
  phi: number;        // Camera vertical orbit (radians, 0=top, π/2=side)
  zoom: number;       // Zoom multiplier (0.5–3.0)
  offsetX: number;    // Horizontal offset (-1.0 to 1.0)
  offsetY: number;    // Vertical offset (-1.0 to 1.0)
  cueScale: number;   // Model scale (4–12)
  spinSpeed: number;  // Continuous Y-rotation (0=none, 1=max)
}

export const DEFAULT_CUE_POSITION: VideoCuePosition = {
  spinY: 0,
  phi: Math.PI / 2,
  zoom: 1.0,
  offsetX: 0,
  offsetY: 0,
  cueScale: 7,
  spinSpeed: 0,
};

// ── Easing ──

export interface EasingConfig {
  type: "preset" | "custom";
  preset?: string;
  customValue?: string; // cubic-bezier params e.g. "0.4, 0, 0.2, 1"
}

export interface EasingPreset {
  id: string;
  name: string;
  value: string;
  feel: string;
}

export const EASING_PRESETS: EasingPreset[] = [
  { id: "linear",           name: "Linear",               value: "linear",                       feel: "Constant speed" },
  { id: "ease-in",          name: "Ease In",              value: "cubic-bezier(0.4, 0, 1, 1)",   feel: "Slow start, fast end" },
  { id: "ease-out",         name: "Ease Out",             value: "cubic-bezier(0, 0, 0.2, 1)",   feel: "Fast start, slow end" },
  { id: "ease-in-out",      name: "Ease In-Out",          value: "cubic-bezier(0.4, 0, 0.2, 1)", feel: "Smooth acceleration" },
  { id: "cinematic-slow",   name: "Cinematic Slow-Start", value: "cubic-bezier(0.7, 0, 0.3, 1)", feel: "Dramatic slow build" },
  { id: "dramatic-reveal",  name: "Dramatic Reveal",      value: "cubic-bezier(0.1, 0, 0.1, 1)", feel: "Very slow start, hold" },
];

export const DEFAULT_EASING: EasingConfig = {
  type: "preset",
  preset: "ease-in-out",
};

// ── Camera Movement Presets ──

export interface CameraMovementPreset {
  id: string;
  name: string;
  start: CameraPosition;
  end: CameraPosition;
}

export const CAMERA_MOVEMENT_PRESETS: CameraMovementPreset[] = [
  { id: "dolly-in",          name: "Dolly In",            start: { distance: 4, panX: 0, panY: 0, dutchTilt: 0 },      end: { distance: 1.5, panX: 0, panY: 0, dutchTilt: 0 } },
  { id: "dolly-out",         name: "Dolly Out",           start: { distance: 1.5, panX: 0, panY: 0, dutchTilt: 0 },    end: { distance: 4, panX: 0, panY: 0, dutchTilt: 0 } },
  { id: "pan-right",         name: "Pan Right",           start: { distance: 2.5, panX: -1.5, panY: 0, dutchTilt: 0 }, end: { distance: 2.5, panX: 1.5, panY: 0, dutchTilt: 0 } },
  { id: "pan-left",          name: "Pan Left",            start: { distance: 2.5, panX: 1.5, panY: 0, dutchTilt: 0 },  end: { distance: 2.5, panX: -1.5, panY: 0, dutchTilt: 0 } },
  { id: "vertical-rise",     name: "Vertical Rise",       start: { distance: 2.5, panX: 0, panY: -1, dutchTilt: 0 },   end: { distance: 2.5, panX: 0, panY: 1, dutchTilt: 0 } },
  { id: "diagonal-sweep",    name: "Diagonal Sweep",      start: { distance: 3, panX: -1.5, panY: -1, dutchTilt: 0 },  end: { distance: 2, panX: 1.5, panY: 1, dutchTilt: 0 } },
  { id: "cinematic-approach", name: "Cinematic Approach",  start: { distance: 4, panX: 0, panY: -0.5, dutchTilt: -10 }, end: { distance: 1.5, panX: 0, panY: 0, dutchTilt: 5 } },
  { id: "orbit-tilt",        name: "Orbit Tilt",          start: { distance: 2.5, panX: 0, panY: 0, dutchTilt: 0 },    end: { distance: 2.5, panX: 0, panY: 0, dutchTilt: 20 } },
];

// ── Background Layer System ──

export type BackgroundLayerType = "color" | "gradient" | "image";

export interface BackgroundLayer {
  id: string;
  type: BackgroundLayerType;
  color?: string;
  gradient?: {
    presetId: string;
    angle: number;
  };
  imageUrl?: string | null;
  objectFit?: "cover" | "contain" | "custom";
  opacity: number;
  blendMode: BlendMode;
  enabled: boolean;
}

export const DEFAULT_WALL_LAYERS: BackgroundLayer[] = [
  { id: "wall-base", type: "color", color: "#161616", opacity: 1, blendMode: "normal", enabled: true },
];

export const DEFAULT_TABLE_LAYERS: BackgroundLayer[] = [
  { id: "table-base", type: "color", color: "#0d0d0d", opacity: 1, blendMode: "normal", enabled: true },
];

// ── Gradient Presets (45 total: 15 cold, 15 warm, 15 neutral) ──

export type GradientCategory = "cold" | "warm" | "neutral";

export interface GradientPreset {
  id: string;
  name: string;
  category: GradientCategory;
  colors: string[];
  angle: number;
}

export const GRADIENT_PRESETS: GradientPreset[] = [
  // ── Cold (15) ──
  { id: "c01", name: "Arctic Ice",       category: "cold", colors: ["#0f2027", "#2c5364"], angle: 135 },
  { id: "c02", name: "Frozen Dawn",      category: "cold", colors: ["#141e30", "#243b55"], angle: 180 },
  { id: "c03", name: "Deep Ocean",       category: "cold", colors: ["#000428", "#004e92"], angle: 135 },
  { id: "c04", name: "Midnight Teal",    category: "cold", colors: ["#0a1628", "#1a4a5e", "#0d2137"], angle: 180 },
  { id: "c05", name: "Polar Night",      category: "cold", colors: ["#0c0c1d", "#1a1a3e"], angle: 160 },
  { id: "c06", name: "Sapphire",         category: "cold", colors: ["#0f0c29", "#302b63", "#24243e"], angle: 135 },
  { id: "c07", name: "Glacial Blue",     category: "cold", colors: ["#0d1b2a", "#1b3a4b"], angle: 180 },
  { id: "c08", name: "Twilight",         category: "cold", colors: ["#0a0e27", "#232946"], angle: 135 },
  { id: "c09", name: "Nebula",           category: "cold", colors: ["#16002f", "#2b1055", "#0f0f3d"], angle: 160 },
  { id: "c10", name: "Steel",            category: "cold", colors: ["#1a1a2e", "#16213e"], angle: 180 },
  { id: "c11", name: "Frost",            category: "cold", colors: ["#0b1520", "#1a3a4a", "#0d2030"], angle: 135 },
  { id: "c12", name: "Cyan Pulse",       category: "cold", colors: ["#000000", "#003545"], angle: 180 },
  { id: "c13", name: "Indigo Night",     category: "cold", colors: ["#0a0015", "#1a0a3e"], angle: 160 },
  { id: "c14", name: "Blue Velvet",      category: "cold", colors: ["#0d0221", "#150e3d", "#0a0a2e"], angle: 135 },
  { id: "c15", name: "Winter Sky",       category: "cold", colors: ["#0c1824", "#1e3a50"], angle: 180 },

  // ── Warm (15) ──
  { id: "w01", name: "Ember",            category: "warm", colors: ["#1a0000", "#3d0c02"], angle: 135 },
  { id: "w02", name: "Sunset Gold",      category: "warm", colors: ["#1a0f00", "#3d2400", "#1a1000"], angle: 180 },
  { id: "w03", name: "Amber Glow",       category: "warm", colors: ["#1a1000", "#3d2c00"], angle: 135 },
  { id: "w04", name: "Volcanic",         category: "warm", colors: ["#0f0000", "#2d0a00", "#1a0500"], angle: 160 },
  { id: "w05", name: "Desert Sand",      category: "warm", colors: ["#1a1208", "#3d2e1a"], angle: 180 },
  { id: "w06", name: "Rose Gold",        category: "warm", colors: ["#1a0a10", "#3d1a2a", "#2a0f1a"], angle: 135 },
  { id: "w07", name: "Copper",           category: "warm", colors: ["#1a0d05", "#3d2010"], angle: 180 },
  { id: "w08", name: "Mahogany",         category: "warm", colors: ["#1a0505", "#3d1010"], angle: 160 },
  { id: "w09", name: "Burnt Sienna",     category: "warm", colors: ["#1a0a00", "#3d1f0a", "#2a1205"], angle: 135 },
  { id: "w10", name: "Crimson",          category: "warm", colors: ["#0f0005", "#2d0010"], angle: 180 },
  { id: "w11", name: "Terracotta",       category: "warm", colors: ["#1a0e08", "#3d2418"], angle: 135 },
  { id: "w12", name: "Firefly",          category: "warm", colors: ["#0a0800", "#1a1800", "#0d0d00"], angle: 160 },
  { id: "w13", name: "Rust",             category: "warm", colors: ["#1a0800", "#3d1800"], angle: 180 },
  { id: "w14", name: "Wine",             category: "warm", colors: ["#1a0010", "#2d0020", "#1a0015"], angle: 135 },
  { id: "w15", name: "Molten",           category: "warm", colors: ["#0f0500", "#2d1400"], angle: 160 },

  // ── Neutral (15) ──
  { id: "n01", name: "Charcoal",         category: "neutral", colors: ["#0a0a0a", "#1a1a1a"], angle: 180 },
  { id: "n02", name: "Graphite",         category: "neutral", colors: ["#0d0d0d", "#2a2a2a", "#141414"], angle: 135 },
  { id: "n03", name: "Smoke",            category: "neutral", colors: ["#121212", "#1e1e1e"], angle: 180 },
  { id: "n04", name: "Obsidian",         category: "neutral", colors: ["#050505", "#151515"], angle: 160 },
  { id: "n05", name: "Slate",            category: "neutral", colors: ["#0e0e12", "#1c1c24"], angle: 135 },
  { id: "n06", name: "Ash",              category: "neutral", colors: ["#141414", "#242424", "#1a1a1a"], angle: 180 },
  { id: "n07", name: "Onyx",             category: "neutral", colors: ["#080808", "#181818"], angle: 135 },
  { id: "n08", name: "Pewter",           category: "neutral", colors: ["#101012", "#202025"], angle: 160 },
  { id: "n09", name: "Iron",             category: "neutral", colors: ["#0c0c0e", "#1c1c20", "#121215"], angle: 180 },
  { id: "n10", name: "Shadow",           category: "neutral", colors: ["#060606", "#161616"], angle: 135 },
  { id: "n11", name: "Carbon",           category: "neutral", colors: ["#0a0a0b", "#1a1a1c"], angle: 180 },
  { id: "n12", name: "Basalt",           category: "neutral", colors: ["#0d0d0f", "#1d1d22", "#131316"], angle: 160 },
  { id: "n13", name: "Ebony",            category: "neutral", colors: ["#070708", "#171718"], angle: 135 },
  { id: "n14", name: "Granite",          category: "neutral", colors: ["#0f0f10", "#1f1f22"], angle: 180 },
  { id: "n15", name: "Thunder",          category: "neutral", colors: ["#080810", "#18182a"], angle: 160 },
];

// ── Full Studio Config ──

export interface VideoStudioConfig {
  cuePosition: VideoCuePosition;
  cameraStart: CameraPosition;
  cameraEnd: CameraPosition;
  cameraSpeed: number;
  easing: EasingConfig;
  wallLayers: BackgroundLayer[];
  tableLayers: BackgroundLayer[];
  hdriConfig: { layers: HdriLayer[] };
  quality: "hd" | "2k";
  shadow: { enabled: boolean; intensity: number };
  hdriFile: string;
}

export const DEFAULT_STUDIO_CONFIG: VideoStudioConfig = {
  cuePosition: { ...DEFAULT_CUE_POSITION },
  cameraStart: { ...DEFAULT_CAMERA_START },
  cameraEnd: { ...DEFAULT_CAMERA_END },
  cameraSpeed: 0.5,
  easing: { ...DEFAULT_EASING },
  wallLayers: DEFAULT_WALL_LAYERS.map(l => ({ ...l })),
  tableLayers: DEFAULT_TABLE_LAYERS.map(l => ({ ...l })),
  hdriConfig: { layers: [createDefaultHdriLayer()] },
  quality: "hd",
  shadow: { enabled: true, intensity: 0.6 },
  hdriFile: "ferndale_studio_07_2k.hdr",
};

// ── Studio Template (DB record) ──

export interface VideoStudioTemplate {
  id: string;
  name: string;
  config: VideoStudioConfig;
  createdAt?: string;
  updatedAt?: string;
}

// ── Quality Presets ──

export const VIDEO_QUALITY_PRESETS = {
  hd:   { width: 1920, height: 1080, bitrate: 8_000_000, fps: 30 },
  "2k": { width: 2560, height: 1440, bitrate: 16_000_000, fps: 30 },
} as const;

// ── Utility: Compute video duration from camera path ──

const TILT_WEIGHT = 0.02;

export function computeVideoDuration(
  start: CameraPosition,
  end: CameraPosition,
  cameraSpeed: number
): number {
  const dx = end.panX - start.panX;
  const dy = end.panY - start.panY;
  const dz = end.distance - start.distance;
  const dt = Math.abs(end.dutchTilt - start.dutchTilt) * TILT_WEIGHT;
  const pathLength = Math.sqrt(dx * dx + dy * dy + dz * dz) + dt;
  const duration = pathLength / Math.max(0.01, cameraSpeed);
  return Math.max(3, Math.min(30, duration));
}

// ── Utility: Parse easing to interpolation function ──

export function createEasingFunction(config: EasingConfig): (t: number) => number {
  const presetMap: Record<string, string> = {};
  EASING_PRESETS.forEach(p => { presetMap[p.id] = p.value; });

  let value = "linear";
  if (config.type === "preset" && config.preset) {
    value = presetMap[config.preset] || "linear";
  } else if (config.type === "custom" && config.customValue) {
    value = `cubic-bezier(${config.customValue})`;
  }

  if (value === "linear") return (t: number) => t;

  const match = value.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
  if (!match) return (t: number) => t;

  const [, p1xS, p1yS, p2xS, p2yS] = match;
  return cubicBezier(Number(p1xS), Number(p1yS), Number(p2xS), Number(p2yS));
}

function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (t: number) => number {
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Newton-Raphson to solve for x parameter
    let x = t;
    for (let i = 0; i < 8; i++) {
      const cx = 3 * p1x * x * (1 - x) * (1 - x) + 3 * p2x * x * x * (1 - x) + x * x * x - t;
      const dx = 3 * p1x * (1 - x) * (1 - x) - 6 * p1x * x * (1 - x) + 6 * p2x * x * (1 - x) - 3 * p2x * x * x + 3 * x * x;
      if (Math.abs(dx) < 1e-6) break;
      x -= cx / dx;
    }
    return 3 * p1y * x * (1 - x) * (1 - x) + 3 * p2y * x * x * (1 - x) + x * x * x;
  };
}

// ── Helper to create a new background layer ──

let _layerCounter = 0;

export function createBackgroundLayer(type: BackgroundLayerType = "color"): BackgroundLayer {
  const id = `layer-${++_layerCounter}-${Date.now()}`;
  return {
    id,
    type,
    color: type === "color" ? "#1a1a1a" : undefined,
    gradient: type === "gradient" ? { presetId: "n01", angle: 180 } : undefined,
    imageUrl: type === "image" ? null : undefined,
    objectFit: type === "image" ? "cover" : undefined,
    opacity: 1,
    blendMode: "normal",
    enabled: true,
  };
}
