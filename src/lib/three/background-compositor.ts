import * as THREE from 'three';
import type { BackgroundFrame, SurfaceConfig } from '@/types/video-studio';
import { GRADIENT_PRESETS } from '@/types/video-studio';

/**
 * Composite surface frames into a CanvasTexture.
 * Frames render bottom-to-top (array order = z-order) with position, rotation, scale, and opacity.
 */
export function compositeSurfaceFrames(
  surface: SurfaceConfig,
  width: number = 1024,
  height: number = 1024,
  loadedImages?: Map<string, HTMLImageElement>
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Fill with base color (legacy) or transparent (PBR mode uses texture pack as base)
  if (surface.baseColor) {
    ctx.fillStyle = surface.baseColor;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  // Render frames bottom-to-top (array order = z-order)
  const enabledFrames = surface.frames.filter(f => f.enabled);
  for (const frame of enabledFrames) {
    ctx.save();
    ctx.globalAlpha = frame.opacity;

    // Frame center in canvas pixels
    const cx = frame.x * width;
    const cy = frame.y * height;

    // Frame dimensions in canvas pixels
    const fw = frame.width * width;
    const fh = frame.height * height;

    // Translate to center, rotate, then draw centered
    ctx.translate(cx, cy);
    ctx.rotate((frame.rotation * Math.PI) / 180);

    if (frame.type === "color" && frame.color) {
      ctx.fillStyle = frame.color;
      ctx.fillRect(-fw / 2, -fh / 2, fw, fh);

    } else if (frame.type === "gradient" && frame.gradient) {
      const preset = GRADIENT_PRESETS.find(p => p.id === frame.gradient!.presetId);
      if (preset) {
        const angleDeg = frame.gradient.angle ?? preset.angle;
        const angleRad = (angleDeg * Math.PI) / 180;
        const len = Math.sqrt(fw * fw + fh * fh) / 2;
        const x0 = -Math.cos(angleRad) * len;
        const y0 = -Math.sin(angleRad) * len;
        const x1 = Math.cos(angleRad) * len;
        const y1 = Math.sin(angleRad) * len;

        const grad = ctx.createLinearGradient(x0, y0, x1, y1);
        if (preset.colors.length === 2) {
          grad.addColorStop(0, preset.colors[0]);
          grad.addColorStop(1, preset.colors[1]);
        } else if (preset.colors.length >= 3) {
          grad.addColorStop(0, preset.colors[0]);
          grad.addColorStop(0.5, preset.colors[1]);
          grad.addColorStop(1, preset.colors[2]);
        }
        ctx.fillStyle = grad;
        ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
      }

    } else if (frame.type === "image" && frame.imageUrl && loadedImages) {
      const img = loadedImages.get(frame.imageUrl);
      if (img) {
        ctx.drawImage(img, -fw / 2, -fh / 2, fw, fh);
      }
    }

    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Preload images for image frames — returns Map<url, HTMLImageElement> */
export async function preloadFrameImages(
  frames: BackgroundFrame[]
): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>();
  const imageFrames = frames.filter(
    (f) => f.type === "image" && f.imageUrl && f.enabled
  );

  await Promise.all(
    imageFrames.map(
      (f) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            map.set(f.imageUrl!, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = f.imageUrl!;
        })
    )
  );

  return map;
}
