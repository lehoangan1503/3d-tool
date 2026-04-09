import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

// ─── Texture Pack Manifest Types ───

export interface TexturePackInfo {
  id: string;
  name: string;
  folder: string;
  maps: string[];
  tiling: [number, number];
  roughnessValue: number;
  metalnessValue: number;
  displacementScale: number;
  /** File extension for standard map files (default: "jpg") */
  fileExt?: string;
  /** Optional high-quality overrides (EXR / PNG) */
  hqOverrides?: Record<string, string>;
  /** Solid color hex (e.g. "#ffffff") — used when maps is empty */
  solidColor?: string;
}

export interface TextureManifest {
  wall: TexturePackInfo[];
  table: TexturePackInfo[];
}

let cachedManifest: TextureManifest | null = null;

/** Load the texture manifest from the server */
export async function loadTextureManifest(): Promise<TextureManifest> {
  if (cachedManifest) return cachedManifest;
  const res = await fetch('/textures/studio/textures.json');
  cachedManifest = await res.json() as TextureManifest;
  return cachedManifest;
}

/** Find a texture pack by ID across wall and table categories */
export function findTexturePack(
  manifest: TextureManifest,
  id: string
): TexturePackInfo | undefined {
  return manifest.wall.find(p => p.id === id) ?? manifest.table.find(p => p.id === id);
}

// ─── PBR Texture Loader ───

const textureLoader = new THREE.TextureLoader();
const exrLoader = new EXRLoader();

function loadTex(url: string, tiling: [number, number]): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(tiling[0], tiling[1]);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}

function loadTexLinear(url: string, tiling: [number, number]): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(tiling[0], tiling[1]);
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}

/** Load an EXR file as a linear-space texture (float precision) */
function loadExrTex(url: string, tiling: [number, number]): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    exrLoader.load(
      url,
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(tiling[0], tiling[1]);
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}

/** Choose the best loader for a texture URL based on extension */
function loadHQTexLinear(url: string, tiling: [number, number]): Promise<THREE.Texture> {
  if (url.endsWith('.exr')) return loadExrTex(url, tiling);
  if (url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.jpeg')) return loadTexLinear(url, tiling);
  return loadTexLinear(url, tiling);
}

/**
 * Load a full PBR texture pack and create a MeshStandardMaterial.
 * Maps loaded: diffuse, normal, roughness, AO, displacement (if available).
 */
export async function loadPBRTexturePack(
  pack: TexturePackInfo
): Promise<THREE.MeshStandardMaterial> {
  // Solid-color material (no texture files)
  if (pack.maps.length === 0) {
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(pack.solidColor ?? '#ffffff'),
      roughness: pack.roughnessValue,
      metalness: pack.metalnessValue,
      side: THREE.FrontSide,
    });
  }

  const basePath = `/textures/studio/${pack.folder}`;
  const tiling = pack.tiling;
  const hq = pack.hqOverrides ?? {};
  const ext = pack.fileExt ?? 'jpg';

  const promises: Record<string, Promise<THREE.Texture>> = {};

  if (pack.maps.includes('diff')) {
    const url = hq.diff ?? `${basePath}/diff.${ext}`;
    promises.map = loadTex(url, tiling);
  }
  if (pack.maps.includes('normal')) {
    const url = hq.normal ?? `${basePath}/normal.${ext}`;
    promises.normalMap = loadHQTexLinear(url, tiling);
  }
  if (pack.maps.includes('roughness')) {
    const url = hq.roughness ?? `${basePath}/roughness.${ext}`;
    promises.roughnessMap = loadHQTexLinear(url, tiling);
  }
  if (pack.maps.includes('ao')) {
    const url = hq.ao ?? `${basePath}/ao.${ext}`;
    promises.aoMap = loadHQTexLinear(url, tiling);
  }
  if (pack.maps.includes('displacement')) {
    const url = hq.displacement ?? `${basePath}/displacement.${ext}`;
    promises.displacementMap = loadHQTexLinear(url, tiling);
  }

  const keys = Object.keys(promises);
  const textures = await Promise.all(Object.values(promises));
  const texMap: Record<string, THREE.Texture> = {};
  keys.forEach((k, i) => { texMap[k] = textures[i]; });

  const matParams: THREE.MeshStandardMaterialParameters = {
    roughness: pack.roughnessValue,
    metalness: pack.metalnessValue,
    side: THREE.FrontSide,
  };

  if (texMap.map) matParams.map = texMap.map;
  if (texMap.normalMap) matParams.normalMap = texMap.normalMap;
  if (texMap.roughnessMap) matParams.roughnessMap = texMap.roughnessMap;
  if (texMap.aoMap) matParams.aoMap = texMap.aoMap;
  if (texMap.displacementMap) {
    matParams.displacementMap = texMap.displacementMap;
    matParams.displacementScale = pack.displacementScale;
  }

  return new THREE.MeshStandardMaterial(matParams);
}

/**
 * Dark velvet fabric texture for the pool table surface.
 * Near-black with a subtle directional sheen and fine micro-fiber noise.
 * Supply tableTextureUrl in config to replace with a real texture image.
 */
export function createVelvetTableTexture(
  width: number = 1024,
  height: number = 1024,
  baseColor: string = '#0d0d0d'
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const r = parseInt(baseColor.slice(1, 3), 16);
  const g = parseInt(baseColor.slice(3, 5), 16);
  const b = parseInt(baseColor.slice(5, 7), 16);

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  // Fine micro-fiber noise (very tight, low amplitude)
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 7;
    data[i]     = Math.max(0, Math.min(255, r + noise));
    data[i + 1] = Math.max(0, Math.min(255, g + noise));
    data[i + 2] = Math.max(0, Math.min(255, b + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  // Subtle directional sheen band (characteristic velvet look)
  const sheen = ctx.createLinearGradient(0, height * 0.25, 0, height * 0.75);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.045)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, width, height);

  // Edge vignette
  const vignette = ctx.createRadialGradient(
    width / 2, height / 2, 0,
    width / 2, height / 2, Math.max(width, height) * 0.62
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Dark cement / concrete wall texture for the studio backdrop.
 * Supply wallTextureUrl in config to replace with a real texture image.
 */
export function createCementWallTexture(
  width: number = 1024,
  height: number = 1024,
  baseColor: string = '#161616'
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const r = parseInt(baseColor.slice(1, 3), 16);
  const g = parseInt(baseColor.slice(3, 5), 16);
  const b = parseInt(baseColor.slice(5, 7), 16);

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  // Coarse aggregate patches (cement grain look)
  for (let py = 0; py < height; py += 10) {
    for (let px = 0; px < width; px += 10) {
      const variation = (Math.random() - 0.5) * 14;
      const nr = Math.max(0, Math.min(255, r + variation));
      const ng = Math.max(0, Math.min(255, g + variation));
      const nb = Math.max(0, Math.min(255, b + variation));
      ctx.fillStyle = `rgb(${nr},${ng},${nb})`;
      const sz = 7 + Math.random() * 5;
      ctx.fillRect(px, py, sz, sz);
    }
  }

  // Fine noise pass over coarse
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 8;
    data[i]     = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
  }
  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(6, 6);
  texture.needsUpdate = true;
  return texture;
}

// ─── Legacy fabric texture (kept for backward compat with image extractor) ───

export function createFabricTexture(
  width: number = 1024,
  height: number = 1024,
  baseColor: string = '#2a2a2a'
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  const r = parseInt(baseColor.slice(1, 3), 16);
  const g = parseInt(baseColor.slice(3, 5), 16);
  const b = parseInt(baseColor.slice(5, 7), 16);

  const weaveSize = 4;
  for (let y = 0; y < height; y += weaveSize) {
    for (let x = 0; x < width; x += weaveSize) {
      const isHorizontal = (Math.floor(x / weaveSize) + Math.floor(y / weaveSize)) % 2 === 0;
      const variation = (Math.random() - 0.5) * 15;
      const nr = Math.max(0, Math.min(255, r + variation));
      const ng = Math.max(0, Math.min(255, g + variation));
      const nb = Math.max(0, Math.min(255, b + variation));
      ctx.fillStyle = `rgb(${nr}, ${ng}, ${nb})`;
      if (isHorizontal) {
        ctx.fillRect(x, y, weaveSize, weaveSize - 1);
      } else {
        ctx.fillRect(x, y, weaveSize - 1, weaveSize);
      }
    }
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 8;
    data[i]     = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  const gradient = ctx.createRadialGradient(
    width / 2, height / 2, 0,
    width / 2, height / 2, Math.max(width, height) * 0.7
  );
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
  gradient.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0.3)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  texture.needsUpdate = true;
  return texture;
}

// ─── Scene geometry helpers ───

/**
 * Flat vertical wall backdrop.
 * Accepts a Texture (legacy) or pre-built MeshStandardMaterial (PBR).
 */
export function createWallBackdrop(
  textureOrMaterial: THREE.Texture | THREE.MeshStandardMaterial,
  width: number = 30,
  height: number = 14
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = textureOrMaterial instanceof THREE.MeshStandardMaterial
    ? textureOrMaterial
    : new THREE.MeshStandardMaterial({
        map: textureOrMaterial,
        roughness: 0.95,
        metalness: 0,
        side: THREE.FrontSide,
      });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.position.set(0, 3.0, -5.5);
  return mesh;
}


export function createShadowFloor(width: number = 20, depth: number = 10): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, depth);
  const material = new THREE.ShadowMaterial({ opacity: 0.25 });
  const floor = new THREE.Mesh(geometry, material);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  return floor;
}

/** Shadow-receiving plane for wall backdrop (vertical orientation). */
export function createWallShadowPlane(width: number = 30, height: number = 14): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.ShadowMaterial({ opacity: 0.15 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Single L-shaped shadow receiver spanning both wall and table surface.
 * Eliminates the seam between separate floor/wall shadow planes and ensures
 * uniform shadow intensity across the corner.
 * Small offsets are baked into vertices to avoid z-fighting with the actual surfaces.
 */
export function createLShapedShadowMesh(
  wallWidth: number,
  wallHeight: number,
  floorDepth: number,
  cornerY: number,
  wallZ: number,
  opacity: number = 0.25
): THREE.Mesh {
  const hw = wallWidth / 2;
  const floorFrontZ = wallZ + floorDepth;
  // Z-fighting offsets: wall pushed slightly forward, floor pushed slightly up
  const wallOff = 0.15;   // wall face z offset
  const floorOff = 0.02;  // floor face y offset

  // Wall face vertices (offset forward in Z)
  const w0 = [-hw, cornerY,              wallZ + wallOff];
  const w1 = [ hw, cornerY,              wallZ + wallOff];
  const w2 = [-hw, cornerY + wallHeight, wallZ + wallOff];
  const w3 = [ hw, cornerY + wallHeight, wallZ + wallOff];

  // Floor face vertices (offset up in Y)
  const f0 = [-hw, cornerY + floorOff, wallZ];
  const f1 = [ hw, cornerY + floorOff, wallZ];
  const f2 = [-hw, cornerY + floorOff, floorFrontZ];
  const f3 = [ hw, cornerY + floorOff, floorFrontZ];

  const vertices = new Float32Array([
    // Wall face (2 triangles) — facing +Z
    ...w0, ...w1, ...w3,
    ...w0, ...w3, ...w2,
    // Floor face (2 triangles) — facing +Y
    ...f0, ...f3, ...f1,
    ...f0, ...f2, ...f3,
  ]);

  const normals = new Float32Array([
    // Wall face normals
    0, 0, 1,  0, 0, 1,  0, 0, 1,
    0, 0, 1,  0, 0, 1,  0, 0, 1,
    // Floor face normals
    0, 1, 0,  0, 1, 0,  0, 1, 0,
    0, 1, 0,  0, 1, 0,  0, 1, 0,
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

  const material = new THREE.ShadowMaterial({ opacity });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Horizontal table surface.
 * Accepts a Texture (legacy) or pre-built MeshStandardMaterial (PBR).
 */
export function createTableSurface(
  textureOrMaterial: THREE.Texture | THREE.MeshStandardMaterial,
  width: number = 28,
  depth: number = 5,
  yPosition: number = -0.4
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, depth);
  const material = textureOrMaterial instanceof THREE.MeshStandardMaterial
    ? textureOrMaterial
    : new THREE.MeshStandardMaterial({
        map: textureOrMaterial,
        roughness: 0.35,
        metalness: 0.0,
        side: THREE.FrontSide,
      });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = yPosition;
  mesh.receiveShadow = true;
  return mesh;
}

/** Legacy cyclorama backdrop — kept for image extractor compatibility */
export function createStudioBackdrop(
  texture: THREE.Texture,
  width: number = 20,
  height: number = 15,
  curveDepth: number = 5
): THREE.Mesh {
  const segments = 64;
  const geometry = new THREE.PlaneGeometry(width, height, segments, segments);
  const positionAttribute = geometry.getAttribute('position');

  for (let i = 0; i < positionAttribute.count; i++) {
    const y = positionAttribute.getY(i);
    const normalizedY = (y + height / 2) / height;
    if (normalizedY < 0.3) {
      const curveAmount = Math.pow(1 - normalizedY / 0.3, 2) * curveDepth;
      positionAttribute.setZ(i, -curveAmount);
    }
  }

  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.9,
    metalness: 0,
    side: THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.position.set(0, 0, -3);
  return mesh;
}
