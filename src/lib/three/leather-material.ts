/**
 * LEATHER MATERIAL MODULE
 * Creates Three.js materials for leather and standard products
 */

import * as THREE from "three";
import { LEATHER_CONFIG, RUBBER_CONFIG, TOP_CAP_CONFIG, getLeatherTexturePath, isTopCapFaceMaterial } from "./leather-config";
import { LEATHER_FRAME } from "./leather-frame";
import {
  createLeatherRoughnessMap,
  createLeatherClearcoatMap,
} from "./leather-overlay";
import { generateLeatherBumpMap, type LeatherBumpResult } from "./procedural";

// =====================================================
// LOGO IMAGES
// =====================================================

let bumperLogoImage: HTMLImageElement | null = null;
let bumperLogoPromise: Promise<HTMLImageElement | null> | null = null;

let topCapLogoImage: HTMLImageElement | null = null;
let topCapLogoPromise: Promise<HTMLImageElement | null> | null = null;

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
export function loadLeatherNormal(
  textureKey: string = "crocodile",
  forceReload = false
): Promise<HTMLImageElement | null> {
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
export function createNormalMap(
  width: number, 
  height: number,
  textureScale: number = 1,
  useProcedural?: boolean
): HTMLCanvasElement {
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
function applyLeatherMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  leatherY: number,
  leatherHeight: number,
  leatherEndY: number
): void {
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
export function createLeatherTextureMaps(
  width: number,
  height: number,
  bodyRoughness: number = 10,
  textureScale: number = 1
): LeatherTextureMaps {
  const roughnessCanvas = createLeatherRoughnessMap(width, height, LEATHER_CONFIG.roughness, bodyRoughness);
  const roughnessTexture = new THREE.CanvasTexture(roughnessCanvas);
  roughnessTexture.flipY = false;
  // Match working shopify code: use LinearSRGBColorSpace for canvas textures
  roughnessTexture.colorSpace = THREE.LinearSRGBColorSpace;
  roughnessTexture.wrapS = THREE.RepeatWrapping;
  roughnessTexture.wrapT = THREE.ClampToEdgeWrapping;
  roughnessTexture.needsUpdate = true;
  console.log("[LeatherTextureMaps] Created roughnessMap with leatherRoughness:", LEATHER_CONFIG.roughness, "bodyRoughness:", bodyRoughness);

  const clearcoatCanvas = createLeatherClearcoatMap(width, height, LEATHER_CONFIG.clearcoat);
  const clearcoatTexture = new THREE.CanvasTexture(clearcoatCanvas);
  clearcoatTexture.flipY = false;
  clearcoatTexture.colorSpace = THREE.LinearSRGBColorSpace;
  clearcoatTexture.wrapS = THREE.RepeatWrapping;
  clearcoatTexture.wrapT = THREE.ClampToEdgeWrapping;
  clearcoatTexture.needsUpdate = true;

  const normalCanvas = createNormalMap(width, height, textureScale);
  const normalTexture = new THREE.CanvasTexture(normalCanvas);
  normalTexture.flipY = false;
  normalTexture.colorSpace = THREE.LinearSRGBColorSpace;
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
export function createLeatherMaterial(
  mapTexture: THREE.Texture,
  textureMaps: LeatherTextureMaps
): THREE.MeshPhysicalMaterial {
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
export function createStandardMaterial(
  mapTexture: THREE.Texture
): THREE.MeshPhysicalMaterial {
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
export function loadBumperLogo(): Promise<HTMLImageElement | null> {
  if (!RUBBER_CONFIG.logo.enabled) return Promise.resolve(null);
  if (bumperLogoPromise) return bumperLogoPromise;

  const logoPath = RUBBER_CONFIG.logo.path + "?v=" + Date.now();

  bumperLogoPromise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      bumperLogoImage = img;
      console.log("[Rubber] ✅ Bumper logo loaded:", img.width, "x", img.height);
      resolve(img);
    };
    img.onerror = () => {
      console.warn("[Rubber] ⚠️ Bumper logo not found at:", logoPath);
      resolve(null);
    };
    img.src = logoPath;
  });

  return bumperLogoPromise;
}

/**
 * Create diffuse texture for rubber with logo
 */
export function createRubberDiffuseWithLogo(width = 512, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Fill with rubber background color
  ctx.fillStyle = RUBBER_CONFIG.backgroundColor;
  ctx.fillRect(0, 0, width, height);

  // Draw logo if available
  if (bumperLogoImage && RUBBER_CONFIG.logo.enabled) {
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

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Create MeshPhysicalMaterial for rubber bumper
 */
export function createRubberMaterial(width = 512, height = 512): THREE.MeshPhysicalMaterial {
  const mapTexture = createRubberDiffuseWithLogo(width, height);

  return new THREE.MeshPhysicalMaterial({
    map: mapTexture,
    color: new THREE.Color(0xffffff), // White so texture colors show correctly
    roughness: RUBBER_CONFIG.roughness,
    metalness: RUBBER_CONFIG.metalness,
    clearcoat: RUBBER_CONFIG.clearcoat,
    clearcoatRoughness: 0.94,
    reflectivity: RUBBER_CONFIG.reflectivity,
    ior: 1.45,
    specularIntensity: 0.19,
    specularColor: new THREE.Color(0x2a2a2a),
    sheen: 0.0,
    sheenRoughness: 1.0,
    sheenColor: new THREE.Color(0x222222),
    transparent: false,
  });
}

// =====================================================
// TOP CAP MATERIAL (Joint cover at top)
// =====================================================

/**
 * Load top cap logo image
 */
export function loadTopCapLogo(): Promise<HTMLImageElement | null> {
  if (!TOP_CAP_CONFIG.logo.enabled) return Promise.resolve(null);
  if (topCapLogoPromise) return topCapLogoPromise;

  const logoPath = TOP_CAP_CONFIG.logo.path + "?v=" + Date.now();

  topCapLogoPromise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      topCapLogoImage = img;
      console.log("[TopCap] ✅ Logo loaded:", img.width, "x", img.height);
      resolve(img);
    };
    img.onerror = () => {
      console.warn("[TopCap] ⚠️ Logo not found at:", logoPath);
      resolve(null);
    };
    img.src = logoPath;
  });

  return topCapLogoPromise;
}

/**
 * Create texture with logo for top cap BODY (cylindrical part)
 */
export function createTopCapTextureWithLogo(width = 512, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Fill with uniform dark gray background (same as rubber)
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(0, 0, width, height);

  // No logo on cylindrical body - only on flat top face
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Create texture with logo for top cap FACE (flat top circle)
 * UV is a simple quad: U: 0.01-0.49, V: 0.51-0.99, center at (0.25, 0.75)
 */
export function createTopCapFaceTextureWithLogo(width = 512, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Fill with uniform dark gray background
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(0, 0, width, height);

  // Draw logo centered at UV (0.25, 0.75)
  if (topCapLogoImage && TOP_CAP_CONFIG.logo.enabled) {
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

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Create MeshPhysicalMaterial for top cap BODY (cylindrical joint cover)
 */
export function createTopCapMaterial(width = 512, height = 512): THREE.MeshPhysicalMaterial {
  const mapTexture = createTopCapTextureWithLogo(width, height);

  return new THREE.MeshPhysicalMaterial({
    map: mapTexture,
    color: new THREE.Color(0xffffff), // White so texture colors show correctly
    roughness: 0.4,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.5,
    reflectivity: 0.3,
    ior: 1.45,
    specularIntensity: 0.3,
    specularColor: new THREE.Color(0x333333),
    sheen: 0.0,
    transparent: false,
  });
}

/**
 * Create MeshPhysicalMaterial for top cap FACE (flat top with logo)
 */
export function createTopCapFaceMaterial(width = 512, height = 512): THREE.MeshPhysicalMaterial {
  const mapTexture = createTopCapFaceTextureWithLogo(width, height);

  return new THREE.MeshPhysicalMaterial({
    map: mapTexture,
    color: new THREE.Color(0xffffff),
    roughness: 0.4,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.5,
    reflectivity: 0.3,
    ior: 1.45,
    specularIntensity: 0.3,
    specularColor: new THREE.Color(0x333333),
    sheen: 0.0,
    transparent: false,
  });
}

// =====================================================
// LOAD ALL LOGOS
// =====================================================

/**
 * Load all logo images (bumper + top cap)
 */
export async function loadAllLogos(): Promise<void> {
  await Promise.all([loadBumperLogo(), loadTopCapLogo()]);
}
