import * as THREE from 'three';

export function createFabricTexture(
  width: number = 1024,
  height: number = 1024,
  baseColor: string = '#2a2a2a'
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // 1. Fill base color
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  // 2. Parse base color to RGB for variations
  const r = parseInt(baseColor.slice(1, 3), 16);
  const g = parseInt(baseColor.slice(3, 5), 16);
  const b = parseInt(baseColor.slice(5, 7), 16);

  // 3. Weave pattern (alternating squares with slight variation)
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

  // 4. Add noise
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 8;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  // 5. Vignette
  const gradient = ctx.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.7
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

export function createStudioBackdrop(
  texture: THREE.Texture,
  width: number = 20,
  height: number = 15,
  curveDepth: number = 5
): THREE.Mesh {
  const segments = 64;
  const geometry = new THREE.PlaneGeometry(width, height, segments, segments);
  const positionAttribute = geometry.getAttribute('position');

  // Curve bottom portion back (cyclorama style)
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

export function createShadowFloor(width: number = 20, depth: number = 10): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, depth);
  const material = new THREE.ShadowMaterial({
    opacity: 0.4,
  });

  const floor = new THREE.Mesh(geometry, material);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2;
  floor.receiveShadow = true;

  return floor;
}
