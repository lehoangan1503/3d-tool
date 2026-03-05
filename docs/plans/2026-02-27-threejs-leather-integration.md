# Three.js Leather Cue Preview Integration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate full leather material system from shopify-customizer into Next.js cue-customizer, enabling surface textures from Supabase to display on 3D cue preview with proper leather materials.

**Architecture:** Extract leather-config, leather-overlay, leather-material modules to TypeScript. Extend SceneManager with surface/texture loading capabilities. Connect SurfaceUploader's uploaded URL to actual 3D texture application. Store dynamic config values in Supabase threejs_settings table.

**Tech Stack:** Three.js, TypeScript, Next.js 14, Supabase, React

---

## Dynamic Config Analysis

The following config objects from the source can be stored in `threejs_settings` table:

| Config Key | Source File | Database Name | Description |
|------------|-------------|---------------|-------------|
| `LEATHER_PRESETS` | leather-config.js | `leather_presets` | Bump intensity, roughness, clearcoat values |
| `LEATHER_COLOR_PALETTES` | leather-config.js | `leather_colors` | Color hex values for leather |
| `LEATHER_TEXTURE_TYPES` | leather-config.js | `leather_textures` | Texture paths for crocodile, snake |
| `SURFACE_TYPES` | leather-config.js | `surface_types` | Surface image paths |
| `LEATHER_FRAME` | leather-overlay.js | `leather_frame` | Frame coordinates for leather region |
| `LEATHER_CONFIG` | leather-config.js | `leather_config` | Active texture, color, normal scale |

---

## Task 1: Create Leather Config Module

**Files:**
- Create: `src/lib/three/leather-config.ts`

**Step 1: Create the leather config TypeScript module**

```typescript
// src/lib/three/leather-config.ts

/**
 * LEATHER & MATERIAL CONFIGURATION
 * Configures leather textures, colors, and material properties
 */

// =====================================================
// TYPES
// =====================================================

export interface LeatherPreset {
  name: string;
  normalScaleX: number;
  normalScaleY: number;
  normalStrength: number;
  textureScaleX: number;
  textureScaleY: number;
  roughness: number;
  clearcoat: number;
  sheen: number;
}

export interface LeatherColorPalette {
  name: string;
  hex: string;
}

export interface LeatherTextureType {
  name: string;
  path: string;
}

export interface SurfaceType {
  name: string;
  path: string;
}

export interface NonLeatherConfig {
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  reflectivity: number;
  ior: number;
  thickness: number;
  specularIntensity: number;
}

export interface LeatherConfigType {
  activeColor: string;
  activeTexture: string;
  normalScaleX: number;
  normalScaleY: number;
  normalStrength: number;
  textureScaleX: number;
  textureScaleY: number;
  roughness: number;
  clearcoat: number;
  sheen: number;
  nonLeather: NonLeatherConfig;
}

// =====================================================
// PRESETS
// =====================================================

export const LEATHER_PRESETS: Record<number, LeatherPreset> = {
  1: {
    name: "Deep Crocodile",
    normalScaleX: 1,
    normalScaleY: 3.5,
    normalStrength: 3.0,
    textureScaleX: 0.6,
    textureScaleY: 0.6,
    roughness: 245,
    clearcoat: 5,
    sheen: 80,
  },
};

export const ACTIVE_LEATHER_PRESET = 1;

// Get active preset values
const activePreset = LEATHER_PRESETS[ACTIVE_LEATHER_PRESET] || LEATHER_PRESETS[1];

// =====================================================
// SURFACE TYPES
// =====================================================

export const SURFACE_TYPES: Record<string, SurfaceType> = {
  leather: { name: "Leather", path: "/textures/surfaces/surface-leather.jpg" },
  leather1: { name: "Leather 1", path: "/textures/surfaces/surface-leather1.jpg" },
  leather6: { name: "Leather 6", path: "/textures/surfaces/surface-leather6.jpg" },
  leather9: { name: "Leather 9", path: "/textures/surfaces/surface-leather9.jpg" },
};

// =====================================================
// LEATHER TEXTURE TYPES
// =====================================================

export const LEATHER_TEXTURE_TYPES: Record<string, LeatherTextureType> = {
  crocodile: {
    name: "Crocodile",
    path: "/textures/leathers/crocodile.webp",
  },
  snake: {
    name: "Snake",
    path: "/textures/leathers/snake.webp",
  },
};

// =====================================================
// LEATHER COLOR PALETTES
// =====================================================

export const LEATHER_COLOR_PALETTES: Record<string, LeatherColorPalette> = {
  black: { name: "Black", hex: "#1A1A1A" },
  chestnut: { name: "Chestnut", hex: "#954535" },
  chocolate: { name: "Chocolate", hex: "#3D1C02" },
  darkBrown: { name: "Dark Brown", hex: "#2C1608" },
  whiskey: { name: "Whiskey", hex: "#B5651D" },
  tan: { name: "Tan", hex: "#D2B48C" },
};

// =====================================================
// LEATHER CONFIG (main config object)
// =====================================================

export const LEATHER_CONFIG: LeatherConfigType = {
  activeColor: "black",
  activeTexture: "crocodile",
  normalScaleX: activePreset.normalScaleX,
  normalScaleY: activePreset.normalScaleY,
  normalStrength: activePreset.normalStrength,
  textureScaleX: activePreset.textureScaleX,
  textureScaleY: activePreset.textureScaleY,
  roughness: activePreset.roughness,
  clearcoat: activePreset.clearcoat,
  sheen: activePreset.sheen,
  nonLeather: {
    roughness: 0.01,
    clearcoat: 1.0,
    clearcoatRoughness: 0.005,
    reflectivity: 1.0,
    ior: 1.52,
    thickness: 1.5,
    specularIntensity: 1.2,
  },
};

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Get leather color hex from active color key
 */
export function getLeatherColorHex(colorKey: string): string {
  return LEATHER_COLOR_PALETTES[colorKey]?.hex || LEATHER_COLOR_PALETTES.black.hex;
}

/**
 * Get leather texture path from active texture key
 */
export function getLeatherTexturePath(textureKey: string): string {
  return LEATHER_TEXTURE_TYPES[textureKey]?.path || LEATHER_TEXTURE_TYPES.crocodile.path;
}

/**
 * Get surface path from surface key
 */
export function getSurfacePath(surfaceKey: string): string {
  return SURFACE_TYPES[surfaceKey]?.path || SURFACE_TYPES.leather6.path;
}
```

**Step 2: Verify file was created**

Run: `head -30 src/lib/three/leather-config.ts`

**Step 3: Commit**

```bash
git add src/lib/three/leather-config.ts
git commit -m "feat(three): add leather config module with types and presets"
```

---

## Task 2: Create Leather Frame Constants

**Files:**
- Create: `src/lib/three/leather-frame.ts`

**Step 1: Create leather frame constants module**

```typescript
// src/lib/three/leather-frame.ts

/**
 * LEATHER FRAME COORDINATES
 * Defines where leather region appears on the surface texture
 */

export interface LeatherFrameType {
  x: number;
  y: number;
  width: number;
  height: number;
  surfaceWidth: number;
  surfaceHeight: number;
}

/**
 * Leather frame coordinates (where leather image goes on surface)
 * Based on the surface.jpg UV layout
 */
export const LEATHER_FRAME: LeatherFrameType = {
  x: 0,
  y: 3660,
  width: 1141,
  height: 3464,
  surfaceWidth: 1141,
  surfaceHeight: 8359,
};

/**
 * Calculate leather region bounds as ratios (0-1)
 */
export function getLeatherBoundsRatio(): { startY: number; endY: number } {
  return {
    startY: LEATHER_FRAME.y / LEATHER_FRAME.surfaceHeight,
    endY: (LEATHER_FRAME.y + LEATHER_FRAME.height) / LEATHER_FRAME.surfaceHeight,
  };
}
```

**Step 2: Commit**

```bash
git add src/lib/three/leather-frame.ts
git commit -m "feat(three): add leather frame coordinates module"
```

---

## Task 3: Create Leather Surface Overlay Module

**Files:**
- Create: `src/lib/three/leather-overlay.ts`

**Step 1: Create leather surface overlay module**

```typescript
// src/lib/three/leather-overlay.ts

/**
 * LEATHER SURFACE MODULE
 * Creates composite surface images with leather overlay
 */

import { LEATHER_FRAME, type LeatherFrameType } from "./leather-frame";

export interface LeatherMaterialConfig {
  roughness: number;
  clearcoat: number;
  normalScale: number;
}

// Preset for leather material properties
export const LEATHER_MATERIAL_CONFIG: LeatherMaterialConfig = {
  roughness: 120,
  clearcoat: 5,
  normalScale: 3.5,
};

/**
 * Load an image as a promise
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Create a mixed surface image with leather color overlay
 * Composites leather color on top of surface at the leather region
 */
export async function createLeatherSurface(
  surfacePath: string,
  leatherColorHex: string
): Promise<HTMLCanvasElement> {
  const surfaceImg = await loadImage(surfacePath);

  const canvas = document.createElement("canvas");
  canvas.width = surfaceImg.width;
  canvas.height = surfaceImg.height;
  const ctx = canvas.getContext("2d")!;

  // Draw base surface
  ctx.drawImage(surfaceImg, 0, 0);

  // Calculate scale if canvas differs from original frame dimensions
  const scaleX = canvas.width / LEATHER_FRAME.surfaceWidth;
  const scaleY = canvas.height / LEATHER_FRAME.surfaceHeight;

  // Draw leather color at frame position (scaled)
  const drawX = LEATHER_FRAME.x * scaleX;
  const drawY = LEATHER_FRAME.y * scaleY;
  const drawW = LEATHER_FRAME.width * scaleX;
  const drawH = LEATHER_FRAME.height * scaleY;

  ctx.fillStyle = leatherColorHex;
  ctx.fillRect(drawX, drawY, drawW, drawH);

  console.log("[LeatherSurface] Created mixed surface:", {
    surfaceSize: `${canvas.width}x${canvas.height}`,
    leatherAt: `${drawX.toFixed(0)},${drawY.toFixed(0)} ${drawW.toFixed(0)}x${drawH.toFixed(0)}`,
    colorHex: leatherColorHex,
  });

  return canvas;
}

/**
 * Create a roughness map for leather products
 * Leather region = high roughness (matte)
 * Other regions = low roughness (glossy lacquer)
 */
export function createLeatherRoughnessMap(
  width: number,
  height: number,
  roughnessValue: number = 120
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Calculate scale
  const scaleY = height / LEATHER_FRAME.surfaceHeight;

  // Fill entire canvas with very low roughness (glossy lacquer)
  ctx.fillStyle = "rgb(10, 10, 10)";
  ctx.fillRect(0, 0, width, height);

  // Fill leather region with high roughness (matte)
  const leatherY = LEATHER_FRAME.y * scaleY;
  const leatherH = LEATHER_FRAME.height * scaleY;

  ctx.fillStyle = `rgb(${roughnessValue}, ${roughnessValue}, ${roughnessValue})`;
  ctx.fillRect(0, leatherY, width, leatherH);

  return canvas;
}

/**
 * Create a clearcoat map for leather products
 * Leather region = low/no clearcoat
 * Other regions = full clearcoat (white)
 */
export function createLeatherClearcoatMap(
  width: number,
  height: number,
  clearcoatValue: number = 5
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Calculate scale
  const scaleY = height / LEATHER_FRAME.surfaceHeight;

  // Fill entire canvas with full clearcoat (white)
  ctx.fillStyle = "rgb(255, 255, 255)";
  ctx.fillRect(0, 0, width, height);

  // Fill leather region with low clearcoat
  const leatherY = LEATHER_FRAME.y * scaleY;
  const leatherH = LEATHER_FRAME.height * scaleY;

  ctx.fillStyle = `rgb(${clearcoatValue}, ${clearcoatValue}, ${clearcoatValue})`;
  ctx.fillRect(0, leatherY, width, leatherH);

  return canvas;
}

/**
 * Get leather surface as canvas data URL
 */
export async function getLeatherSurfaceDataUrl(
  surfacePath: string,
  leatherColorHex: string
): Promise<string> {
  const canvas = await createLeatherSurface(surfacePath, leatherColorHex);
  return canvas.toDataURL("image/jpeg", 0.95);
}
```

**Step 2: Commit**

```bash
git add src/lib/three/leather-overlay.ts
git commit -m "feat(three): add leather surface overlay module"
```

---

## Task 4: Create Leather Material Module

**Files:**
- Create: `src/lib/three/leather-material.ts`

**Step 1: Create leather material module**

```typescript
// src/lib/three/leather-material.ts

/**
 * LEATHER MATERIAL MODULE
 * Creates Three.js materials for leather and standard products
 */

import * as THREE from "three";
import { LEATHER_CONFIG, getLeatherTexturePath } from "./leather-config";
import { LEATHER_FRAME } from "./leather-frame";
import {
  createLeatherRoughnessMap,
  createLeatherClearcoatMap,
} from "./leather-overlay";

// =====================================================
// LEATHER NORMAL MAP
// =====================================================

let leatherNormalImage: HTMLImageElement | null = null;
let leatherNormalLoaded = false;
let leatherNormalPromise: Promise<HTMLImageElement | null> | null = null;

/**
 * Load leather normal map image
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
 */
export function createNormalMap(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Default: flat normal (neutral blue)
  ctx.fillStyle = "rgb(128, 128, 255)";
  ctx.fillRect(0, 0, width, height);

  if (leatherNormalImage) {
    const scaleY = height / LEATHER_FRAME.surfaceHeight;
    const leatherY = Math.floor(LEATHER_FRAME.y * scaleY);
    const leatherHeight = Math.floor(LEATHER_FRAME.height * scaleY);
    const leatherEndY = leatherY + leatherHeight;

    // Create temp canvas for leather normal
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext("2d")!;

    tempCtx.fillStyle = "rgb(128, 128, 255)";
    tempCtx.fillRect(0, 0, width, height);
    tempCtx.drawImage(leatherNormalImage, 0, leatherY, width, leatherHeight);

    // Create mask with soft edges
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
    tempCtx.globalCompositeOperation = "destination-in";
    tempCtx.drawImage(maskCanvas, 0, 0);
    tempCtx.globalCompositeOperation = "source-over";

    // Draw masked leather normal onto main canvas
    ctx.drawImage(tempCanvas, 0, 0);

    console.log("[NormalMap] Applied leather normal to region:", leatherY, "-", leatherEndY);
  }

  return canvas;
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
 */
export function createLeatherTextureMaps(
  width: number,
  height: number
): LeatherTextureMaps {
  const roughnessCanvas = createLeatherRoughnessMap(width, height, LEATHER_CONFIG.roughness);
  const roughnessTexture = new THREE.CanvasTexture(roughnessCanvas);
  roughnessTexture.flipY = false;
  roughnessTexture.needsUpdate = true;

  const clearcoatCanvas = createLeatherClearcoatMap(width, height, LEATHER_CONFIG.clearcoat);
  const clearcoatTexture = new THREE.CanvasTexture(clearcoatCanvas);
  clearcoatTexture.flipY = false;
  clearcoatTexture.needsUpdate = true;

  const normalCanvas = createNormalMap(width, height);
  const normalTexture = new THREE.CanvasTexture(normalCanvas);
  normalTexture.flipY = false;
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
 */
export function createLeatherMaterial(
  mapTexture: THREE.Texture,
  textureMaps: LeatherTextureMaps
): THREE.MeshPhysicalMaterial {
  const { roughnessTexture, clearcoatTexture, normalTexture } = textureMaps;
  const cfg = LEATHER_CONFIG.nonLeather;

  return new THREE.MeshPhysicalMaterial({
    map: mapTexture,
    color: new THREE.Color(0xffffff),
    roughness: 1.0,
    roughnessMap: roughnessTexture,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatMap: clearcoatTexture,
    clearcoatRoughness: cfg.clearcoatRoughness,
    normalMap: normalTexture,
    normalScale: new THREE.Vector2(LEATHER_CONFIG.normalScaleX, LEATHER_CONFIG.normalScaleY),
    reflectivity: cfg.reflectivity,
    ior: cfg.ior,
    thickness: cfg.thickness,
    specularIntensity: cfg.specularIntensity,
    specularColor: new THREE.Color(0xffffff),
    sheen: LEATHER_CONFIG.sheen / 255,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0x775533),
    transparent: false,
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
```

**Step 2: Commit**

```bash
git add src/lib/three/leather-material.ts
git commit -m "feat(three): add leather material module with texture maps"
```

---

## Task 5: Extend SceneManager with Surface Loading

**Files:**
- Modify: `src/lib/three/scene-manager.ts`

**Step 1: Add imports and new properties to SceneManager**

Replace entire file with updated version:

```typescript
// src/lib/three/scene-manager.ts

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { ThreeJSSettings } from "@/types/settings";
import { DEFAULT_THREEJS_SETTINGS } from "@/types/settings";
import { LEATHER_CONFIG, getLeatherColorHex } from "./leather-config";
import {
  loadLeatherNormal,
  createLeatherTextureMaps,
  createLeatherMaterial,
  createStandardMaterial,
  type LeatherTextureMaps,
} from "./leather-material";
import { createLeatherSurface } from "./leather-overlay";
import type { ProductType, LeatherColor, LeatherTextureType } from "@/types/product";

export interface SurfaceOptions {
  surfaceUrl?: string | null;
  productType: ProductType;
  leatherColor?: LeatherColor | null;
  leatherTexture?: LeatherTextureType | null;
}

export class SceneManager {
  private container: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private model: THREE.Group | null = null;
  private settings: ThreeJSSettings;
  private animationId: number | null = null;
  private isDarkBg = true;
  private maxAnisotropy: number;
  private createdTextures: THREE.Texture[] = [];
  private currentSurfaceOptions: SurfaceOptions | null = null;

  constructor(container: HTMLElement, settings?: ThreeJSSettings) {
    this.container = container;
    this.settings = settings || DEFAULT_THREEJS_SETTINGS;

    // Initialize RectAreaLight uniforms
    RectAreaLightUniformsLib.init();

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.settings.background.dark);

    // Camera
    const { fov, position, near, far } = this.settings.camera;
    this.camera = new THREE.PerspectiveCamera(
      fov,
      container.clientWidth / container.clientHeight,
      near,
      far
    );
    this.camera.position.set(position[0], position[1], position[2]);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    // Get max anisotropy for texture filtering
    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = this.settings.controls.enableDamping;
    this.controls.dampingFactor = this.settings.controls.dampingFactor;
    this.controls.minDistance = this.settings.controls.minDistance;
    this.controls.maxDistance = this.settings.controls.maxDistance;
    this.controls.enablePan = true;
    this.controls.panSpeed = 0.8;
    this.controls.rotateSpeed = 0.8;

    // Lock pan to Y-axis only
    this.controls.addEventListener("change", () => {
      this.controls.target.x = 0;
      this.controls.target.z = 0;
    });

    // Lighting
    this.setupLighting();

    // Handle resize
    window.addEventListener("resize", this.handleResize);

    // Start animation loop
    this.animate();
  }

  private setupLighting() {
    // Ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, this.settings.lighting.ambient);
    this.scene.add(ambientLight);

    // Hemisphere light
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xf0f0f0, this.settings.lighting.hemisphere);
    this.scene.add(hemiLight);

    // Studio-style RectAreaLights attached to camera
    const stripRight = new THREE.RectAreaLight(0xffffff, 5, 1.0, 5);
    stripRight.position.set(2, 0, 1);
    stripRight.lookAt(0, 0, 0);
    this.camera.add(stripRight);

    const stripLeft = new THREE.RectAreaLight(0xffffff, 4, 0.8, 4.5);
    stripLeft.position.set(-1.8, 0, 1);
    stripLeft.lookAt(0, 0, 0);
    this.camera.add(stripLeft);

    const stripTop = new THREE.RectAreaLight(0xffffff, 4.5, 4, 0.8);
    stripTop.position.set(0, 2, 1);
    stripTop.lookAt(0, 0, 0);
    this.camera.add(stripTop);

    const stripBottom = new THREE.RectAreaLight(0xffffff, 3.5, 3.5, 0.6);
    stripBottom.position.set(0, -1.8, 1);
    stripBottom.lookAt(0, 0, 0);
    this.camera.add(stripBottom);

    this.scene.add(this.camera);
  }

  private handleResize = () => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private animate = () => {
    this.animationId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  async loadModel(modelPath: string): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(
        modelPath,
        (gltf) => {
          // Remove existing model
          if (this.model) {
            this.scene.remove(this.model);
            this.model.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                  child.material.forEach((m) => m.dispose());
                } else {
                  child.material.dispose();
                }
              }
            });
          }

          this.model = gltf.scene;

          // Scale model
          const box = new THREE.Box3().setFromObject(this.model);
          const size = box.getSize(new THREE.Vector3());
          const scale = 2.0 / Math.max(size.x, size.y, size.z);
          this.model.scale.setScalar(scale);

          // Center model
          const centerBox = new THREE.Box3().setFromObject(this.model);
          const centerPoint = centerBox.getCenter(new THREE.Vector3());
          this.model.position.set(-centerPoint.x, -centerPoint.y, -centerPoint.z);

          this.scene.add(this.model);

          // Update camera position
          this.camera.position.set(2, 0, 2);
          this.controls.target.set(0, 0, 0);
          this.controls.update();

          console.log("[SceneManager] Model loaded successfully");
          resolve(this.model);
        },
        undefined,
        reject
      );
    });
  }

  /**
   * Apply surface texture to the model
   */
  async applySurface(options: SurfaceOptions): Promise<void> {
    if (!this.model) {
      console.warn("[SceneManager] No model loaded, cannot apply surface");
      return;
    }

    this.currentSurfaceOptions = options;
    const { surfaceUrl, productType, leatherColor, leatherTexture } = options;

    // Clear old textures
    this.disposeTextures();

    let surfaceImage: HTMLImageElement;

    if (productType === "leather" && leatherColor) {
      // Create leather surface with color overlay
      const baseSurfaceUrl = surfaceUrl || "/textures/surfaces/surface-leather6.jpg";
      const colorHex = getLeatherColorHex(leatherColor);

      // Load leather normal map
      await loadLeatherNormal(leatherTexture || "crocodile");

      const leatherCanvas = await createLeatherSurface(baseSurfaceUrl, colorHex);
      surfaceImage = await this.canvasToImage(leatherCanvas);
    } else if (surfaceUrl) {
      // Load surface directly
      surfaceImage = await this.loadImage(surfaceUrl);
    } else {
      console.warn("[SceneManager] No surface URL provided");
      return;
    }

    console.log("[SceneManager] Surface loaded:", surfaceImage.width, "x", surfaceImage.height);

    // Create canvas texture
    const canvas = document.createElement("canvas");
    const CANVAS_SIZE = 4096;
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(surfaceImage, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

    const mapTexture = new THREE.CanvasTexture(canvas);
    mapTexture.colorSpace = THREE.SRGBColorSpace;
    mapTexture.wrapS = THREE.RepeatWrapping;
    mapTexture.wrapT = THREE.ClampToEdgeWrapping;
    mapTexture.flipY = false;
    mapTexture.minFilter = THREE.LinearMipmapLinearFilter;
    mapTexture.magFilter = THREE.LinearFilter;
    mapTexture.generateMipmaps = true;
    mapTexture.anisotropy = this.maxAnisotropy;
    mapTexture.needsUpdate = true;
    this.createdTextures.push(mapTexture);

    // Create material based on product type
    let textureMaps: LeatherTextureMaps | null = null;
    if (productType === "leather") {
      textureMaps = createLeatherTextureMaps(CANVAS_SIZE, CANVAS_SIZE);
      this.createdTextures.push(
        textureMaps.roughnessTexture,
        textureMaps.clearcoatTexture,
        textureMaps.normalTexture
      );
    }

    // Apply to model meshes
    this.model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      const meshName = (child.name || "").toLowerCase();
      const materials = Array.isArray(child.material) ? child.material : [child.material];

      materials.forEach((mat, idx) => {
        const matName = (mat?.name || "").toLowerCase();
        const isOutside = meshName.includes("outside") || matName.includes("outside") ||
                          meshName.includes("butt_body") || matName.includes("butt_body");

        if (!isOutside) return;

        let newMat: THREE.MeshPhysicalMaterial;

        if (productType === "leather" && textureMaps) {
          newMat = createLeatherMaterial(mapTexture, textureMaps);
          console.log("[SceneManager] Applied leather material to:", mat.name || meshName);
        } else {
          newMat = createStandardMaterial(mapTexture);
          console.log("[SceneManager] Applied standard material to:", mat.name || meshName);
        }

        newMat.name = mat.name;

        if (Array.isArray(child.material)) {
          child.material[idx] = newMat;
        } else {
          child.material = newMat;
        }
      });
    });

    console.log("[SceneManager] Surface applied successfully");
  }

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  private canvasToImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = canvas.toDataURL("image/jpeg", 0.95);
    });
  }

  private disposeTextures() {
    for (const tex of this.createdTextures) {
      tex.dispose();
    }
    this.createdTextures = [];
  }

  getModel(): THREE.Group | null {
    return this.model;
  }

  toggleBackground() {
    this.isDarkBg = !this.isDarkBg;
    this.scene.background = new THREE.Color(
      this.isDarkBg ? this.settings.background.dark : this.settings.background.light
    );
    return this.isDarkBg;
  }

  dispose() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }

    window.removeEventListener("resize", this.handleResize);

    // Dispose textures
    this.disposeTextures();

    // Dispose model
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    }

    // Dispose renderer
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);

    // Dispose controls
    this.controls.dispose();
  }
}
```

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/lib/three/scene-manager.ts
git commit -m "feat(three): extend SceneManager with surface and leather support"
```

---

## Task 6: Update CuePreview Component

**Files:**
- Modify: `src/components/editor/cue-preview.tsx`

**Step 1: Update CuePreview to apply surface on load**

```typescript
// src/components/editor/cue-preview.tsx

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { SceneManager, type SurfaceOptions } from "@/lib/three/scene-manager";
import type { Product } from "@/types/product";
import { MODEL_PATHS } from "@/types/product";
import type { ThreeJSSettings } from "@/types/settings";

interface CuePreviewProps {
  product: Product;
  settings?: ThreeJSSettings;
  onSceneReady?: (manager: SceneManager) => void;
}

export function CuePreview({ product, settings, onSceneReady }: CuePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<SceneManager | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initScene = useCallback(async () => {
    if (!containerRef.current || managerRef.current) return;

    try {
      setLoading(true);
      setError(null);

      // Create scene manager
      const manager = new SceneManager(containerRef.current, settings);
      managerRef.current = manager;

      // Load model based on product type
      const modelPath = MODEL_PATHS[product.type];
      await manager.loadModel(modelPath);

      // Apply surface texture if available
      const surfaceOptions: SurfaceOptions = {
        surfaceUrl: product.surface_url,
        productType: product.type,
        leatherColor: product.color,
        leatherTexture: product.texture_type,
      };
      await manager.applySurface(surfaceOptions);

      // Notify parent
      onSceneReady?.(manager);

      setLoading(false);
    } catch (err) {
      console.error("Failed to initialize 3D scene:", err);
      setError(err instanceof Error ? err.message : "Failed to load 3D preview");
      setLoading(false);
    }
  }, [product.type, product.surface_url, product.color, product.texture_type, settings, onSceneReady]);

  // Re-apply surface when product properties change
  useEffect(() => {
    if (managerRef.current && !loading) {
      const surfaceOptions: SurfaceOptions = {
        surfaceUrl: product.surface_url,
        productType: product.type,
        leatherColor: product.color,
        leatherTexture: product.texture_type,
      };
      managerRef.current.applySurface(surfaceOptions);
    }
  }, [product.surface_url, product.color, product.texture_type, product.type, loading]);

  useEffect(() => {
    initScene();

    return () => {
      if (managerRef.current) {
        managerRef.current.dispose();
        managerRef.current = null;
      }
    };
  }, [initScene]);

  return (
    <div className="relative w-full h-full">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ minHeight: "400px" }}
      />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="text-center text-foreground">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-foreground mx-auto mb-4" />
            <p>Loading 3D Preview...</p>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/95">
          <div className="text-center text-foreground p-4">
            <div className="text-4xl mb-4">⚠️</div>
            <p className="text-destructive">{error}</p>
            <button
              onClick={() => {
                managerRef.current?.dispose();
                managerRef.current = null;
                initScene();
              }}
              className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/editor/cue-preview.tsx
git commit -m "feat(editor): update CuePreview to apply surface textures"
```

---

## Task 7: Create Index Export for Three.js Modules

**Files:**
- Create: `src/lib/three/index.ts`

**Step 1: Create index export**

```typescript
// src/lib/three/index.ts

export * from "./scene-manager";
export * from "./leather-config";
export * from "./leather-frame";
export * from "./leather-material";
export * from "./leather-overlay";
```

**Step 2: Commit**

```bash
git add src/lib/three/index.ts
git commit -m "feat(three): add index export for all modules"
```

---

## Task 8: Copy Required Texture Assets

**Files:**
- Create texture directories and copy files

**Step 1: Create texture directories**

```bash
mkdir -p public/textures/surfaces
mkdir -p public/textures/leathers
```

**Step 2: Copy texture files from shopify-customizer**

```bash
# Copy surface textures (if they exist)
cp /Users/an/Documents/shopify-customizer/surface/*.jpg public/textures/surfaces/ 2>/dev/null || true

# Copy leather textures
cp /Users/an/Documents/shopify-customizer/leathers/type1/*.webp public/textures/leathers/crocodile.webp 2>/dev/null || true
cp /Users/an/Documents/shopify-customizer/leathers/type2/*.webp public/textures/leathers/snake.webp 2>/dev/null || true
```

**Step 3: Commit assets**

```bash
git add public/textures/
git commit -m "feat: add leather and surface texture assets"
```

---

## Task 9: Create API Endpoint for Dynamic Settings

**Files:**
- Create: `src/app/api/settings/route.ts`

**Step 1: Create settings API endpoint**

```typescript
// src/app/api/settings/route.ts

import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const supabase = await createClient();
    
    const { data: settings, error } = await supabase
      .from("threejs_settings")
      .select("*");

    if (error) {
      throw error;
    }

    // Convert array to object keyed by name
    const settingsMap = settings?.reduce((acc, setting) => {
      acc[setting.name] = setting.settings;
      return acc;
    }, {} as Record<string, unknown>) || {};

    return NextResponse.json(settingsMap);
  } catch (error) {
    console.error("Failed to fetch settings:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const body = await request.json();
    const { name, settings } = body;

    if (!name || !settings) {
      return NextResponse.json({ error: "Name and settings required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("threejs_settings")
      .upsert({ name, settings }, { onConflict: "name" })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to save settings:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
```

**Step 2: Commit**

```bash
git add src/app/api/settings/route.ts
git commit -m "feat(api): add settings endpoint for dynamic threejs config"
```

---

## Task 10: Seed Default Settings to Database

**Files:**
- Create: `scripts/seed-settings.ts`

**Step 1: Create seed script**

```typescript
// scripts/seed-settings.ts

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const defaultSettings = [
  {
    name: "leather_presets",
    settings: {
      1: {
        name: "Deep Crocodile",
        normalScaleX: 1,
        normalScaleY: 3.5,
        normalStrength: 3.0,
        textureScaleX: 0.6,
        textureScaleY: 0.6,
        roughness: 245,
        clearcoat: 5,
        sheen: 80,
      },
    },
  },
  {
    name: "leather_colors",
    settings: {
      black: { name: "Black", hex: "#1A1A1A" },
      chestnut: { name: "Chestnut", hex: "#954535" },
      chocolate: { name: "Chocolate", hex: "#3D1C02" },
      darkBrown: { name: "Dark Brown", hex: "#2C1608" },
      whiskey: { name: "Whiskey", hex: "#B5651D" },
      tan: { name: "Tan", hex: "#D2B48C" },
    },
  },
  {
    name: "leather_textures",
    settings: {
      crocodile: { name: "Crocodile", path: "/textures/leathers/crocodile.webp" },
      snake: { name: "Snake", path: "/textures/leathers/snake.webp" },
    },
  },
  {
    name: "leather_frame",
    settings: {
      x: 0,
      y: 3660,
      width: 1141,
      height: 3464,
      surfaceWidth: 1141,
      surfaceHeight: 8359,
    },
  },
  {
    name: "threejs_default",
    settings: {
      camera: { fov: 50, position: [0, 1.8, 4], near: 0.1, far: 1000 },
      controls: { enableDamping: true, dampingFactor: 0.05, minDistance: 0.5, maxDistance: 10 },
      lighting: { ambient: 0.55, hemisphere: 0.4 },
      background: { dark: "#2a2a2a", light: "#f2f4f8" },
    },
  },
];

async function seed() {
  console.log("Seeding threejs_settings...");

  for (const setting of defaultSettings) {
    const { error } = await supabase
      .from("threejs_settings")
      .upsert(setting, { onConflict: "name" });

    if (error) {
      console.error(`Failed to seed ${setting.name}:`, error);
    } else {
      console.log(`✅ Seeded: ${setting.name}`);
    }
  }

  console.log("Seeding complete!");
}

seed().catch(console.error);
```

**Step 2: Add script to package.json**

Add to scripts in package.json:
```json
"seed:settings": "npx tsx scripts/seed-settings.ts"
```

**Step 3: Commit**

```bash
git add scripts/seed-settings.ts package.json
git commit -m "feat: add seed script for default threejs settings"
```

---

## Task 11: Test the Integration

**Step 1: Build and check for errors**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors

**Step 2: Start dev server**

Run: `npm run dev`

**Step 3: Test surface upload flow**

1. Navigate to `/dashboard`
2. Create or edit a leather product
3. Upload a surface image
4. Verify the surface appears on the 3D cue preview

**Step 4: Test leather color/texture changes**

1. Change leather color in LeatherPicker
2. Verify cue preview updates with new color
3. Change texture type
4. Verify texture changes

**Step 5: Commit final integration**

```bash
git add -A
git commit -m "feat: complete threejs leather integration with surface display"
```

---

## Summary of Dynamic Config for Database

The following configs are now extractable to `threejs_settings` table:

| Database `name` | Purpose | Can Be Edited By |
|-----------------|---------|------------------|
| `leather_presets` | Material bump/roughness presets | Admin |
| `leather_colors` | Available leather colors | Admin |
| `leather_textures` | Texture paths (crocodile, snake) | Admin |
| `leather_frame` | UV coordinates for leather region | Admin (rarely) |
| `threejs_default` | Camera, controls, lighting settings | Admin |

Products table already stores per-product config:
- `surface_url` - Custom surface image
- `texture_type` - crocodile/snake
- `color` - leather color key

---

## Verification Checklist

- [ ] Surface uploaded to Supabase displays on 3D model
- [ ] Leather products show correct leather region
- [ ] Leather color changes apply immediately
- [ ] Leather texture changes apply immediately
- [ ] Standard (smooth) products render glossy
- [ ] Camera controls work (rotate, zoom, pan)
- [ ] Background toggle works
- [ ] No console errors
- [ ] TypeScript builds without errors

---

**Plan complete and saved to `docs/plans/2026-02-27-threejs-leather-integration.md`.**

Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
