// Image Extractor Types
export interface ImageExtractorConfig {
  width: number; // Default: 2048
  height: number; // Default: 2048
  format: "png" | "jpeg" | "webp";
  quality: number; // 0-1 for jpeg/webp

  parts: {
    bottomBump: PartViewConfig;
    centerCue: PartViewConfig;
    topCap: PartViewConfig;
  };
}

export interface PartViewConfig {
  cameraDistance: number;
  cameraAngleY: number; // Rotation around Y axis (radians)
  cameraAngleX: number; // Tilt angle (radians) - 45° = Math.PI/4
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  zoom: number;
}

// Video Extractor Types

/** A single background layer for the video studio backdrop */
export interface VideoBackgroundLayer {
  id: string;
  type: 'color' | 'image';
  color: string;          // hex color (e.g. '#0a0a0a')
  imageUrl: string | null; // blob URL or public path
  opacity: number;        // 0–1
  blendMode: 'normal' | 'additive' | 'multiply';
  enabled: boolean;
}

export interface VideoExtractorConfig {
  width: number; // Default: 1920 (HD) or 2560 (2K)
  height: number; // Default: 1080 (HD) or 1440 (2K)
  fps: number; // Default: 30
  duration: number; // Total seconds
  format: "webm" | "mp4";
  bitrate: number; // bits per second

  rotationSpeed: number; // Radians per second — spin around cue's own axis (0.1–1 recommended)
  /** Scale multiplier. 6–8× recommended for close-up product shot. */
  modelScale: number;

  backgroundType: "fabric" | "solid" | "gradient";
  backgroundColor: string; // Reserved for future custom backdrop color

  /**
   * Path to a custom velvet table texture image (PNG/JPG).
   * Example: '/textures/studio/velvet-black.jpg'
   * If omitted, a procedural dark velvet texture is generated.
   */
  tableTextureUrl?: string;

  /**
   * Path to a custom cement/concrete wall texture image (PNG/JPG).
   * Example: '/textures/studio/cement-dark.jpg'
   * If omitted, a procedural dark cement texture is generated.
   */
  wallTextureUrl?: string;

  enableShadow: boolean;
  shadowIntensity: number;
  shadowBlur: number;

  /** Camera Dutch-angle roll in degrees (0 = flat, 20 = tilted). Default 20. */
  cameraRoll: number;
  /**
   * How far along the cue length (0–1) the camera dolly ends.
   * 0.68 means camera travels from butt end to ~68% = well past the joint.
   */
  cameraEndFraction: number;

  /** Camera pan speed — fraction of cue length traversed per video. 0.15 = slow. */
  cameraDollySpeed: number;
  /** HDRI rotation around Y axis (horizontal direction), degrees 0-360 */
  hdriRotationY: number;
  /** Background layers for the studio wall — stacked from bottom to top */
  backgroundLayers: VideoBackgroundLayer[];
  /** HDRI file to use (filename from /public/hdri/) */
  hdriFile: string;

  // Legacy fields — kept for backward compatibility, no longer used in video recording
  cueAngle?: number;
  panStartY?: number;
  panEndY?: number;
}

export interface ExtractorState {
  isExtracting: boolean;
  progress: number; // 0-100
  previewUrl: string | null;
  error: string | null;
}

export type ExtractorQuality = "hd" | "2k";

// Default configurations
export const DEFAULT_IMAGE_CONFIG: ImageExtractorConfig = {
  width: 2048,
  height: 2048,
  format: "png",
  quality: 1,
  parts: {
    bottomBump: {
      cameraDistance: 1.2,
      cameraAngleY: 0,
      cameraAngleX: Math.PI / 4, // 45°
      bounds: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      zoom: 2.5,
    },
    centerCue: {
      cameraDistance: 3,
      cameraAngleY: 0,
      cameraAngleX: Math.PI / 4, // 45°
      bounds: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
      zoom: 1,
    },
    topCap: {
      cameraDistance: 1.2,
      cameraAngleY: 0,
      cameraAngleX: Math.PI / 4, // 45°
      bounds: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      zoom: 2.5,
    },
  },
};

export const DEFAULT_VIDEO_CONFIG: VideoExtractorConfig = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 16,
  format: "webm",
  bitrate: 8000000,
  rotationSpeed: 0.5,
  modelScale: 7,
  backgroundType: "fabric",
  backgroundColor: "#0d0d0d",
  tableTextureUrl: "/textures/studio/velvet-black.jpg",
  wallTextureUrl:  "/textures/studio/cement-dark.jpg",
  enableShadow: true,
  shadowIntensity: 0.6,
  shadowBlur: 2,
  cameraRoll: 20,
  cameraEndFraction: 1.0,
  cameraDollySpeed: 0.15,
  hdriRotationY: 0,
  hdriFile: 'ferndale_studio_07_2k.hdr',
  backgroundLayers: [{ id: 'base', type: 'color', color: '#0a0a0a', imageUrl: null, opacity: 1, blendMode: 'normal', enabled: true }],
};

export const QUALITY_PRESETS: Record<ExtractorQuality, Partial<VideoExtractorConfig>> = {
  hd: { width: 1920, height: 1080, bitrate: 8000000 },
  "2k": { width: 2560, height: 1440, bitrate: 16000000 },
};

// ==========================================
// Image Extractor V2 Types (Interactive Frames)
// ==========================================

/** Position and settings for a single interactive frame */
export interface FramePosition {
  // Camera orbit position (controlled by left-click drag)
  cameraOrbitX: number; // Horizontal orbit angle (radians)
  cameraOrbitY: number; // Vertical orbit angle (radians)
  cameraDistance: number; // Distance from target

  // Model offset (controlled by right-click drag)
  modelOffsetX: number; // Horizontal offset in scene units
  modelOffsetY: number; // Vertical offset in scene units

  // Zoom (controlled by scroll wheel)
  zoom: number;

  // Light direction (0-360 degrees, like sun position)
  lightAngle: number;
}

/** Complete preset for Image Extractor with all 3 frames */
export interface ImageExtractorPreset {
  gap: number; // Pixel gap between frames
  frames: {
    bottomBump: FramePosition;
    centerCue: FramePosition;
    topCap: FramePosition;
  };
}

/** Default values for a single frame - matches main preview */
export const DEFAULT_FRAME_POSITION: FramePosition = {
  cameraOrbitX: 0,
  cameraOrbitY: 0, // Side view (no tilt) - matches main preview
  cameraDistance: 2.83, // ~sqrt(2^2 + 2^2) - same as main preview camera
  modelOffsetX: 0,
  modelOffsetY: 0,
  zoom: 1,
  lightAngle: 0, // HDRI rotation - no rotation by default
};

/** Default preset for Image Extractor V2 */
export const DEFAULT_IMAGE_EXTRACTOR_PRESET: ImageExtractorPreset = {
  gap: 20,
  frames: {
    bottomBump: {
      ...DEFAULT_FRAME_POSITION,
      zoom: 2.5,
      cameraDistance: 1.5,
    },
    centerCue: {
      ...DEFAULT_FRAME_POSITION,
      zoom: 1,
      cameraDistance: 3,
    },
    topCap: {
      ...DEFAULT_FRAME_POSITION,
      zoom: 2.5,
      cameraDistance: 1.5,
    },
  },
};

/** Frame keys type */
export type FrameKey = "bottomBump" | "centerCue" | "topCap";

/** Frame labels for UI */
export const FRAME_LABELS: Record<FrameKey, string> = {
  bottomBump: "Bottom Bump",
  centerCue: "Full Cue",
  topCap: "Top Cap",
};

// ==========================================
// Image Extractor V3 Types (Frame Editor)
// ==========================================

/** Frame transform on 2048×2048 canvas */
export interface FrameTransform {
  x: number; // X position (px, 0-2048)
  y: number; // Y position (px, 0-2048)
  width: number; // Width (px)
  height: number; // Height (px)
  rotation: number; // Rotation (degrees)
}

/** Special HDRI type for a flat studio light (not an .hdr file) */
export const STUDIO_WHITE_HDRI = "__studio_white__";

/** HDRI layer for multi-HDRI lighting */
export interface HdriLayer {
  id: string; // Unique ID for this layer
  hdriType: string; // HDRI filename or STUDIO_WHITE_HDRI
  rotationX: number; // X-axis rotation (degrees, 0-360) - vertical shift
  rotationY: number; // Y-axis rotation (degrees, 0-360) - horizontal shift
  intensity: number; // Per-layer intensity (0–3, default 1.0)
  enabled: boolean;  // Whether this layer contributes to the blend
  lightColor?: string; // Hex color for studio white light (e.g. "#ffffff")
  shadowBlur?: number;      // Per-light shadow blur radius (0–20; overrides global shadow.blur)
  shadowIntensity?: number; // Per-light shadow darkness (0–1; maps to light.shadow.intensity)
}

/** Default HDRI layer — bloem train (same as DEFAULT_CUE_HDRI).
 *  Studio white is only used for the video studio environment. */
export const DEFAULT_HDRI_LAYER: Omit<HdriLayer, "id"> = {
  hdriType: "bloem_train_track_clear_2k.hdr",
  rotationX: 0,
  rotationY: 300,
  intensity: 1.0,
  enabled: true,
};

/** Create a new HDRI layer with defaults */
export function createDefaultHdriLayer(hdriType?: string): HdriLayer {
  return {
    id: crypto.randomUUID(),
    hdriType: hdriType || DEFAULT_HDRI_LAYER.hdriType,
    rotationX: DEFAULT_HDRI_LAYER.rotationX,
    rotationY: DEFAULT_HDRI_LAYER.rotationY,
    intensity: DEFAULT_HDRI_LAYER.intensity,
    enabled: DEFAULT_HDRI_LAYER.enabled,
    lightColor: DEFAULT_HDRI_LAYER.lightColor,
  };
}

/** Studio shadow config for a CueFrame — mirrors video-studio shadow but driven by a
 *  dedicated DirectionalLight that only affects the shadow plane, never the cue HDRI. */
export interface CueShadowConfig {
  enabled: boolean;
  lightX: number;    // Light X position in scene units (-10 to 10)
  lightY: number;    // Light Y position / elevation (1 to 20)
  lightZ: number;    // Light Z position in scene units (-10 to 10)
  intensity: number; // Shadow darkness (0–1)
  blur: number;      // Shadow softness / PCF radius (0–20)
  wallColor: string;       // Wall + floor background color (hex, default #ffffff)
  wallGradientEnd?: string; // Optional second color for a top→bottom gradient
  studioCapture?: string;   // 2048×2048 studio capture data URL (set on Save)
  /** Saved studio config snapshot — restores camera/cue/light positions on reopen */
  studioConfigSnapshot?: import("@/types/video-studio").VideoStudioConfig;
  shadowOffsetX?: number;   // Shadow plane X offset (default 0)
  shadowOffsetY?: number;   // Shadow plane Y offset from base height (default 0)
  shadowOffsetZ?: number;   // Shadow plane Z offset (default 0)
  shadowScale?: number;     // Shadow plane scale multiplier (default 1)
  shadowRotationY?: number; // Shadow plane Y rotation in radians (default 0)
  wallsTransparent?: boolean; // Hide wall/surface, keep only shadow + cue (PNG export with alpha)
}

export const DEFAULT_CUE_SHADOW: CueShadowConfig = {
  enabled: false,
  lightX: 1.5,
  lightY: 2.0,
  lightZ: 0.5,
  intensity: 0.5,
  blur: 4,
  wallColor: '#ffffff',
};

/** Cue settings within a frame */
export interface CueSettings {
  spinY: number; // Model Y-axis rotation (radians) - horizontal drag
  phi: number; // Camera vertical orbit (radians, 0=top, PI/2=side) - vertical drag
  zoom: number; // Zoom multiplier
  offsetX: number; // Horizontal offset
  offsetY: number; // Vertical offset
  hdriLayers: HdriLayer[]; // 1-2 HDRI layers with independent rotation
  studioShadow?: CueShadowConfig; // 3D studio shadow driven by a directional light
  // Legacy fields (for backward compatibility during migration)
  lightAngle?: number;
  hdriType?: string;
}

// ==========================================
// Image Frame Types (for overlay layers)
// ==========================================

/** Blend modes for image frames */
export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn" | "hard-light" | "soft-light";

/** Object fit options for images */
export type ObjectFit = "custom" | "cover" | "contain";

/** 3D rotation for image frames */
export interface Rotation3D {
  x: number; // degrees, -180 to 180
  y: number; // degrees, -180 to 180
  z: number; // degrees, -180 to 180
}

/** Gradient background for image frames */
export interface ImageGradient {
  name: string;     // Gradient preset name
  colors: string[]; // 2+ hex colors
  angle: number;    // 0–360 degrees
}

/** Settings specific to image frames */
export interface ImageSettings {
  imageUrl: string | null; // Blob/data URL while editing; storage URL after save
  // When true, the frame ignores imageUrl and renders the CURRENT product's flat
  // surface design (product.surface_url) at export time — so each product gets
  // its own surface drawn into this frame. The frame is locked to the full canvas
  // (2048×2048); the user pans/zooms the surface IMAGE inside it via surfacePan.
  dynamicSurface?: boolean;
  // Pan/zoom of the surface image inside a fixed dynamic-surface frame.
  // x/y are normalized offsets (fraction of frame size, 0 = centered); scale is a
  // multiplier on the base "cover" fit (1 = cover, >1 zoom in). Resolution-independent.
  surfacePan?: { x: number; y: number; scale: number };
  backgroundType: "color" | "gradient"; // Which background mode is active
  backgroundColor: string; // Hex color (#ffffff)
  backgroundGradient?: ImageGradient; // Gradient preset + angle
  backgroundEnabled: boolean; // Show background fill behind the image
  backgroundOpacity: number; // 0–1, opacity of the background fill layer
  objectFit: ObjectFit;
  rotation3d: Rotation3D;
  imageOpacity: number; // 0–1, applies to the image layer only
  opacity: number; // 0–1, whole-frame opacity (kept for compat)
  blendMode: BlendMode;
}

/** Default image settings */
export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  imageUrl: null,
  backgroundType: "color",
  backgroundColor: "#2a2a2a",
  backgroundEnabled: true,
  backgroundOpacity: 1,
  objectFit: "cover",
  rotation3d: { x: 0, y: 0, z: 0 },
  imageOpacity: 1,
  opacity: 1,
  blendMode: "normal",
};

/** Default pan/zoom for a dynamic-surface image inside its fixed frame. */
export const DEFAULT_SURFACE_PAN = { x: 0, y: 0, scale: 1 };

/**
 * Transform for a dynamic-surface frame: locked to the full canvas (e.g.
 * 2048×2048). The frame itself never resizes/moves — the user pans/zooms the
 * surface image INSIDE it (see ImageSettings.surfacePan).
 */
export function surfaceFrameTransform(
  canvasWidth: number = DEFAULT_CANVAS_WIDTH,
  canvasHeight: number = DEFAULT_CANVAS_HEIGHT,
): FrameTransform {
  return { x: 0, y: 0, width: canvasWidth, height: canvasHeight, rotation: 0 };
}

/** Default gradient used when switching to gradient mode */
export const DEFAULT_GRADIENT: ImageGradient = {
  name: "Purple Love",
  colors: ["#cc2b5e", "#753a88"],
  angle: 90,
};

/** Build a CSS linear-gradient string from an ImageGradient */
export function imageGradientToCss(g: ImageGradient): string {
  return `linear-gradient(${g.angle}deg, ${g.colors.join(", ")})`;
}

/** Frame type discriminator */
export type FrameType = "cue" | "image";

// ==========================================
// Frame Types (Discriminated Union)
// ==========================================

/** Base frame properties shared by all frame types */
interface BaseFrame {
  id: string;
  name?: string; // Optional user-defined label (e.g. "Front View"); falls back to "Frame N"
  order: number;
  transform: FrameTransform;
}

/** Cue frame - displays 3D model view */
export interface CueFrame extends BaseFrame {
  frameType: "cue";
  cue: CueSettings;
}

/** Image frame - displays uploaded image or solid color overlay */
export interface ImageFrame extends BaseFrame {
  frameType: "image";
  imageSettings: ImageSettings;
}

/** Single frame in the editor (discriminated union) */
export type ExtractorFrame = CueFrame | ImageFrame;

/** Type guard for cue frames */
export function isCueFrame(frame: ExtractorFrame): frame is CueFrame {
  return frame.frameType === "cue";
}

/** Type guard for image frames */
export function isImageFrame(frame: ExtractorFrame): frame is ImageFrame {
  return frame.frameType === "image";
}

/** Canvas ratio preset (stored in image_ratios table) */
export interface ImageRatio {
  id: string;
  label: string;
  width: number;
  height: number;
  isDefault: boolean;
}

/** Default canvas dimensions */
export const DEFAULT_CANVAS_WIDTH = 2048;
export const DEFAULT_CANVAS_HEIGHT = 2048;

/** Saved reference (layout preset) */
export interface ExtractorReference {
  id: string;
  name: string;
  frames: ExtractorFrame[];
  thumbUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  createdByName?: string; // nickname or email of the creator
  canvasWidth?: number;  // default 2048
  canvasHeight?: number; // default 2048
  isOwned?: boolean;     // true if the current user owns this reference
  canEdit?: boolean;     // true if the current user owns it OR is a tool admin
}

export interface ExtractorReferenceGroup {
  id: string;
  name: string;
  referenceIds: string[];
  createdAt?: string;
  updatedAt?: string;
  createdByName?: string; // nickname or email of the creator
  isOwner?: boolean;      // true if the current user created this group
  canEdit?: boolean;      // true if the current user created it OR is a tool admin
}

/** Default frame transform */
export const DEFAULT_FRAME_TRANSFORM: FrameTransform = {
  x: 724, // Centered horizontally (2048-600)/2
  y: 724, // Centered vertically
  width: 600,
  height: 600,
  rotation: 0,
};

/** Default cue settings - matches main preview camera position */
export const DEFAULT_CUE_SETTINGS: CueSettings = {
  spinY: 0, // Model facing front
  phi: 0, // Camera default angle 0°
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  hdriLayers: [createDefaultHdriLayer()], // Default: 1x bloem train track
  studioShadow: { ...DEFAULT_CUE_SHADOW },
};

/** Default frame transform for a given canvas size.
 *  Frame size ≈ 29% of the shorter canvas dimension, centred. */
export function defaultFrameTransform(canvasW = DEFAULT_CANVAS_WIDTH, canvasH = DEFAULT_CANVAS_HEIGHT): FrameTransform {
  const size = Math.round(Math.min(canvasW, canvasH) * 0.293);
  return {
    x: Math.round((canvasW - size) / 2),
    y: Math.round((canvasH - size) / 2),
    width: size,
    height: size,
    rotation: 0,
  };
}

/** Create a new cue frame with defaults */
export function createDefaultFrame(id?: string, order: number = 0, canvasW = DEFAULT_CANVAS_WIDTH, canvasH = DEFAULT_CANVAS_HEIGHT): CueFrame {
  return {
    id: id || crypto.randomUUID(),
    order,
    frameType: "cue",
    transform: defaultFrameTransform(canvasW, canvasH),
    cue: {
      ...DEFAULT_CUE_SETTINGS,
      hdriLayers: [createDefaultHdriLayer()], // Fresh layer with new ID
    },
  };
}

/** Create a new image frame with defaults */
export function createDefaultImageFrame(id?: string, order: number = 0, canvasW = DEFAULT_CANVAS_WIDTH, canvasH = DEFAULT_CANVAS_HEIGHT): ImageFrame {
  return {
    id: id || crypto.randomUUID(),
    order,
    frameType: "image",
    transform: defaultFrameTransform(canvasW, canvasH),
    imageSettings: { ...DEFAULT_IMAGE_SETTINGS },
  };
}

/** Migrate old CueSettings format to new format with hdriLayers */
export function migrateCueSettings(cue: CueSettings): CueSettings {
  // Already has hdriLayers - ensure new fields present
  if (cue.hdriLayers && cue.hdriLayers.length > 0) {
    const migrated = cue.hdriLayers.map(l => ({
      ...l,
      intensity: l.intensity ?? 1.0,
      enabled: l.enabled ?? true,
    }));
    return { ...cue, hdriLayers: migrated };
  }

  // Migrate from old format
  const layer: HdriLayer = {
    id: crypto.randomUUID(),
    hdriType: cue.hdriType || DEFAULT_HDRI_LAYER.hdriType,
    rotationX: 0,
    rotationY: cue.lightAngle || 0,
    intensity: 1.0,
    enabled: true,
  };

  return {
    ...cue,
    hdriLayers: [layer],
  };
}

// ==========================================
// Frame Templates
// ==========================================

/** Template for 1 centered frame */
export const TEMPLATE_1_FRAME: CueFrame[] = [
  {
    id: "frame-1",
    order: 0,
    frameType: "cue",
    transform: { x: 524, y: 524, width: 1000, height: 1000, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 1.2, hdriLayers: [createDefaultHdriLayer()] },
  },
];

/** Template for 2 frames side by side */
export const TEMPLATE_2_FRAMES: CueFrame[] = [
  {
    id: "frame-1",
    order: 0,
    frameType: "cue",
    transform: { x: 100, y: 524, width: 800, height: 1000, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 1.5, hdriLayers: [createDefaultHdriLayer()] },
  },
  {
    id: "frame-2",
    order: 1,
    frameType: "cue",
    transform: { x: 1148, y: 524, width: 800, height: 1000, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 1.5, hdriLayers: [createDefaultHdriLayer()] },
  },
];

/** Template for 3 frames diagonal (like original design) */
export const TEMPLATE_3_DIAGONAL: CueFrame[] = [
  {
    id: "frame-bottom",
    order: 0,
    frameType: "cue",
    transform: { x: 100, y: 1448, width: 500, height: 500, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 2.5, hdriLayers: [createDefaultHdriLayer()] },
  },
  {
    id: "frame-center",
    order: 1,
    frameType: "cue",
    transform: { x: 574, y: 374, width: 900, height: 1300, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 1, hdriLayers: [createDefaultHdriLayer()] },
  },
  {
    id: "frame-top",
    order: 2,
    frameType: "cue",
    transform: { x: 1448, y: 100, width: 500, height: 500, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 2.5, hdriLayers: [createDefaultHdriLayer()] },
  },
];

/** All available templates */
export const FRAME_TEMPLATES = {
  "1-frame": { name: "1 Frame", frames: TEMPLATE_1_FRAME },
  "2-frames": { name: "2 Frames", frames: TEMPLATE_2_FRAMES },
  "3-diagonal": { name: "3 Diagonal", frames: TEMPLATE_3_DIAGONAL },
} as const;

export type TemplateKey = keyof typeof FRAME_TEMPLATES;

// Re-export Video Studio types
export type {
  VideoStudioConfig,
  VideoStudioTemplate,
  EasingConfig,
  GradientPreset,
  GradientCategory,
  EasingPreset,
} from './video-studio';
