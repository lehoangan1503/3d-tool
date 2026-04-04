import * as THREE from 'three';

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
 * Flat vertical wall backdrop for cement wall background.
 * No cyclorama curve — just a plain vertical plane far from the cue.
 */
export function createWallBackdrop(
  texture: THREE.Texture,
  width: number = 30,
  height: number = 14
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  // Elevated so bottom edge is above table, creating visible gap
  // z=-5.5: far from cue, with gap visible between table edge and wall
  mesh.position.set(0, 3.0, -5.5);
  return mesh;
}


export function createShadowFloor(width: number = 20, depth: number = 10): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, depth);
  const material = new THREE.ShadowMaterial({ opacity: 0.4 });
  const floor = new THREE.Mesh(geometry, material);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.38;
  floor.receiveShadow = true;
  return floor;
}

/**
 * Horizontal table surface (dark velvet).
 * depth is kept shallow so the far edge is visible, creating a gap to the wall.
 * Replace with tableTextureUrl for a real texture (TextureLoader in scene manager).
 */
export function createTableSurface(
  texture: THREE.Texture,
  width: number = 28,
  depth: number = 5,
  yPosition: number = -0.4
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, depth);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.35,
    metalness: 0.0,
    side: THREE.DoubleSide,
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
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.position.set(0, 0, -3);
  return mesh;
}
