import { SceneManager } from "@/lib/three/scene-manager";
import { RUBBER_CONFIG, TOP_CAP_CONFIG } from "@/lib/three/leather-config";
import type { LeatherColor } from "@/types/product";

type ToneMappingMode = "agx" | "neutral";

type ExportedMeta = {
  type: "smooth" | "leather";
  surface_url?: string | null;
  texture_type?: string | null;
  texture_url?: string | null;
  color?: LeatherColor | null;
  assets?: {
    logoUrl?: string;
    bumperLogoUrl?: string;
    topCapLogoUrl?: string;
    logosEnabled?: boolean;
  };
  config?: {
    toneMapping?: ToneMappingMode;
    hdriExposure?: number;
    hdriType?: string;
    lighting?: {
      clearcoat?: number;
      bodyRoughness?: number;
    };
    leather?: {
      roughness?: number;
      sheen?: number;
      normalStrength?: number;
    };
    joint?: {
      roughness?: number;
      clearcoat?: number;
      metalness?: number;
    };
    cylinder?: {
      roughness?: number;
      clearcoat?: number;
      metalness?: number;
      color?: string;
      normalScale?: number;
      sheen?: number;
      sheenColor?: string;
    };
    textureScale?: number;
  };
};

function readJsonScript(id: string): unknown {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[cue-3d] Missing JSON script tag: #${id}`);
  const txt = (el.textContent || "").trim();
  if (!txt) throw new Error(`[cue-3d] Empty JSON in script tag: #${id}`);
  return JSON.parse(txt);
}

function asExportedMeta(value: unknown): ExportedMeta {
  // Intentionally light validation: we want the embed to be resilient.
  return value as ExportedMeta;
}

function pickLogoUrls(meta: ExportedMeta): { bumper?: string; topCap?: string } {
  const bumper = meta.assets?.bumperLogoUrl || meta.assets?.logoUrl;
  const topCap = meta.assets?.topCapLogoUrl || meta.assets?.logoUrl;
  return { bumper, topCap };
}

async function mountSingleViewer(): Promise<void> {
  const container = document.getElementById("cue-3d-viewer") as HTMLElement | null;
  if (!container) return;

  const modelUrl = container.dataset.cueModelUrl;
  if (!modelUrl) throw new Error("[cue-3d] Missing data-cue-model-url on #cue-3d-viewer");

  const meta = asExportedMeta(readJsonScript("cue-3d-config"));

  // Optional: allow Shopify to override logo URLs.
  if (meta.assets?.logosEnabled === false) {
    RUBBER_CONFIG.logo.enabled = false;
    TOP_CAP_CONFIG.logo.enabled = false;
  } else {
    const { bumper, topCap } = pickLogoUrls(meta);
    if (bumper) RUBBER_CONFIG.logo.path = bumper;
    if (topCap) TOP_CAP_CONFIG.logo.path = topCap;
  }

  const manager = new SceneManager(container);

  // Render tuning
  const toneMapping: ToneMappingMode = meta.config?.toneMapping || "agx";
  manager.updateToneMapping(toneMapping);

  manager.updateHdriExposure(Number(meta.config?.hdriExposure ?? 1.0));

  if (meta.config?.hdriType) {
    // On Shopify, pass an absolute URL to your .hdr hosted in Files/CDN.
    manager.updateHdriEnvironment(meta.config.hdriType);
  }

  // Load 3D model
  await manager.loadModel(modelUrl);

  // Apply surface
  await manager.applySurface({
    surfaceUrl: meta.surface_url ?? null,
    productType: meta.type,
    leatherColor: meta.color ?? null,
    leatherTexture: (meta.texture_type as any) ?? null,
    textureScale: meta.config?.textureScale ?? 1,
  });

  // Apply exported config (best-effort)
  if (meta.config?.lighting?.clearcoat != null) {
    manager.updateClearcoat(Number(meta.config.lighting.clearcoat));
  }
  if (meta.config?.lighting?.bodyRoughness != null) {
    manager.updateBodyRoughness(Number(meta.config.lighting.bodyRoughness));
  }

  if (meta.type === "leather" && meta.config?.leather) {
    manager.updateLeatherConfig({
      roughness: meta.config.leather.roughness,
      sheen: meta.config.leather.sheen,
      normalStrength: meta.config.leather.normalStrength,
    });
  }

  if (meta.config?.joint) {
    manager.updateJointConfig(meta.config.joint);
  }

  if (meta.config?.cylinder) {
    manager.updateCylinderConfig(meta.config.cylinder);
  }
}

function ready(fn: () => void) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

ready(() => {
  mountSingleViewer().catch((e) => {
    console.error(e);
  });
});
