import * as THREE from 'three';
import type { BackgroundLayer } from '@/types/video-studio';
import { GRADIENT_PRESETS } from '@/types/video-studio';

/** Map BlendMode string to Canvas2D globalCompositeOperation */
function mapBlendMode(mode: string): GlobalCompositeOperation {
  const map: Record<string, GlobalCompositeOperation> = {
    normal: "source-over",
    multiply: "multiply",
    screen: "screen",
    overlay: "overlay",
    darken: "darken",
    lighten: "lighten",
    "color-dodge": "color-dodge",
    "color-burn": "color-burn",
    "hard-light": "hard-light",
    "soft-light": "soft-light",
  };
  return map[mode] || "source-over";
}

/** Map BlendMode to THREE.Blending for 3D mesh material */
export function mapThreeBlendMode(mode: string): THREE.Blending {
  if (mode === "additive") return THREE.AdditiveBlending;
  if (mode === "multiply") return THREE.MultiplyBlending;
  return THREE.NormalBlending;
}

/**
 * Composite background layers into a CanvasTexture.
 * Layers composite bottom-to-top using Canvas2D blend modes.
 */
export function compositeBackgroundLayers(
  layers: BackgroundLayer[],
  width: number = 1024,
  height: number = 1024,
  loadedImages?: Map<string, HTMLImageElement>
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  ctx.clearRect(0, 0, width, height);

  const enabledLayers = layers.filter((l) => l.enabled);

  for (const layer of enabledLayers) {
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = mapBlendMode(layer.blendMode);

    if (layer.type === "color" && layer.color) {
      ctx.fillStyle = layer.color;
      ctx.fillRect(0, 0, width, height);

    } else if (layer.type === "gradient" && layer.gradient) {
      const preset = GRADIENT_PRESETS.find((p) => p.id === layer.gradient!.presetId);
      if (preset) {
        const angleDeg = layer.gradient.angle ?? preset.angle;
        const angleRad = (angleDeg * Math.PI) / 180;
        const cx = width / 2;
        const cy = height / 2;
        const len = Math.sqrt(width * width + height * height) / 2;
        const x0 = cx - Math.cos(angleRad) * len;
        const y0 = cy - Math.sin(angleRad) * len;
        const x1 = cx + Math.cos(angleRad) * len;
        const y1 = cy + Math.sin(angleRad) * len;

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
        ctx.fillRect(0, 0, width, height);
      }

    } else if (layer.type === "image" && layer.imageUrl && loadedImages) {
      const img = loadedImages.get(layer.imageUrl);
      if (img) {
        drawImageWithFit(ctx, img, width, height, layer.objectFit || "cover");
      }
    }

    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function drawImageWithFit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cw: number,
  ch: number,
  fit: string
) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  if (fit === "cover") {
    const scale = Math.max(cw / iw, ch / ih);
    const sw = iw * scale;
    const sh = ih * scale;
    ctx.drawImage(img, (cw - sw) / 2, (ch - sh) / 2, sw, sh);
  } else if (fit === "contain") {
    const scale = Math.min(cw / iw, ch / ih);
    const sw = iw * scale;
    const sh = ih * scale;
    ctx.drawImage(img, (cw - sw) / 2, (ch - sh) / 2, sw, sh);
  } else {
    // "custom" — stretch to fill
    ctx.drawImage(img, 0, 0, cw, ch);
  }
}

/** Preload images for image layers — returns Map<url, HTMLImageElement> */
export async function preloadLayerImages(
  layers: BackgroundLayer[]
): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>();
  const imageLayers = layers.filter(
    (l) => l.type === "image" && l.imageUrl && l.enabled
  );

  await Promise.all(
    imageLayers.map(
      (l) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            map.set(l.imageUrl!, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = l.imageUrl!;
        })
    )
  );

  return map;
}
