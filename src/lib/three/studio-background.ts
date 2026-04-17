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
        tex.anisotropy = 8;
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
        tex.anisotropy = 8;
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
        tex.anisotropy = 8;
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
 * 
 * Uses a curved corner section (like a photo studio cyclorama backdrop) to
 * create a smooth seamless transition between wall and floor with no visible seam.
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
  
  // Z-fighting offsets to sit slightly in front of base surfaces
  const surfaceOff = 0.01;
  
  // Curved corner parameters (cyclorama-style smooth transition)
  const cornerRadius = 0.8;  // Radius of the curved corner section
  const cornerSegments = 8;  // Number of segments in the curve
  
  // Calculate positions with offset
  const wallFaceZ = wallZ + surfaceOff;
  const floorFaceY = cornerY + surfaceOff;
  
  // Build vertices array dynamically
  const positions: number[] = [];
  const normals: number[] = [];
  
  // Wall face (from corner up to top) — facing +Z
  const wallBottom = cornerY + cornerRadius;  // Wall starts above corner curve
  const w0 = [-hw, wallBottom, wallFaceZ];
  const w1 = [ hw, wallBottom, wallFaceZ];
  const w2 = [-hw, cornerY + wallHeight, wallFaceZ];
  const w3 = [ hw, cornerY + wallHeight, wallFaceZ];
  
  // Wall triangles
  positions.push(...w0, ...w1, ...w3);
  positions.push(...w0, ...w3, ...w2);
  normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
  normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
  
  // Curved corner section (quarter circle from wall to floor)
  // Goes from (wallZ, cornerY + cornerRadius) to (wallZ + cornerRadius, cornerY)
  for (let i = 0; i < cornerSegments; i++) {
    const angle0 = (i / cornerSegments) * (Math.PI / 2);
    const angle1 = ((i + 1) / cornerSegments) * (Math.PI / 2);
    
    // Corner curve center is at (wallZ + cornerRadius, cornerY + cornerRadius)
    const centerZ = wallZ + cornerRadius;
    const centerY = cornerY + cornerRadius;
    
    // Points on the curve (offset slightly for z-fighting)
    const y0 = centerY - cornerRadius * Math.cos(angle0);
    const z0 = centerZ - cornerRadius * Math.sin(angle0) + surfaceOff;
    const y1 = centerY - cornerRadius * Math.cos(angle1);
    const z1 = centerZ - cornerRadius * Math.sin(angle1) + surfaceOff;
    
    // Normal direction (pointing outward from curve center)
    const nx0 = 0;
    const ny0 = Math.cos(angle0);
    const nz0 = Math.sin(angle0);
    const nx1 = 0;
    const ny1 = Math.cos(angle1);
    const nz1 = Math.sin(angle1);
    
    // Two triangles per segment (left edge to right edge)
    const c0L = [-hw, y0, z0];
    const c0R = [ hw, y0, z0];
    const c1L = [-hw, y1, z1];
    const c1R = [ hw, y1, z1];
    
    positions.push(...c0L, ...c0R, ...c1R);
    positions.push(...c0L, ...c1R, ...c1L);
    normals.push(nx0, ny0, nz0, nx0, ny0, nz0, nx1, ny1, nz1);
    normals.push(nx0, ny0, nz0, nx1, ny1, nz1, nx1, ny1, nz1);
  }
  
  // Floor face (from corner curve to front) — facing +Y
  const floorBackZ = wallZ + cornerRadius;  // Floor starts after corner curve
  const f0 = [-hw, floorFaceY, floorBackZ];
  const f1 = [ hw, floorFaceY, floorBackZ];
  const f2 = [-hw, floorFaceY, floorFrontZ];
  const f3 = [ hw, floorFaceY, floorFrontZ];
  
  // Floor triangles
  positions.push(...f0, ...f3, ...f1);
  positions.push(...f0, ...f2, ...f3);
  normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));

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

/**
 * Create a cyclorama-style studio backdrop mesh with wall, curved corner, and floor.
 * Uses MeshBasicMaterial so it's unaffected by HDRI lighting (pure white/colored backdrop).
 * The geometry has a smooth curved transition at the wall-floor corner.
 */
export function createCycloramaBackdrop(
  wallWidth: number,
  wallHeight: number,
  floorDepth: number,
  cornerY: number,
  wallZ: number,
  color: THREE.Color | string = '#ffffff'
): THREE.Mesh {
  const hw = wallWidth / 2;
  const floorFrontZ = wallZ + floorDepth;
  
  // Curved corner parameters (must match L-shaped shadow mesh)
  const cornerRadius = 0.8;
  const cornerSegments = 8;
  
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  
  // Wall face (from corner curve up to top)
  const wallBottom = cornerY + cornerRadius;
  const wallTop = cornerY + wallHeight;
  
  // Wall quad (2 triangles)
  positions.push(-hw, wallBottom, wallZ);
  positions.push( hw, wallBottom, wallZ);
  positions.push( hw, wallTop, wallZ);
  positions.push(-hw, wallBottom, wallZ);
  positions.push( hw, wallTop, wallZ);
  positions.push(-hw, wallTop, wallZ);
  for (let i = 0; i < 6; i++) normals.push(0, 0, 1);
  uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  
  // Curved corner section
  for (let i = 0; i < cornerSegments; i++) {
    const angle0 = (i / cornerSegments) * (Math.PI / 2);
    const angle1 = ((i + 1) / cornerSegments) * (Math.PI / 2);
    
    const centerZ = wallZ + cornerRadius;
    const centerY = cornerY + cornerRadius;
    
    const y0 = centerY - cornerRadius * Math.cos(angle0);
    const z0 = centerZ - cornerRadius * Math.sin(angle0);
    const y1 = centerY - cornerRadius * Math.cos(angle1);
    const z1 = centerZ - cornerRadius * Math.sin(angle1);
    
    const ny0 = Math.cos(angle0);
    const nz0 = Math.sin(angle0);
    const ny1 = Math.cos(angle1);
    const nz1 = Math.sin(angle1);
    
    // Two triangles per segment
    positions.push(-hw, y0, z0);
    positions.push( hw, y0, z0);
    positions.push( hw, y1, z1);
    positions.push(-hw, y0, z0);
    positions.push( hw, y1, z1);
    positions.push(-hw, y1, z1);
    
    normals.push(0, ny0, nz0, 0, ny0, nz0, 0, ny1, nz1);
    normals.push(0, ny0, nz0, 0, ny1, nz1, 0, ny1, nz1);
    
    const u0 = i / cornerSegments;
    const u1 = (i + 1) / cornerSegments;
    uvs.push(0, u0, 1, u0, 1, u1, 0, u0, 1, u1, 0, u1);
  }
  
  // Floor face
  const floorBackZ = wallZ + cornerRadius;
  positions.push(-hw, cornerY, floorBackZ);
  positions.push( hw, cornerY, floorFrontZ);
  positions.push( hw, cornerY, floorBackZ);
  positions.push(-hw, cornerY, floorBackZ);
  positions.push(-hw, cornerY, floorFrontZ);
  positions.push( hw, cornerY, floorFrontZ);
  for (let i = 0; i < 6; i++) normals.push(0, 1, 0);
  uvs.push(0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1);
  
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  
  const material = new THREE.MeshBasicMaterial({
    color: typeof color === 'string' ? new THREE.Color(color) : color,
    side: THREE.FrontSide,
  });
  
  const mesh = new THREE.Mesh(geometry, material);
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
