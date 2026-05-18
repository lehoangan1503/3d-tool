import * as THREE from 'three';
import type { BackgroundFrame, SurfaceConfig } from '@/types/video-studio';
import { GRADIENT_PRESETS } from '@/types/video-studio';

// ── Helper: draw a single frame onto a 2D canvas context ──

function drawFrameToContext(
  ctx: CanvasRenderingContext2D,
  frame: BackgroundFrame,
  fw: number,
  fh: number,
  outerOpacity: number,
  loadedImages?: Map<string, HTMLImageElement>
): void {
  if (frame.type) {
    // ── Legacy format (type === "color" | "gradient" | "image") ──
    ctx.globalAlpha = outerOpacity;
    if (frame.type === "color" && frame.color) {
      ctx.fillStyle = frame.color;
      ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
    } else if (frame.type === "gradient" && frame.gradient) {
      const preset = GRADIENT_PRESETS.find(p => p.id === frame.gradient!.presetId);
      if (preset) {
        const angleDeg = frame.gradient.angle ?? preset.angle;
        const angleRad = (angleDeg * Math.PI) / 180;
        const len = Math.sqrt(fw * fw + fh * fh) / 2;
        const grad = ctx.createLinearGradient(
          -Math.cos(angleRad) * len, -Math.sin(angleRad) * len,
          Math.cos(angleRad) * len, Math.sin(angleRad) * len
        );
        preset.colors.forEach((c, i) => grad.addColorStop(i / (preset.colors.length - 1), c));
        ctx.fillStyle = grad;
        ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
      }
    } else if (frame.type === "image" && frame.imageUrl && loadedImages) {
      const img = loadedImages.get(frame.imageUrl);
      if (img) ctx.drawImage(img, -fw / 2, -fh / 2, fw, fh);
    }
  } else {
    // ── New format: background layer + image layer ──
    if (frame.backgroundEnabled !== false) {
      ctx.globalAlpha = outerOpacity * (frame.backgroundOpacity ?? 1);
      if (frame.backgroundType === "gradient" && frame.backgroundGradient) {
        const g = frame.backgroundGradient;
        const angleRad = (g.angle * Math.PI) / 180;
        const len = Math.sqrt(fw * fw + fh * fh) / 2;
        const grad = ctx.createLinearGradient(
          -Math.cos(angleRad) * len, -Math.sin(angleRad) * len,
          Math.cos(angleRad) * len, Math.sin(angleRad) * len
        );
        g.colors.forEach((c, i) => grad.addColorStop(i / Math.max(g.colors.length - 1, 1), c));
        ctx.fillStyle = grad;
        ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
      } else {
        ctx.fillStyle = frame.backgroundColor ?? "#1a1a1a";
        ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
      }
    }
    if (frame.imageUrl && loadedImages) {
      const img = loadedImages.get(frame.imageUrl);
      if (img) {
        ctx.globalAlpha = outerOpacity * (frame.imageOpacity ?? 1);
        ctx.drawImage(img, -fw / 2, -fh / 2, fw, fh);
      }
    }
  }
}

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

    // Frame center in canvas pixels
    const cx = frame.x * width;
    const cy = frame.y * height;

    // Frame dimensions in canvas pixels
    const fw = frame.width * width;
    const fh = frame.height * height;

    // Translate to center, rotate, then draw centered
    ctx.translate(cx, cy);
    ctx.rotate((frame.rotation * Math.PI) / 180);

    drawFrameToContext(ctx, frame, fw, fh, frame.opacity, loadedImages);

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
  // Collect all URLs from both legacy (type === "image") and new format (imageUrl present)
  const urlsToLoad = frames
    .filter(f => f.enabled && f.imageUrl)
    .map(f => f.imageUrl!);

  await Promise.all(
    urlsToLoad.map(
      (url) =>
        new Promise<void>((resolve) => {
          if (map.has(url)) { resolve(); return; }
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => { map.set(url, img); resolve(); };
          img.onerror = () => resolve();
          img.src = url;
        })
    )
  );

  return map;
}
