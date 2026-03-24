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
