// Image Extractor Types
export interface ImageExtractorConfig {
  width: number; // Default: 2048
  height: number; // Default: 2048
  format: 'png' | 'jpeg' | 'webp';
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
export interface VideoExtractorConfig {
  width: number; // Default: 1920 (HD) or 2560 (2K)
  height: number; // Default: 1080 (HD) or 1440 (2K)
  fps: number; // Default: 30
  duration: number; // Total seconds
  format: 'webm' | 'mp4';
  bitrate: number; // bits per second

  cueAngle: number; // 30° = Math.PI/6 radians
  rotationSpeed: number; // Radians per second
  panStartY: number; // Start Y position (bottom)
  panEndY: number; // End Y position (top)

  backgroundType: 'fabric' | 'solid' | 'gradient';
  backgroundColor: string;
  fabricTextureUrl?: string;

  enableShadow: boolean;
  shadowIntensity: number;
  shadowBlur: number;
}

export interface ExtractorState {
  isExtracting: boolean;
  progress: number; // 0-100
  previewUrl: string | null;
  error: string | null;
}

export type ExtractorQuality = 'hd' | '2k';

// Default configurations
export const DEFAULT_IMAGE_CONFIG: ImageExtractorConfig = {
  width: 2048,
  height: 2048,
  format: 'png',
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
  duration: 12,
  format: 'webm',
  bitrate: 8000000, // 8 Mbps
  cueAngle: Math.PI / 6, // 30°
  rotationSpeed: Math.PI / 3, // 60° per second
  panStartY: -1.5,
  panEndY: 1.5,
  backgroundType: 'fabric',
  backgroundColor: '#2a2a2a',
  fabricTextureUrl: '/textures/studio/gray-fabric.jpg',
  enableShadow: true,
  shadowIntensity: 0.6,
  shadowBlur: 2,
};

export const QUALITY_PRESETS: Record<
  ExtractorQuality,
  Partial<VideoExtractorConfig>
> = {
  hd: { width: 1920, height: 1080, bitrate: 8000000 },
  '2k': { width: 2560, height: 1440, bitrate: 16000000 },
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
  cameraOrbitY: 0,         // Side view (no tilt) - matches main preview
  cameraDistance: 2.83,    // ~sqrt(2^2 + 2^2) - same as main preview camera
  modelOffsetX: 0,
  modelOffsetY: 0,
  zoom: 1,
  lightAngle: 0,           // HDRI rotation - no rotation by default
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
export type FrameKey = 'bottomBump' | 'centerCue' | 'topCap';

/** Frame labels for UI */
export const FRAME_LABELS: Record<FrameKey, string> = {
  bottomBump: 'Bottom Bump',
  centerCue: 'Full Cue',
  topCap: 'Top Cap',
};

// ==========================================
// Image Extractor V3 Types (Frame Editor)
// ==========================================

/** Frame transform on 2048×2048 canvas */
export interface FrameTransform {
  x: number;      // X position (px, 0-2048)
  y: number;      // Y position (px, 0-2048)
  width: number;  // Width (px)
  height: number; // Height (px)
  rotation: number; // Rotation (degrees)
}

/** HDRI layer for multi-HDRI lighting */
export interface HdriLayer {
  id: string;           // Unique ID for this layer
  hdriType: string;     // HDRI filename
  rotationX: number;    // X-axis rotation (degrees, 0-360) - vertical shift
  rotationY: number;    // Y-axis rotation (degrees, 0-360) - horizontal shift
}

/** Default HDRI layer */
export const DEFAULT_HDRI_LAYER: Omit<HdriLayer, 'id'> = {
  hdriType: 'bloem_train_track_clear_2k.hdr',
  rotationX: 0,
  rotationY: 300,  // Rotate 300° to center light in front of cue
};

/** Create a new HDRI layer with defaults */
export function createDefaultHdriLayer(hdriType?: string): HdriLayer {
  return {
    id: crypto.randomUUID(),
    hdriType: hdriType || DEFAULT_HDRI_LAYER.hdriType,
    rotationX: DEFAULT_HDRI_LAYER.rotationX,
    rotationY: DEFAULT_HDRI_LAYER.rotationY,
  };
}

/** Cue settings within a frame */
export interface CueSettings {
  spinY: number;    // Model Y-axis rotation (radians) - horizontal drag
  phi: number;      // Camera vertical orbit (radians, 0=top, PI/2=side) - vertical drag
  zoom: number;     // Zoom multiplier
  offsetX: number;  // Horizontal offset
  offsetY: number;  // Vertical offset
  hdriLayers: HdriLayer[];  // 1-2 HDRI layers with independent rotation
  // Legacy fields (for backward compatibility during migration)
  lightAngle?: number;
  hdriType?: string;
}

// ==========================================
// Image Frame Types (for overlay layers)
// ==========================================

/** Blend modes for image frames */
export type BlendMode = 
  | 'normal' 
  | 'multiply' 
  | 'screen' 
  | 'overlay' 
  | 'darken' 
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light';

/** Object fit options for images */
export type ObjectFit = 'custom' | 'cover' | 'contain';

/** 3D rotation for image frames */
export interface Rotation3D {
  x: number; // degrees, -180 to 180
  y: number; // degrees, -180 to 180
  z: number; // degrees, -180 to 180
}

/** Settings specific to image frames */
export interface ImageSettings {
  imageUrl: string | null;       // Blob/data URL while editing; storage URL after save
  backgroundColor: string;       // Hex color (#ffffff)
  backgroundEnabled: boolean;    // Show background fill behind the image
  backgroundOpacity: number;     // 0–1, opacity of the background fill layer
  objectFit: ObjectFit;
  rotation3d: Rotation3D;
  imageOpacity: number;          // 0–1, applies to the image layer only
  opacity: number;               // 0–1, whole-frame opacity (kept for compat)
  blendMode: BlendMode;
}

/** Default image settings */
export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  imageUrl: null,
  backgroundColor: '#2a2a2a',
  backgroundEnabled: true,
  backgroundOpacity: 1,
  objectFit: 'cover',
  rotation3d: { x: 0, y: 0, z: 0 },
  imageOpacity: 1,
  opacity: 1,
  blendMode: 'normal',
};

/** Frame type discriminator */
export type FrameType = 'cue' | 'image';

// ==========================================
// Frame Types (Discriminated Union)
// ==========================================

/** Base frame properties shared by all frame types */
interface BaseFrame {
  id: string;
  name?: string;   // Optional user-defined label (e.g. "Front View"); falls back to "Frame N"
  order: number;
  transform: FrameTransform;
}

/** Cue frame - displays 3D model view */
export interface CueFrame extends BaseFrame {
  frameType: 'cue';
  cue: CueSettings;
}

/** Image frame - displays uploaded image or solid color overlay */
export interface ImageFrame extends BaseFrame {
  frameType: 'image';
  imageSettings: ImageSettings;
}

/** Single frame in the editor (discriminated union) */
export type ExtractorFrame = CueFrame | ImageFrame;

/** Type guard for cue frames */
export function isCueFrame(frame: ExtractorFrame): frame is CueFrame {
  return frame.frameType === 'cue';
}

/** Type guard for image frames */
export function isImageFrame(frame: ExtractorFrame): frame is ImageFrame {
  return frame.frameType === 'image';
}

/** Saved reference (layout preset) */
export interface ExtractorReference {
  id: string;
  name: string;
  frames: ExtractorFrame[];
  createdAt?: string;
  updatedAt?: string;
}

/** Default frame transform */
export const DEFAULT_FRAME_TRANSFORM: FrameTransform = {
  x: 724,       // Centered horizontally (2048-600)/2
  y: 724,       // Centered vertically
  width: 600,
  height: 600,
  rotation: 0,
};

/** Default cue settings - matches main preview camera position */
export const DEFAULT_CUE_SETTINGS: CueSettings = {
  spinY: 0,           // Model facing front
  phi: Math.PI / 2,   // Camera at side view (90°) - same as main preview y=0
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  hdriLayers: [createDefaultHdriLayer()],  // Default: 1x bloem train track
};

/** Create a new cue frame with defaults */
export function createDefaultFrame(id?: string, order: number = 0): CueFrame {
  return {
    id: id || crypto.randomUUID(),
    order,
    frameType: 'cue',
    transform: { ...DEFAULT_FRAME_TRANSFORM },
    cue: { 
      ...DEFAULT_CUE_SETTINGS,
      hdriLayers: [createDefaultHdriLayer()],  // Fresh layer with new ID
    },
  };
}

/** Create a new image frame with defaults */
export function createDefaultImageFrame(id?: string, order: number = 0): ImageFrame {
  return {
    id: id || crypto.randomUUID(),
    order,
    frameType: 'image',
    transform: { ...DEFAULT_FRAME_TRANSFORM },
    imageSettings: { ...DEFAULT_IMAGE_SETTINGS },
  };
}

/** Migrate old CueSettings format to new format with hdriLayers */
export function migrateCueSettings(cue: CueSettings): CueSettings {
  // Already has hdriLayers - no migration needed
  if (cue.hdriLayers && cue.hdriLayers.length > 0) {
    return cue;
  }
  
  // Migrate from old format
  const layer: HdriLayer = {
    id: crypto.randomUUID(),
    hdriType: cue.hdriType || DEFAULT_HDRI_LAYER.hdriType,
    rotationX: 0,
    rotationY: cue.lightAngle || 0,
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
    id: 'frame-1',
    order: 0,
    frameType: 'cue',
    transform: { x: 524, y: 524, width: 1000, height: 1000, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 1.2, hdriLayers: [createDefaultHdriLayer()] },
  },
];

/** Template for 2 frames side by side */
export const TEMPLATE_2_FRAMES: CueFrame[] = [
  {
    id: 'frame-1',
    order: 0,
    frameType: 'cue',
    transform: { x: 100, y: 524, width: 800, height: 1000, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 1.5, hdriLayers: [createDefaultHdriLayer()] },
  },
  {
    id: 'frame-2',
    order: 1,
    frameType: 'cue',
    transform: { x: 1148, y: 524, width: 800, height: 1000, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 1.5, hdriLayers: [createDefaultHdriLayer()] },
  },
];

/** Template for 3 frames diagonal (like original design) */
export const TEMPLATE_3_DIAGONAL: CueFrame[] = [
  {
    id: 'frame-bottom',
    order: 0,
    frameType: 'cue',
    transform: { x: 100, y: 1448, width: 500, height: 500, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 2.5, hdriLayers: [createDefaultHdriLayer()] },
  },
  {
    id: 'frame-center',
    order: 1,
    frameType: 'cue',
    transform: { x: 574, y: 374, width: 900, height: 1300, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 1, hdriLayers: [createDefaultHdriLayer()] },
  },
  {
    id: 'frame-top',
    order: 2,
    frameType: 'cue',
    transform: { x: 1448, y: 100, width: 500, height: 500, rotation: 0 },
    cue: { ...DEFAULT_CUE_SETTINGS, zoom: 2.5, hdriLayers: [createDefaultHdriLayer()] },
  },
];

/** All available templates */
export const FRAME_TEMPLATES = {
  '1-frame': { name: '1 Frame', frames: TEMPLATE_1_FRAME },
  '2-frames': { name: '2 Frames', frames: TEMPLATE_2_FRAMES },
  '3-diagonal': { name: '3 Diagonal', frames: TEMPLATE_3_DIAGONAL },
} as const;

export type TemplateKey = keyof typeof FRAME_TEMPLATES;
