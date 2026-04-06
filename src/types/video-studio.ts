import type { HdriLayer } from "./extractor";
import { createDefaultHdriLayer } from "./extractor";

// ── Camera Keyframes (start and end) ──

export interface CameraKeyframe {
  cuePercent: number;       // 0–100: position along cue length (0%=bottom, 100%=top)
  distanceFromCue: number;  // 0.5–5.0: how far from cue
  offsetX: number;          // -2.0 to 2.0: horizontal offset from cue center
}

export const DEFAULT_CAMERA_START: CameraKeyframe = {
  cuePercent: 10,
  distanceFromCue: 3.0,
  offsetX: 0,
};

export const DEFAULT_CAMERA_END: CameraKeyframe = {
  cuePercent: 90,
  distanceFromCue: 1.8,
  offsetX: 0,
};

// ── Camera Direction ──

export type CameraDirection = "fixed" | "x" | "y" | "z" | "xy" | "xz" | "yz" | "xyz";

export interface CameraDirectionPreset {
  id: CameraDirection;
  name: string;
  description: string;
}

export const CAMERA_DIRECTION_PRESETS: CameraDirectionPreset[] = [
  { id: "fixed", name: "Fixed",     description: "Camera stays still" },
  { id: "x",    name: "Slide X",    description: "Left↔right across cue" },
  { id: "y",    name: "Slide Y",    description: "Bottom↔top along cue" },
  { id: "z",    name: "Dolly Z",    description: "Close↔far from cue" },
  { id: "xy",   name: "Cross XY",   description: "Diagonal across + along" },
  { id: "xz",   name: "Depth XZ",   description: "Across + depth" },
  { id: "yz",   name: "Along YZ",   description: "Along cue + depth" },
  { id: "xyz",  name: "Free XYZ",   description: "Unconstrained path" },
];

// ── Cue Instance & Config ──

export const MAX_CUE_INSTANCES = 4;

export interface CueInstance {
  id: string;
  positionX: number;  // -14 to 14
  positionY: number;  // -1 to 10
  positionZ: number;  // -5 to 3
  scale: number;      // 4–12
  isMain: boolean;    // first cue is always main
}

export interface CueConfig {
  instances: CueInstance[];  // 1–4 cues
  spinY: number;             // Model Y rotation (radians, 0–2π) — shared
  spinSpeed: number;         // Continuous Y-rotation speed (0–1) — shared
  spinX: number;             // Model X rotation (radians, 0–2π) — shared
  spinSpeedX: number;        // Continuous X-rotation speed (0–1) — shared
  spinZ: number;             // Model Z rotation (radians, 0–2π) — shared
}

export const DEFAULT_CUE_CONFIG: CueConfig = {
  instances: [{
    id: "main",
    positionX: 0,
    positionY: 0,
    positionZ: 0,
    scale: 7,
    isMain: true,
  }],
  spinY: 0,
  spinSpeed: 0,
  spinX: 0,
  spinSpeedX: 0,
  spinZ: 0,
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

// ── Background Frame & Surface Config ──

export const MAX_BACKGROUND_FRAMES = 4;

export type BackgroundFrameType = "color" | "gradient" | "image";

export interface BackgroundFrame {
  id: string;
  type: BackgroundFrameType;
  color?: string;
  gradient?: { presetId: string; angle: number };
  imageUrl?: string | null;
  x: number;        // Center X (0=left, 0.5=center, 1=right)
  y: number;        // Center Y (0=top, 0.5=center, 1=bottom)
  width: number;    // 0–2 (1 = full surface width)
  height: number;   // 0–2 (1 = full surface height)
  rotation: number; // Degrees 0–360
  opacity: number;  // 0–1
  enabled: boolean;
}

export interface SurfaceConfig {
  baseColor: string;
  frames: BackgroundFrame[];  // Max 4, ordered bottom-to-top
}

export const DEFAULT_WALL_SURFACE: SurfaceConfig = {
  baseColor: "#161616",
  frames: [],
};

export const DEFAULT_TABLE_SURFACE: SurfaceConfig = {
  baseColor: "#0d0d0d",
  frames: [],
};

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
  cueConfig: CueConfig;
  cameraDirection: CameraDirection;
  cameraStart: CameraKeyframe;
  cameraEnd: CameraKeyframe;
  cameraSpeed: number;
  lockDistance: boolean;      // When true, start/end share the same distanceFromCue
  easing: EasingConfig;
  wallSurface: SurfaceConfig;
  tableSurface: SurfaceConfig;
  hdriConfig: { layers: HdriLayer[] };
  hdriIntensity: number;               // Environment intensity (0–3, default 1.0)
  quality: "hd" | "2k";
  shadow: { enabled: boolean; intensity: number; blur: number; softness: number; offsetX: number; offsetY: number };
  hdriFile: string;
  surfaceHdri: { enabled: boolean; hdriFile: string; rotationX: number; rotationY: number; intensity: number };
}

export const DEFAULT_STUDIO_CONFIG: VideoStudioConfig = {
  cueConfig: { ...DEFAULT_CUE_CONFIG, instances: DEFAULT_CUE_CONFIG.instances.map(i => ({ ...i })) },
  cameraDirection: "yz",
  cameraStart: { ...DEFAULT_CAMERA_START },
  cameraEnd: { ...DEFAULT_CAMERA_END },
  cameraSpeed: 0.5,
  lockDistance: false,
  easing: { ...DEFAULT_EASING },
  wallSurface: { ...DEFAULT_WALL_SURFACE },
  tableSurface: { ...DEFAULT_TABLE_SURFACE },
  hdriConfig: { layers: [createDefaultHdriLayer()] },
  hdriIntensity: 1.0,
  quality: "hd",
  shadow: { enabled: true, intensity: 0.6, blur: 3, softness: 0.45, offsetX: 0, offsetY: 0 },
  hdriFile: "ferndale_studio_07_2k.hdr",
  surfaceHdri: { enabled: false, hdriFile: "ferndale_studio_07_2k.hdr", rotationX: 0, rotationY: 0, intensity: 0.3 },
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

const CUE_LENGTH_SCENE_UNITS = 3;

export function computeVideoDuration(
  start: CameraKeyframe,
  end: CameraKeyframe,
  cameraSpeed: number
): number {
  const dY = (end.cuePercent - start.cuePercent) / 100 * CUE_LENGTH_SCENE_UNITS;
  const dDist = end.distanceFromCue - start.distanceFromCue;
  const dX = end.offsetX - start.offsetX;
  const pathLength = Math.sqrt(dY * dY + dDist * dDist + dX * dX);
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

// ── Factory: Create a new background frame ──

export function createBackgroundFrame(type: BackgroundFrameType = "color"): BackgroundFrame {
  const id = crypto.randomUUID();
  return {
    id,
    type,
    color: type === "color" ? "#1a1a1a" : undefined,
    gradient: type === "gradient" ? { presetId: "n01", angle: 180 } : undefined,
    imageUrl: type === "image" ? null : undefined,
    x: 0.5,
    y: 0.5,
    width: 1,
    height: 1,
    rotation: 0,
    opacity: 1,
    enabled: true,
  };
}

// ── Factory: Create a new cue instance ──

export function createCueInstance(): CueInstance {
  return {
    id: crypto.randomUUID(),
    positionX: 2,   // offset from main cue so clones don't overlap
    positionY: 0,
    positionZ: 0,
    scale: 7,
    isMain: false,
  };
}
