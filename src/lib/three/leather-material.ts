/**
 * LEATHER MATERIAL MODULE
 * Creates Three.js materials for leather and standard products
 */

import * as THREE from "three";
import { LEATHER_CONFIG, RUBBER_CONFIG, TOP_CAP_CONFIG, getLeatherTexturePath, isTopCapFaceMaterial } from "./leather-config";
import { LEATHER_FRAME } from "./leather-frame";
import { createLeatherRoughnessMap, createLeatherClearcoatMap } from "./leather-overlay";
import { generateLeatherBumpMap, type LeatherBumpResult } from "./procedural";
import { CUE_LOGO_OPTIONS, type CueLogoId } from "@/types/product";

// =====================================================
// LOGO IMAGES
// =====================================================

type LogoImageSource = HTMLImageElement | HTMLCanvasElement;

let bumperLogoImage: LogoImageSource | null = null;
let bumperLogoPromise: Promise<LogoImageSource | null> | null = null;

let topCapLogoImage: LogoImageSource | null = null;
let topCapLogoPromise: Promise<LogoImageSource | null> | null = null;

const logoImageCache = new Map<string, Promise<HTMLImageElement | null>>();
const logoImages = new Map<CueLogoId, HTMLImageElement>();
const materialLogoTextures = new WeakMap<THREE.Material, THREE.Texture>();

function loadLogoImage(logoId: CueLogoId, overridePath?: string): Promise<HTMLImageElement | null> {
  const option = CUE_LOGO_OPTIONS.find((item) => item.id === logoId) ?? CUE_LOGO_OPTIONS[0];
  const path = overridePath || option.path;
  const cacheKey = `${logoId}|${path}`;
  const cached = logoImageCache.get(cacheKey);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      logoImages.set(logoId, img);
      resolve(img);
    };
    img.onerror = () => {
      console.warn("[Logo] Unable to load", path);
      resolve(null);
    };
    img.src = path;
  });
  logoImageCache.set(cacheKey, promise);
  return promise;
}

// =====================================================
// PROCEDURAL LEATHER TEXTURE CACHE
// =====================================================

let proceduralLeatherCache: LeatherBumpResult | null = null;
let proceduralCacheKey: string = "";

/**
 * Generate procedural leather textures (cached)
 */
export function generateProceduralLeatherTexture(forceRegenerate = false): LeatherBumpResult | null {
  const config = LEATHER_CONFIG.procedural;
  if (!config.enabled) return null;

  // Create cache key from config (include new realistic leather settings)
  const cacheKey = JSON.stringify({
    globalScale: config.globalScale,
    // New realistic grain settings
    grainScale: config.grainScale,
    grainBlackPoint: config.grainBlackPoint,
    grainWhitePoint: config.grainWhitePoint,
    grainBumpStrength: config.grainBumpStrength,
    edgeCracksScale: config.edgeCracksScale,
    edgeWidth: config.edgeWidth,
    edgeCracksBumpStrength: config.edgeCracksBumpStrength,
    grainVariationScale: config.grainVariationScale,
    grainVariationBumpStrength: config.grainVariationBumpStrength,
    fineSurfaceScale: config.fineSurfaceScale,
    fineSurfaceDetail: config.fineSurfaceDetail,
    fineSurfaceBumpStrength: config.fineSurfaceBumpStrength,
    largeCreasesScale: config.largeCreasesScale,
    largeCreasesDetail: config.largeCreasesDetail,
    largeCreasesBumpStrength: config.largeCreasesBumpStrength,
    useDualBump: config.useDualBump,
    macroBumpStrength: config.macroBumpStrength,
    microBumpStrength: config.microBumpStrength,
    // Legacy fields
    cracksScale: config.cracksScale,
    cracksBumpStrength: config.cracksBumpStrength,
    dotsScale: config.dotsScale,
    dotsBumpStrength: config.dotsBumpStrength,
    surfaceScale: config.surfaceScale,
    surfaceBumpStrength: config.surfaceBumpStrength,
    textureResolution: config.textureResolution,
    normalStrength: config.normalStrength,
  });

  // Return cached if available and not forcing regeneration
  if (proceduralLeatherCache && proceduralCacheKey === cacheKey && !forceRegenerate) {
    console.log("[ProceduralLeather] Using cached texture");
    return proceduralLeatherCache;
  }

  console.log("[ProceduralLeather] Generating realistic procedural leather texture...");
  const startTime = performance.now();

  proceduralLeatherCache = generateLeatherBumpMap({
    width: config.textureResolution,
    height: config.textureResolution,
    globalScale: config.globalScale,
    // New realistic grain settings
    grainScale: config.grainScale,
    grainBlackPoint: config.grainBlackPoint,
    grainWhitePoint: config.grainWhitePoint,
    grainBumpStrength: config.grainBumpStrength,
    edgeCracksScale: config.edgeCracksScale,
    edgeWidth: config.edgeWidth,
    edgeCracksBumpStrength: config.edgeCracksBumpStrength,
    grainVariationScale: config.grainVariationScale,
    grainVariationBumpStrength: config.grainVariationBumpStrength,
    fineSurfaceScale: config.fineSurfaceScale,
    fineSurfaceDetail: config.fineSurfaceDetail,
    fineSurfaceBumpStrength: config.fineSurfaceBumpStrength,
    largeCreasesScale: config.largeCreasesScale,
    largeCreasesDetail: config.largeCreasesDetail,
    largeCreasesBumpStrength: config.largeCreasesBumpStrength,
    useDualBump: config.useDualBump,
    macroBumpStrength: config.macroBumpStrength,
    microBumpStrength: config.microBumpStrength,
    // Legacy fields (for compatibility)
    cracksScale: config.cracksScale,
    cracksBumpStrength: config.cracksBumpStrength,
    dotsScale: config.dotsScale,
    dotsBumpStrength: config.dotsBumpStrength,
    surfaceScale: config.surfaceScale,
    surfaceBumpStrength: config.surfaceBumpStrength,
    normalStrength: config.normalStrength,
    noiseScale: config.noiseScale,
    noiseDetail: config.noiseDetail,
  });
  proceduralCacheKey = cacheKey;

  const elapsed = performance.now() - startTime;
  console.log(`[ProceduralLeather] ✅ Generated realistic leather in ${elapsed.toFixed(0)}ms`);

  return proceduralLeatherCache;
}

/**
 * Clear procedural texture cache
 */
export function clearProceduralCache(): void {
  proceduralLeatherCache = null;
  proceduralCacheKey = "";
  console.log("[ProceduralLeather] Cache cleared");
}

// =====================================================
// LEATHER NORMAL MAP (static image fallback)
// =====================================================

let leatherNormalImage: HTMLImageElement | null = null;
let leatherNormalLoaded = false;
let leatherNormalPromise: Promise<HTMLImageElement | null> | null = null;

/**
 * Load leather normal map image (fallback when procedural disabled)
 */
export function loadLeatherNormal(textureKey: string = "crocodile", forceReload = false): Promise<HTMLImageElement | null> {
  if (leatherNormalPromise && !forceReload) return leatherNormalPromise;

  if (forceReload) {
    leatherNormalImage = null;
    leatherNormalLoaded = false;
    leatherNormalPromise = null;
  }

  const normalPath = getLeatherTexturePath(textureKey);
  console.log("[Leather] Loading normal map:", normalPath);

  leatherNormalPromise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      leatherNormalImage = img;
      leatherNormalLoaded = true;
      console.log("[Leather] ✅ Normal map loaded:", img.width, "x", img.height);
      resolve(img);
    };
    img.onerror = () => {
      console.warn("[Leather] ⚠️ Normal map not found, skipping");
      leatherNormalLoaded = true;
      resolve(null);
    };
    img.src = normalPath;
  });

  return leatherNormalPromise;
}

/**
 * Check if leather normal is loaded
 */
export function isLeatherNormalLoaded(): boolean {
  return leatherNormalLoaded;
}

/**
 * Get leather normal image
 */
export function getLeatherNormalImage(): HTMLImageElement | null {
  return leatherNormalImage;
}

// =====================================================
// CREATE NORMAL MAP CANVAS
// =====================================================

/**
 * Create normalMap canvas with leather normal in leather region
 * Uses procedural generation when enabled, falls back to static image
 * @param width - Output canvas width
 * @param height - Output canvas height
 * @param textureScale - How many times to tile the texture (1 = no tiling, 2 = 2x2, etc.)
 * @param useProcedural - Force procedural or static texture (defaults to config)
 */
export function createNormalMap(width: number, height: number, textureScale: number = 1, useProcedural?: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Default: flat normal (neutral blue)
  ctx.fillStyle = "rgb(128, 128, 255)";
  ctx.fillRect(0, 0, width, height);

  // Determine which texture source to use
  const useProceduralTexture = useProcedural ?? LEATHER_CONFIG.procedural.enabled;

  // Try procedural texture first if enabled
  if (useProceduralTexture) {
    const proceduralResult = generateProceduralLeatherTexture();
    if (proceduralResult) {
      const scaleY = height / LEATHER_FRAME.surfaceHeight;
      const leatherY = Math.floor(LEATHER_FRAME.y * scaleY);
      const leatherHeight = Math.floor(LEATHER_FRAME.height * scaleY);
      const leatherEndY = leatherY + leatherHeight;

      // Use procedural normal map
      const normalCanvas = proceduralResult.normalMapCanvas;

      // Create temp canvas for leather normal with tiling
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = width;
      tempCanvas.height = height;
      const tempCtx = tempCanvas.getContext("2d")!;

      tempCtx.fillStyle = "rgb(128, 128, 255)";
      tempCtx.fillRect(0, 0, width, height);

      // Tile the procedural normal map in leather region
      if (textureScale > 1) {
        const tileWidth = Math.ceil(width / textureScale);
        const tileHeight = Math.ceil(leatherHeight / textureScale);

        // Scale down procedural texture to tile size
        const patternCanvas = document.createElement("canvas");
        patternCanvas.width = tileWidth;
        patternCanvas.height = tileHeight;
        const patternCtx = patternCanvas.getContext("2d")!;
        patternCtx.drawImage(normalCanvas, 0, 0, tileWidth, tileHeight);

        const pattern = tempCtx.createPattern(patternCanvas, "repeat");
        if (pattern) {
          tempCtx.save();
          tempCtx.translate(0, leatherY);
          tempCtx.fillStyle = pattern;
          tempCtx.fillRect(0, 0, width, leatherHeight);
          tempCtx.restore();
        }
        console.log(`[NormalMap] Applied procedural tiled texture (${textureScale}x scale)`);
      } else {
        // Stretch procedural texture to fit leather region
        tempCtx.drawImage(normalCanvas, 0, leatherY, width, leatherHeight);
      }

      // Apply soft edge mask
      applyLeatherMask(tempCtx, width, height, leatherY, leatherHeight, leatherEndY);

      // Draw onto main canvas
      ctx.drawImage(tempCanvas, 0, 0);
      console.log("[NormalMap] ✅ Applied PROCEDURAL normal to region:", leatherY, "-", leatherEndY);

      return canvas;
    }
  }

  // Fallback to static leather normal image
  if (leatherNormalImage) {
    const scaleY = height / LEATHER_FRAME.surfaceHeight;
    const leatherY = Math.floor(LEATHER_FRAME.y * scaleY);
    const leatherHeight = Math.floor(LEATHER_FRAME.height * scaleY);
    const leatherEndY = leatherY + leatherHeight;

    // Create temp canvas for leather normal with tiling
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext("2d")!;

    tempCtx.fillStyle = "rgb(128, 128, 255)";
    tempCtx.fillRect(0, 0, width, height);

    // If textureScale > 1, tile the normal map texture
    if (textureScale > 1) {
      // Create a tiled pattern canvas for the leather region
      const patternCanvas = document.createElement("canvas");
      const tileWidth = Math.ceil(width / textureScale);
      const tileHeight = Math.ceil(leatherHeight / textureScale);
      patternCanvas.width = tileWidth;
      patternCanvas.height = tileHeight;
      const patternCtx = patternCanvas.getContext("2d")!;

      // Draw the normal texture scaled down to tile size
      patternCtx.drawImage(leatherNormalImage, 0, 0, tileWidth, tileHeight);

      // Create pattern and fill the leather region
      const pattern = tempCtx.createPattern(patternCanvas, "repeat");
      if (pattern) {
        tempCtx.save();
        tempCtx.translate(0, leatherY);
        tempCtx.fillStyle = pattern;
        tempCtx.fillRect(0, 0, width, leatherHeight);
        tempCtx.restore();
      }

      console.log(`[NormalMap] Applied tiled static texture (${textureScale}x scale, tile: ${tileWidth}x${tileHeight})`);
    } else {
      // Original: stretch texture to fit leather region
      tempCtx.drawImage(leatherNormalImage, 0, leatherY, width, leatherHeight);
    }

    // Apply soft edge mask
    applyLeatherMask(tempCtx, width, height, leatherY, leatherHeight, leatherEndY);

    // Draw masked leather normal onto main canvas
    ctx.drawImage(tempCanvas, 0, 0);

    console.log("[NormalMap] Applied static leather normal to region:", leatherY, "-", leatherEndY);
  }

  return canvas;
}

/**
 * Apply soft edge mask to leather region
 */
function applyLeatherMask(ctx: CanvasRenderingContext2D, width: number, height: number, leatherY: number, leatherHeight: number, leatherEndY: number): void {
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext("2d")!;

  const featherSize = 8;
  maskCtx.clearRect(0, 0, width, height);
  maskCtx.fillStyle = "rgba(255, 255, 255, 1)";
  maskCtx.fillRect(0, leatherY + featherSize, width, leatherHeight - featherSize * 2);

  // Top edge gradient
  const topGrad = maskCtx.createLinearGradient(0, leatherY, 0, leatherY + featherSize);
  topGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
  topGrad.addColorStop(1, "rgba(255, 255, 255, 1)");
  maskCtx.fillStyle = topGrad;
  maskCtx.fillRect(0, leatherY, width, featherSize);

  // Bottom edge gradient
  const bottomGrad = maskCtx.createLinearGradient(0, leatherEndY - featherSize, 0, leatherEndY);
  bottomGrad.addColorStop(0, "rgba(255, 255, 255, 1)");
  bottomGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  maskCtx.fillStyle = bottomGrad;
  maskCtx.fillRect(0, leatherEndY - featherSize, width, featherSize);

  // Apply mask
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = "source-over";
}

// =====================================================
// CREATE LEATHER TEXTURE MAPS
// =====================================================

export interface LeatherTextureMaps {
  roughnessTexture: THREE.CanvasTexture;
  clearcoatTexture: THREE.CanvasTexture;
  normalTexture: THREE.CanvasTexture;
}

/**
 * Create all texture maps for leather material
 * @param width - Texture width
 * @param height - Texture height
 * @param bodyRoughness - Roughness for non-leather body areas (0-255, default 10)
 * @param textureScale - How many times to tile the normal texture (1 = no tiling, 2+ = repeated)
 */
export function createLeatherTextureMaps(width: number, height: number, bodyRoughness: number = 10, textureScale: number = 1): LeatherTextureMaps {
  const roughnessCanvas = createLeatherRoughnessMap(width, height, LEATHER_CONFIG.roughness, bodyRoughness);
  const roughnessTexture = new THREE.CanvasTexture(roughnessCanvas);
  roughnessTexture.flipY = false;
  // Roughness maps are data textures - use NoColorSpace to prevent color space conversion
  roughnessTexture.colorSpace = THREE.NoColorSpace;
  roughnessTexture.wrapS = THREE.RepeatWrapping;
  roughnessTexture.wrapT = THREE.ClampToEdgeWrapping;
  roughnessTexture.needsUpdate = true;
  console.log("[LeatherTextureMaps] Created roughnessMap with leatherRoughness:", LEATHER_CONFIG.roughness, "bodyRoughness:", bodyRoughness);

  const clearcoatCanvas = createLeatherClearcoatMap(width, height, LEATHER_CONFIG.clearcoat);
  const clearcoatTexture = new THREE.CanvasTexture(clearcoatCanvas);
  clearcoatTexture.flipY = false;
  // Clearcoat maps are data textures - use NoColorSpace to prevent color space conversion
  clearcoatTexture.colorSpace = THREE.NoColorSpace;
  clearcoatTexture.wrapS = THREE.RepeatWrapping;
  clearcoatTexture.wrapT = THREE.ClampToEdgeWrapping;
  clearcoatTexture.needsUpdate = true;

  const normalCanvas = createNormalMap(width, height, textureScale);
  const normalTexture = new THREE.CanvasTexture(normalCanvas);
  normalTexture.flipY = false;
  // Normal maps are data textures - use NoColorSpace to prevent color space conversion
  normalTexture.colorSpace = THREE.NoColorSpace;
  normalTexture.wrapS = THREE.RepeatWrapping;
  normalTexture.wrapT = THREE.ClampToEdgeWrapping;
  normalTexture.needsUpdate = true;

  return {
    roughnessTexture,
    clearcoatTexture,
    normalTexture,
  };
}

// =====================================================
// CREATE MATERIALS
// =====================================================

/**
 * Create MeshPhysicalMaterial for leather products
 * Based on Blender Principled BSDF settings from setting.md:
 * - Base Roughness: 0.35-0.45 with variation
 * - Sheen: 0.3-0.5 (important for leather!)
 * - Sheen Tint: 0.2-0.4
 * - IOR: 1.45-1.5
 */
export function createLeatherMaterial(mapTexture: THREE.Texture, textureMaps: LeatherTextureMaps): THREE.MeshPhysicalMaterial {
  const { roughnessTexture, clearcoatTexture, normalTexture } = textureMaps;

  console.log("[createLeatherMaterial] Creating realistic leather material with:", {
    roughnessMapExists: !!roughnessTexture,
    clearcoatMapExists: !!clearcoatTexture,
    normalMapExists: !!normalTexture,
    normalScale: { x: LEATHER_CONFIG.normalScaleX, y: LEATHER_CONFIG.normalScaleY },
  });

  // Realistic leather material based on setting.md Principled BSDF specs
  return new THREE.MeshPhysicalMaterial({
    map: mapTexture,
    color: new THREE.Color(0xffffff),

    // Roughness: Base 0.4 with variation from roughness map
    roughnessMap: roughnessTexture,
    roughness: 0.4, // Base roughness (0.35-0.45 for premium cowhide)

    metalness: 0.0,

    // Clearcoat: Minimal for matte leather (0.0), more for finished leather (0.1-0.3)
    clearcoat: 0.1, // Subtle clear coat
    clearcoatMap: clearcoatTexture,
    clearcoatRoughness: 0.3, // Rougher clearcoat for matte look

    // Reflectivity and IOR
    reflectivity: 0.5, // Specular: 0.5 from settings
    ior: 1.47, // IOR: 1.45-1.5 from settings

    // Environment reflection
    envMapIntensity: 0.35,

    // SHEEN - Critical for realistic leather! (setting.md emphasizes this)
    sheen: 0.4, // Sheen: 0.3-0.5 (important for leather!)
    sheenRoughness: 0.5, // Controls sheen softness
    sheenColor: new THREE.Color(0x8b7355), // Warm brown tint (Sheen Tint: 0.2-0.4)

    // Normal map with proper scale
    normalMap: normalTexture,
    normalScale: new THREE.Vector2(LEATHER_CONFIG.normalScaleX, LEATHER_CONFIG.normalScaleY),
  });
}

/**
 * Create MeshPhysicalMaterial for standard products (glass-like)
 */
export function createStandardMaterial(mapTexture: THREE.Texture): THREE.MeshPhysicalMaterial {
  const cfg = LEATHER_CONFIG.nonLeather;

  return new THREE.MeshPhysicalMaterial({
    map: mapTexture,
    color: new THREE.Color(0xffffff),
    roughness: cfg.roughness,
    metalness: 0.0,
    clearcoat: cfg.clearcoat,
    clearcoatRoughness: cfg.clearcoatRoughness,
    reflectivity: cfg.reflectivity,
    ior: cfg.ior,
    thickness: cfg.thickness,
    specularIntensity: cfg.specularIntensity,
    specularColor: new THREE.Color(0xffffff),
    sheen: 0.3,
    sheenRoughness: 0.2,
    sheenColor: new THREE.Color(0xffffff),
    transparent: false,
  });
}

// =====================================================
// RUBBER MATERIAL (Bumper at bottom)
// =====================================================

/**
 * Load bumper logo image
 */
export function loadBumperLogo(logoId: CueLogoId = "uni"): Promise<LogoImageSource | null> {
  if (!RUBBER_CONFIG.logo.enabled) return Promise.resolve(null);
  const overridePath = logoId === "uni" && RUBBER_CONFIG.logo.path !== "/logo.png" ? RUBBER_CONFIG.logo.path : undefined;
  bumperLogoPromise = loadLogoImage(logoId, overridePath).then((img) => {
    bumperLogoImage = img ? prepareLogoSource(img, logoId) : null;
    return bumperLogoImage;
  });

  return bumperLogoPromise;
}

/**
 * Draw rubber bumper logo onto a canvas context (no background fill)
 */
function drawRubberLogoOnCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  if (!bumperLogoImage || !RUBBER_CONFIG.logo.enabled) return;

  const logoScale = RUBBER_CONFIG.logo.scale;
  const logoW = width * logoScale;
  const logoH = (bumperLogoImage.height / bumperLogoImage.width) * logoW;
  const offsetX = (RUBBER_CONFIG.logo.offsetX || 0) * width;
  const offsetY = (RUBBER_CONFIG.logo.offsetY || 0) * height;
  const logoX = (width - logoW) / 2 + offsetX;
  const logoY = (height - logoH) / 2 + offsetY;

  // Create colored logo
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = bumperLogoImage.width;
  colorCanvas.height = bumperLogoImage.height;
  const colorCtx = colorCanvas.getContext("2d")!;
  colorCtx.drawImage(bumperLogoImage, 0, 0);

  // Apply logo color
  const logoColor = RUBBER_CONFIG.logo.color || "#cfd3d6";
  colorCtx.globalCompositeOperation = "source-in";
  colorCtx.fillStyle = logoColor;
  colorCtx.fillRect(0, 0, colorCanvas.width, colorCanvas.height);

  // Draw logo with optional flip
  ctx.save();
  ctx.globalAlpha = RUBBER_CONFIG.logo.opacity || 1.0;

  if (RUBBER_CONFIG.logo.flipX || RUBBER_CONFIG.logo.flipY) {
    ctx.translate(logoX + logoW / 2, logoY + logoH / 2);
    ctx.scale(RUBBER_CONFIG.logo.flipX ? -1 : 1, RUBBER_CONFIG.logo.flipY ? -1 : 1);
    ctx.drawImage(colorCanvas, -logoW / 2, -logoH / 2, logoW, logoH);
  } else {
    ctx.drawImage(colorCanvas, logoX, logoY, logoW, logoH);
  }

  ctx.restore();
  console.log("[Rubber] Logo drawn at:", logoX, logoY, logoW, logoH);
}

// /**
//  * Create diffuse texture for rubber with logo (replaced by applyLogoToExistingMaterial)
//  */
// export function createRubberDiffuseWithLogo(width = 512, height = 512): THREE.CanvasTexture {
//   const canvas = document.createElement("canvas");
//   canvas.width = width;
//   canvas.height = height;
//   const ctx = canvas.getContext("2d")!;
//   ctx.fillStyle = RUBBER_CONFIG.backgroundColor;
//   ctx.fillRect(0, 0, width, height);
//   drawRubberLogoOnCanvas(ctx, width, height);
//   const texture = new THREE.CanvasTexture(canvas);
//   texture.colorSpace = THREE.SRGBColorSpace;
//   texture.flipY = false;
//   texture.needsUpdate = true;
//   return texture;
// }

// /**
//  * Create MeshPhysicalMaterial for rubber bumper
//  * DEPRECATED: Now we keep the original GLB material and only apply the logo overlay
//  */
// export function createRubberMaterial(width = 512, height = 512): THREE.MeshPhysicalMaterial {
//   const mapTexture = createRubberDiffuseWithLogo(width, height);
//   return new THREE.MeshPhysicalMaterial({
//     map: mapTexture,
//     color: new THREE.Color(0xffffff),
//     roughness: RUBBER_CONFIG.roughness,
//     metalness: RUBBER_CONFIG.metalness,
//     clearcoat: RUBBER_CONFIG.clearcoat,
//     clearcoatRoughness: 0.94,
//     reflectivity: RUBBER_CONFIG.reflectivity,
//     ior: 1.45,
//     specularIntensity: 0.19,
//     specularColor: new THREE.Color(0x2a2a2a),
//     sheen: 0.0,
//     sheenRoughness: 1.0,
//     sheenColor: new THREE.Color(0x222222),
//     transparent: false,
//   });
// }

// =====================================================
// TOP CAP MATERIAL (Joint cover at top)
// =====================================================

/**
 * Load top cap logo image
 */
export function loadTopCapLogo(logoId: CueLogoId = "uni"): Promise<LogoImageSource | null> {
  if (!TOP_CAP_CONFIG.logo.enabled) return Promise.resolve(null);
  const overridePath = logoId === "uni" && TOP_CAP_CONFIG.logo.path !== "/logo.png" ? TOP_CAP_CONFIG.logo.path : undefined;
  topCapLogoPromise = loadLogoImage(logoId, overridePath).then((img) => {
    topCapLogoImage = img ? prepareLogoSource(img, logoId) : null;
    return topCapLogoImage;
  });

  return topCapLogoPromise;
}

/**
 * Draw top cap face logo onto a canvas context (no background fill)
 * UV is a simple quad: U: 0.01-0.49, V: 0.51-0.99, center at (0.25, 0.75)
 */
function drawTopCapFaceLogoOnCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  if (!topCapLogoImage || !TOP_CAP_CONFIG.logo.enabled) return;

  const logoScale = TOP_CAP_CONFIG.logo.scale;
  const logoW = width * logoScale;
  const logoH = (topCapLogoImage.height / topCapLogoImage.width) * logoW;

  // UV center is at (0.25, 0.75) for the top_cap face
  const uvCenterX = 0.25;
  const uvCenterY = 0.75;

  const logoX = width * uvCenterX - logoW / 2;
  const logoY = height * uvCenterY - logoH / 2;

  // Create colored logo
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = topCapLogoImage.width;
  colorCanvas.height = topCapLogoImage.height;
  const colorCtx = colorCanvas.getContext("2d")!;
  colorCtx.drawImage(topCapLogoImage, 0, 0);

  // Apply logo color
  const logoColor = TOP_CAP_CONFIG.logo.color || "#4a4a4a";
  colorCtx.globalCompositeOperation = "source-in";
  colorCtx.fillStyle = logoColor;
  colorCtx.fillRect(0, 0, colorCanvas.width, colorCanvas.height);

  // Draw logo
  ctx.save();
  ctx.globalAlpha = TOP_CAP_CONFIG.logo.opacity || 1.0;
  ctx.drawImage(colorCanvas, logoX, logoY, logoW, logoH);
  ctx.restore();

  console.log("[TopCapFace] Logo drawn at UV center (0.25, 0.75), canvas pos:", logoX.toFixed(0), logoY.toFixed(0));
}

// /**
//  * Create texture with logo for top cap BODY (cylindrical part)
//  * DEPRECATED: Now we keep the original GLB material texture
//  */
// export function createTopCapTextureWithLogo(width = 512, height = 512): THREE.CanvasTexture {
//   const canvas = document.createElement("canvas");
//   canvas.width = width;
//   canvas.height = height;
//   const ctx = canvas.getContext("2d")!;
//   ctx.fillStyle = "#2a2a2a";
//   ctx.fillRect(0, 0, width, height);
//   const texture = new THREE.CanvasTexture(canvas);
//   texture.colorSpace = THREE.SRGBColorSpace;
//   texture.flipY = false;
//   texture.needsUpdate = true;
//   return texture;
// }

// /**
//  * Create texture with logo for top cap FACE (flat top circle)
//  * DEPRECATED: Now we keep the original GLB material texture and only overlay the logo
//  */
// export function createTopCapFaceTextureWithLogo(width = 512, height = 512): THREE.CanvasTexture {
//   const canvas = document.createElement("canvas");
//   canvas.width = width;
//   canvas.height = height;
//   const ctx = canvas.getContext("2d")!;
//   ctx.fillStyle = "#2a2a2a";
//   ctx.fillRect(0, 0, width, height);
//   drawTopCapFaceLogoOnCanvas(ctx, width, height);
//   const texture = new THREE.CanvasTexture(canvas);
//   texture.colorSpace = THREE.SRGBColorSpace;
//   texture.flipY = false;
//   texture.needsUpdate = true;
//   return texture;
// }

// /**
//  * Create MeshPhysicalMaterial for top cap BODY (cylindrical joint cover)
//  * DEPRECATED: Now we keep the original GLB material
//  */
// export function createTopCapMaterial(width = 512, height = 512): THREE.MeshPhysicalMaterial {
//   const mapTexture = createTopCapTextureWithLogo(width, height);
//   return new THREE.MeshPhysicalMaterial({
//     map: mapTexture,
//     color: new THREE.Color(0xffffff),
//     roughness: 0.4,
//     metalness: 0,
//     clearcoat: 0.3,
//     clearcoatRoughness: 0.5,
//     reflectivity: 0.3,
//     ior: 1.45,
//     specularIntensity: 0.3,
//     specularColor: new THREE.Color(0x333333),
//     sheen: 0.0,
//     transparent: false,
//   });
// }

// /**
//  * Create MeshPhysicalMaterial for top cap FACE (flat top with logo)
//  * DEPRECATED: Now we keep the original GLB material and only overlay the logo
//  */
// export function createTopCapFaceMaterial(width = 512, height = 512): THREE.MeshPhysicalMaterial {
//   const mapTexture = createTopCapFaceTextureWithLogo(width, height);
//   return new THREE.MeshPhysicalMaterial({
//     map: mapTexture,
//     color: new THREE.Color(0xffffff),
//     roughness: 0.4,
//     metalness: 0,
//     clearcoat: 0.3,
//     clearcoatRoughness: 0.5,
//     reflectivity: 0.3,
//     ior: 1.45,
//     specularIntensity: 0.3,
//     specularColor: new THREE.Color(0x333333),
//     sheen: 0.0,
//     transparent: false,
//   });
// }

/**
 * Render a compressed texture (KTX2) to a canvas for further processing.
 * Uses an offscreen WebGL renderer to decode the GPU texture.
 */
function renderCompressedTextureToCanvas(
  compressedTexture: THREE.Texture,
  width: number,
  height: number
): HTMLCanvasElement | null {
  try {
    // Create a small offscreen renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(width, height);

    // Create a simple scene with a plane showing the texture
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
    camera.position.z = 1;

    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: compressedTexture,
      transparent: false,
    });
    const plane = new THREE.Mesh(geometry, material);
    scene.add(plane);

    // Render
    renderer.render(scene, camera);

    // Extract to canvas
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(renderer.domElement, 0, 0);

    // Cleanup
    renderer.dispose();
    geometry.dispose();
    material.dispose();

    return canvas;
  } catch (e) {
    console.warn("[renderCompressedTextureToCanvas] Failed:", e);
    return null;
  }
}

/**
 * Apply logo overlay to an existing material's map texture.
 * Keeps the original GLB texture intact and only draws the logo on top.
 *
 * NOTE: For KTX2 compressed textures, we cannot use drawImage() because
 * the image data is a CompressedTexture. Instead, we render the texture
 * to a canvas first using WebGL, or create a new texture with just the logo.
 */
function prepareLogoSource(image: HTMLImageElement, logoId: CueLogoId): LogoImageSource {
  // UNI is already a transparent PNG and must go through the exact original
  // renderer unchanged.
  if (logoId === "uni") return image;

  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, 1024 / Math.max(naturalWidth, naturalHeight));
  const source = document.createElement("canvas");
  source.width = Math.max(1, Math.round(naturalWidth * scale));
  source.height = Math.max(1, Math.round(naturalHeight * scale));
  const ctx = source.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, source.width, source.height);
  const pixels = ctx.getImageData(0, 0, source.width, source.height);
  const corners = [0, (source.width - 1) * 4, (source.height - 1) * source.width * 4, (source.width * source.height - 1) * 4];
  const background = corners.reduce((sum, index) => (
    sum + (pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2]) / 3
  ), 0) / corners.length;

  let minX = source.width;
  let minY = source.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const index = (y * source.width + x) * 4;
      const luminance = (pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2]) / 3;
      const mask = Math.min(1, Math.abs(luminance - background) / 96);
      const alpha = Math.round(mask * 255);
      pixels.data[index] = 255;
      pixels.data[index + 1] = 255;
      pixels.data[index + 2] = 255;
      pixels.data[index + 3] = alpha;
      if (mask > 0.08) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  ctx.putImageData(pixels, 0, 0);

  const cropWidth = Math.max(1, maxX - minX + 1);
  const cropHeight = Math.max(1, maxY - minY + 1);
  const cutout = document.createElement("canvas");
  cutout.width = 1024;
  cutout.height = 1024;
  const cutoutCtx = cutout.getContext("2d")!;
  const fittedScale = Math.min(920 / cropWidth, 920 / cropHeight);
  const width = cropWidth * fittedScale;
  const height = cropHeight * fittedScale;
  cutoutCtx.drawImage(source, minX, minY, cropWidth, cropHeight, (1024 - width) / 2, (1024 - height) / 2, width, height);
  return cutout;
}

function createLaserLogoMask(
  image: LogoImageSource,
  width: number,
  height: number,
  boxScale: number,
  centerX: number,
  centerY: number,
  flipY: boolean,
): THREE.CanvasTexture {
  const source = document.createElement("canvas");
  const naturalWidth = image instanceof HTMLImageElement ? (image.naturalWidth || image.width) : image.width;
  const naturalHeight = image instanceof HTMLImageElement ? (image.naturalHeight || image.height) : image.height;
  const sourceScale = Math.min(1, 1024 / Math.max(naturalWidth, naturalHeight));
  source.width = Math.max(1, Math.round(naturalWidth * sourceScale));
  source.height = Math.max(1, Math.round(naturalHeight * sourceScale));
  const sourceCtx = source.getContext("2d", { willReadFrequently: true })!;
  sourceCtx.drawImage(image, 0, 0);
  const pixels = sourceCtx.getImageData(0, 0, source.width, source.height);

  const corners = [
    0,
    (source.width - 1) * 4,
    (source.height - 1) * source.width * 4,
    (source.height * source.width - 1) * 4,
  ];
  const background = corners.reduce((sum, index) => (
    sum + (pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2]) / 3
  ), 0) / corners.length;

  let minX = source.width;
  let minY = source.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const index = (y * source.width + x) * 4;
      const alpha = pixels.data[index + 3] / 255;
      const luminance = (pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2]) / 3;
      const hasTransparency = alpha < 0.98;
      const mask = hasTransparency ? alpha : Math.min(1, Math.abs(luminance - background) / 96);
      const value = Math.round(mask * 255);
      pixels.data[index] = value;
      pixels.data[index + 1] = value;
      pixels.data[index + 2] = value;
      pixels.data[index + 3] = 255;
      if (mask > 0.08) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  sourceCtx.putImageData(pixels, 0, 0);

  const cropWidth = Math.max(1, maxX - minX + 1);
  const cropHeight = Math.max(1, maxY - minY + 1);
  const boxSize = Math.min(width, height) * boxScale;
  const fittedScale = Math.min(boxSize / cropWidth, boxSize / cropHeight);
  const drawWidth = cropWidth * fittedScale;
  const drawHeight = cropHeight * fittedScale;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(centerX * width, centerY * height);
  ctx.scale(1, flipY ? -1 : 1);
  ctx.drawImage(source, minX, minY, cropWidth, cropHeight, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function applyLaserLogo(
  mat: THREE.Material,
  type: "rubber" | "topCapFace",
  logoId: CueLogoId,
): void {
  const image = logoImages.get(logoId) ?? (type === "rubber" ? bumperLogoImage : topCapLogoImage);
  if (!image) return;

  const physMat = mat as THREE.MeshPhysicalMaterial;
  const originalMap = physMat.map;
  const width = type === "rubber" ? 1024 : 2048;
  const height = type === "rubber" ? 1024 : 2048;
  const texture = createLaserLogoMask(
    image,
    width,
    height,
    type === "rubber" ? RUBBER_CONFIG.logo.scale : TOP_CAP_CONFIG.logo.scale,
    type === "rubber" ? 0.5 : 0.25,
    type === "rubber" ? 0.5 : 0.75,
    type === "rubber" ? RUBBER_CONFIG.logo.flipY : false,
  );

  if (type === "rubber") {
    texture.channel = originalMap?.channel ?? 1;
    texture.flipY = originalMap?.flipY ?? false;
    texture.wrapS = originalMap?.wrapS ?? THREE.RepeatWrapping;
    texture.wrapT = originalMap?.wrapT ?? THREE.RepeatWrapping;
  }

  const oldLogoTexture = materialLogoTextures.get(physMat);
  if (oldLogoTexture && oldLogoTexture !== texture) oldLogoTexture.dispose();
  materialLogoTextures.set(physMat, texture);
  physMat.userData.__logoId = logoId;
  physMat.userData.__logoType = type;
  physMat.emissiveMap = texture;
  // Use the original, proven emissive-map render path. A graphite tint keeps
  // the mark dark grey rather than the previous bright white.
  physMat.emissive.set("#62666b");
  physMat.emissiveIntensity = 0.65;
  physMat.bumpMap = texture;
  physMat.bumpScale = -0.018;
  if (type === "rubber") applyBumperEmissiveShaderMask(physMat);
  physMat.needsUpdate = true;
}

export function applyLogoToExistingMaterial(mat: THREE.Material, type: "rubber" | "topCapFace", logoId: CueLogoId = "uni"): void {
  const physMat = mat as THREE.MeshStandardMaterial;

  if (type === "topCapFace") {
    if (!topCapLogoImage || !TOP_CAP_CONFIG.logo.enabled) return;
    physMat.side = THREE.DoubleSide;

    const width = 2048;
    const height = 2048;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    const logoW = width * TOP_CAP_CONFIG.logo.scale;
    const logoH = (topCapLogoImage.height / topCapLogoImage.width) * logoW;
    const logoX = width * 0.25 - logoW / 2;
    const logoY = height * 0.75 - logoH / 2;
    const whiteCanvas = document.createElement("canvas");
    whiteCanvas.width = topCapLogoImage.width;
    whiteCanvas.height = topCapLogoImage.height;
    const whiteCtx = whiteCanvas.getContext("2d")!;
    whiteCtx.drawImage(topCapLogoImage, 0, 0);
    whiteCtx.globalCompositeOperation = "source-in";
    whiteCtx.fillStyle = "#ffffff";
    whiteCtx.fillRect(0, 0, whiteCanvas.width, whiteCanvas.height);
    ctx.globalAlpha = TOP_CAP_CONFIG.logo.opacity || 1;
    ctx.drawImage(whiteCanvas, logoX, logoY, logoW, logoH);

    const emissiveTexture = new THREE.CanvasTexture(canvas);
    emissiveTexture.colorSpace = THREE.SRGBColorSpace;
    emissiveTexture.flipY = false;
    emissiveTexture.wrapS = THREE.RepeatWrapping;
    emissiveTexture.wrapT = THREE.RepeatWrapping;
    emissiveTexture.needsUpdate = true;
    physMat.userData.__logoId = logoId;
    physMat.userData.__logoType = type;
    physMat.emissiveMap = emissiveTexture;
    physMat.emissive = new THREE.Color("#80858a");
    physMat.emissiveIntensity = 0.7;
    physMat.bumpMap = emissiveTexture;
    physMat.bumpScale = -0.018;
    physMat.needsUpdate = true;
    return;
  }

  // ---- rubber type ---- keep original diffuse-map path below ----
  const originalMap = physMat.map;

  if (!originalMap) {
    console.log(`[applyLogo] No map texture on "${mat.name}", creating solid color rubber canvas with logo`);
    const width = 2048;
    const height = 2048;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, width, height);
    drawRubberLogoOnCanvas(ctx, width, height);

    const newTexture = new THREE.CanvasTexture(canvas);
    newTexture.colorSpace = THREE.SRGBColorSpace;
    newTexture.flipY = true;
    newTexture.wrapS = THREE.RepeatWrapping;
    newTexture.wrapT = THREE.RepeatWrapping;
    newTexture.needsUpdate = true;

    physMat.map = newTexture;
    physMat.needsUpdate = true;
    console.log(`[applyLogo] Applied rubber logo on solid background for "${mat.name}" (${width}x${height})`);
    return;
  }

  // Check if this is a KTX2 compressed texture
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isCompressed = (originalMap as any).isCompressedTexture;

  if (isCompressed) {
    // For KTX2 textures, we can't extract the pixel data directly.
    // Instead, render to canvas first using WebGL.
    console.log(`[applyLogo] KTX2 compressed texture detected for "${mat.name}" - using logo overlay approach`);

    // Get dimensions from mipmaps
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mipmaps = (originalMap as any).mipmaps;
    const width = mipmaps?.[0]?.width || 2048;
    const height = mipmaps?.[0]?.height || 2048;

    // Create a logo canvas
    const logoCanvas = document.createElement("canvas");
    logoCanvas.width = width;
    logoCanvas.height = height;
    const logoCtx = logoCanvas.getContext("2d")!;

    // Start with fully transparent
    logoCtx.clearRect(0, 0, width, height);

    // Try to render the compressed texture to a canvas
    try {
      const tempCanvas = renderCompressedTextureToCanvas(originalMap, width, height);
      if (tempCanvas) {
        logoCtx.drawImage(tempCanvas, 0, 0, width, height);

        // Draw logo on top
        if (type === "rubber") {
          drawRubberLogoOnCanvas(logoCtx, width, height);
        } else if (type === "topCapFace") {
          drawTopCapFaceLogoOnCanvas(logoCtx, width, height);
        }

        // Create new texture
        const newTexture = new THREE.CanvasTexture(logoCanvas);
        newTexture.colorSpace = originalMap.colorSpace || THREE.SRGBColorSpace;
        newTexture.flipY = originalMap.flipY ?? true;
        newTexture.wrapS = originalMap.wrapS || THREE.RepeatWrapping;
        newTexture.wrapT = originalMap.wrapT || THREE.RepeatWrapping;
        newTexture.needsUpdate = true;

        physMat.map = newTexture;
        physMat.needsUpdate = true;
        console.log(`[applyLogo] Applied ${type} logo to KTX2 texture "${mat.name}" (${width}x${height})`);
        return;
      }
    } catch (e) {
      console.warn(`[applyLogo] Failed to render KTX2 texture to canvas:`, e);
    }

    // Fallback: just draw logo on a solid background
    const fallbackColor = type === "rubber" ? "#0a0a0a" : (physMat.color ? `#${physMat.color.getHexString()}` : "#1a1a1a");
    logoCtx.fillStyle = fallbackColor;
    logoCtx.fillRect(0, 0, width, height);

    if (type === "rubber") {
      drawRubberLogoOnCanvas(logoCtx, width, height);
    } else if (type === "topCapFace") {
      drawTopCapFaceLogoOnCanvas(logoCtx, width, height);
    }

    const fallbackTexture = new THREE.CanvasTexture(logoCanvas);
    fallbackTexture.colorSpace = THREE.SRGBColorSpace;
    fallbackTexture.flipY = originalMap.flipY ?? true;
    fallbackTexture.wrapS = originalMap.wrapS || THREE.RepeatWrapping;
    fallbackTexture.wrapT = originalMap.wrapT || THREE.RepeatWrapping;
    fallbackTexture.needsUpdate = true;

    physMat.map = fallbackTexture;
    physMat.needsUpdate = true;
    console.log(`[applyLogo] Applied ${type} logo with fallback background to "${mat.name}" (${width}x${height})`);
    return;
  }

  // Standard uncompressed texture path
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const img = originalMap.image as any;

  if (!img) {
    console.warn(`[applyLogo] No image data in map texture for "${mat.name}", skipping logo`);
    return;
  }

  const width = (img.width as number) || 512;
  const height = (img.height as number) || 512;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Draw original texture first
  ctx.drawImage(img as CanvasImageSource, 0, 0, width, height);

  // Draw logo on top
  if (type === "rubber") {
    drawRubberLogoOnCanvas(ctx, width, height);
  } else if (type === "topCapFace") {
    drawTopCapFaceLogoOnCanvas(ctx, width, height);
  }

  // Create new texture preserving original texture settings
  const newTexture = new THREE.CanvasTexture(canvas);
  newTexture.colorSpace = originalMap.colorSpace;
  newTexture.flipY = originalMap.flipY;
  newTexture.wrapS = originalMap.wrapS;
  newTexture.wrapT = originalMap.wrapT;
  newTexture.needsUpdate = true;

  physMat.map = newTexture;
  physMat.needsUpdate = true;
  console.log(`[applyLogo] Applied ${type} logo overlay to material "${mat.name}" (${width}x${height})`);
}

// =====================================================
// RUBBER LOGO VIA EMISSIVE MAP
// =====================================================

/**
 * Apply shader mask to bumper material so emissive only shows on the flat bottom face,
 * preventing the logo from appearing on the cylinder side.
 *
 * Uses object-space normal Y (not world-space) so the mask is rotation-independent:
 * the flat end face always has objectNormal.y ≈ -1 in local model space regardless of
 * how the cue is oriented in the world.
 *
 * Exported so the extractor can re-apply after cloning (clone() drops onBeforeCompile).
 */
export function applyBumperEmissiveShaderMask(physMat: THREE.MeshPhysicalMaterial): void {
  physMat.onBeforeCompile = (shader: { vertexShader: string; fragmentShader: string }) => {
    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      "varying float vBumperObjNormalY;\nvoid main() {",
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvBumperObjNormalY = objectNormal.y;",
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      "varying float vBumperObjNormalY;\nvoid main() {",
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      float bumperMask = 1.0 - smoothstep(-0.95, -0.85, vBumperObjNormalY);
      totalEmissiveRadiance *= bumperMask;`,
    );
  };
  physMat.customProgramCacheKey = () => "bumperEmissiveMaskV3";
  physMat.needsUpdate = true;
}

/**
 * Apply rubber logo as an emissive map so it's visible even with material.color = #000000.
 * material.color multiplies the diffuse map, but emissive is additive.
 * Uses the original map's dimensions and UV transforms to ensure correct alignment.
 */
export function applyRubberLogoEmissive(mat: THREE.Material, logoId: CueLogoId = "uni"): void {
  if (!bumperLogoImage || !RUBBER_CONFIG.logo.enabled) return;
  const physMat = mat as THREE.MeshPhysicalMaterial;
  const originalMap = physMat.map;
  let width = 1024;
  let height = 1024;
  if (originalMap) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const texture = originalMap as any;
    width = texture.isCompressedTexture ? (texture.mipmaps?.[0]?.width || 1024) : (texture.image?.width || 1024);
    height = texture.isCompressedTexture ? (texture.mipmaps?.[0]?.height || 1024) : (texture.image?.height || 1024);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  const logoW = width * RUBBER_CONFIG.logo.scale;
  const logoH = (bumperLogoImage.height / bumperLogoImage.width) * logoW;
  const logoX = (width - logoW) / 2;
  const logoY = (height - logoH) / 2;
  const whiteCanvas = document.createElement("canvas");
  whiteCanvas.width = bumperLogoImage.width;
  whiteCanvas.height = bumperLogoImage.height;
  const whiteCtx = whiteCanvas.getContext("2d")!;
  whiteCtx.drawImage(bumperLogoImage, 0, 0);
  whiteCtx.globalCompositeOperation = "source-in";
  whiteCtx.fillStyle = "#ffffff";
  whiteCtx.fillRect(0, 0, whiteCanvas.width, whiteCanvas.height);
  ctx.save();
  ctx.globalAlpha = RUBBER_CONFIG.logo.opacity || 1;
  ctx.translate(logoX + logoW / 2, logoY + logoH / 2);
  ctx.scale(RUBBER_CONFIG.logo.flipX ? -1 : 1, RUBBER_CONFIG.logo.flipY ? -1 : 1);
  ctx.drawImage(whiteCanvas, -logoW / 2, -logoH / 2, logoW, logoH);
  ctx.restore();

  const emissiveTexture = new THREE.CanvasTexture(canvas);
  emissiveTexture.colorSpace = THREE.SRGBColorSpace;
  if (originalMap) {
    emissiveTexture.flipY = originalMap.flipY;
    emissiveTexture.wrapS = originalMap.wrapS;
    emissiveTexture.wrapT = originalMap.wrapT;
    emissiveTexture.channel = originalMap.channel;
  } else {
    emissiveTexture.flipY = false;
    emissiveTexture.wrapS = THREE.RepeatWrapping;
    emissiveTexture.wrapT = THREE.RepeatWrapping;
    emissiveTexture.channel = 1;
  }
  emissiveTexture.needsUpdate = true;
  physMat.userData.__logoId = logoId;
  physMat.userData.__logoType = "rubber";
  physMat.emissiveMap = emissiveTexture;
  physMat.emissive = new THREE.Color("#80858a");
  physMat.emissiveIntensity = 0.7;
  physMat.needsUpdate = true;
  applyBumperEmissiveShaderMask(physMat);
}

// =====================================================
// LOAD ALL LOGOS
// =====================================================

/**
 * Load all logo images (bumper + top cap)
 */
export async function loadAllLogos(logoId: CueLogoId = "uni"): Promise<void> {
  await Promise.all([loadBumperLogo(logoId), loadTopCapLogo(logoId)]);
}
