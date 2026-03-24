# Image & Video Extractor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Image Extractor (3-part cue views at 45° angle) and Video Extractor (rotating cue video with studio background) features to the product editor.

**Architecture:** 
- Extend `SceneManager` with dedicated capture methods for still images and video recording
- Create new UI components with separate Three.js scenes for isolated part rendering
- Use `MediaRecorder` API for video capture and canvas `toDataURL` for images
- Implement studio-quality lighting and gray fabric background for video

**Tech Stack:** Three.js, React, MediaRecorder API, Canvas API, WebGL, Web Workers (for encoding)

---

## Feature 1: Image Extractor

### Requirements Analysis

Based on the reference image showing 3 cue parts at 45° angle:
1. **Bottom Bump** - Large view of the bumper/rubber section
2. **Center Whole Cue** - Small full cue view centered
3. **Top Joint Cap** - Large view of the joint/cap section

**Output:** 2048x2048 PNG image with 3 isolated parts
**Angle:** 45° with Y vertical axis
**Controls:** User can adjust position/zoom for each part
**Default:** Pre-configured optimal positions for minimal user adjustment

---

## Feature 2: Video Extractor

### Requirements Analysis

Based on the reference image showing cue at 30° angle with fabric background:
1. **Angle:** 30° with Y vertical (cue tilted to right)
2. **Background:** Gray fabric material (studio backdrop texture)
3. **Shadow:** Cue casts shadow for realism
4. **Motion:** Cue rotates at medium speed + camera pans from bump to cap
5. **Resolution:** HD (1920x1080) or 2K (2560x1440)
6. **Duration:** ~10-15 seconds for full pan

---

## Dependencies Analysis

### New Dependencies Required
```json
{
  "ccapture.js": "^1.1.0"  // For high-quality video capture (optional, can use MediaRecorder)
}
```

### Existing Dependencies Used
- `three` - 3D rendering
- `@types/three` - TypeScript support
- React hooks for state management

---

## Task Breakdown

### Phase 1: Core Infrastructure (Tasks 1-4)

### Task 1: Create Extractor Types and Interfaces

**Files:**
- Create: `src/types/extractor.ts`

**Step 1: Create type definitions**

```typescript
// src/types/extractor.ts

export interface ImageExtractorConfig {
  // Output settings
  width: number;       // Default: 2048
  height: number;      // Default: 2048
  format: 'png' | 'jpeg' | 'webp';
  quality: number;     // 0-1 for jpeg/webp

  // Part configurations
  parts: {
    bottomBump: PartViewConfig;
    centerCue: PartViewConfig;
    topCap: PartViewConfig;
  };
}

export interface PartViewConfig {
  // Camera position relative to part center
  cameraDistance: number;
  cameraAngleY: number;  // Rotation around Y axis (radians)
  cameraAngleX: number;  // Tilt angle (radians) - 45° = Math.PI/4
  
  // Part bounds in output image (normalized 0-1)
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  
  // Zoom level
  zoom: number;
}

export interface VideoExtractorConfig {
  // Output settings
  width: number;        // Default: 1920 (HD) or 2560 (2K)
  height: number;       // Default: 1080 (HD) or 1440 (2K)
  fps: number;          // Default: 30
  duration: number;     // Total seconds
  format: 'webm' | 'mp4';
  bitrate: number;      // bits per second

  // Scene settings
  cueAngle: number;           // 30° = Math.PI/6 radians
  rotationSpeed: number;      // Radians per second
  panStartY: number;          // Start Y position (bottom)
  panEndY: number;            // End Y position (top)
  
  // Background
  backgroundType: 'fabric' | 'solid' | 'gradient';
  backgroundColor: string;
  fabricTextureUrl?: string;

  // Shadow
  enableShadow: boolean;
  shadowIntensity: number;
  shadowBlur: number;
}

export interface ExtractorState {
  isExtracting: boolean;
  progress: number;        // 0-100
  previewUrl: string | null;
  error: string | null;
}

// Default configurations
export const DEFAULT_IMAGE_CONFIG: ImageExtractorConfig = {
  width: 2048,
  height: 2048,
  format: 'png',
  quality: 1,
  parts: {
    bottomBump: {
      cameraDistance: 1.2,
      cameraAngleY: 0,
      cameraAngleX: Math.PI / 4,  // 45°
      bounds: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      zoom: 2.5,
    },
    centerCue: {
      cameraDistance: 3,
      cameraAngleY: 0,
      cameraAngleX: Math.PI / 4,  // 45°
      bounds: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
      zoom: 1,
    },
    topCap: {
      cameraDistance: 1.2,
      cameraAngleY: 0,
      cameraAngleX: Math.PI / 4,  // 45°
      bounds: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      zoom: 2.5,
    },
  },
};

export const DEFAULT_VIDEO_CONFIG: VideoExtractorConfig = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 12,
  format: 'webm',
  bitrate: 8000000,  // 8 Mbps
  cueAngle: Math.PI / 6,  // 30°
  rotationSpeed: Math.PI / 3,  // 60° per second
  panStartY: -1.5,
  panEndY: 1.5,
  backgroundType: 'fabric',
  backgroundColor: '#2a2a2a',
  fabricTextureUrl: '/textures/studio/gray-fabric.jpg',
  enableShadow: true,
  shadowIntensity: 0.6,
  shadowBlur: 2,
};

export type ExtractorQuality = 'hd' | '2k';

export const QUALITY_PRESETS: Record<ExtractorQuality, Partial<VideoExtractorConfig>> = {
  hd: { width: 1920, height: 1080, bitrate: 8000000 },
  '2k': { width: 2560, height: 1440, bitrate: 16000000 },
};
```

**Step 2: Commit**

```bash
git add src/types/extractor.ts
git commit -m "feat(extractor): add type definitions for image and video extractors"
```

---

### Task 2: Create Studio Background Texture

**Files:**
- Create: `public/textures/studio/gray-fabric.jpg` (download/create)
- Create: `src/lib/three/studio-background.ts`

**Step 1: Create studio background utilities**

```typescript
// src/lib/three/studio-background.ts

import * as THREE from 'three';

/**
 * Creates a procedural fabric texture for studio background
 * Uses canvas to generate a subtle woven fabric pattern
 */
export function createFabricTexture(
  width: number = 1024,
  height: number = 1024,
  baseColor: string = '#2a2a2a'
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Base color
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  // Parse base color to RGB
  const r = parseInt(baseColor.slice(1, 3), 16);
  const g = parseInt(baseColor.slice(3, 5), 16);
  const b = parseInt(baseColor.slice(5, 7), 16);

  // Add fabric weave pattern
  const weaveSize = 4;
  for (let y = 0; y < height; y += weaveSize) {
    for (let x = 0; x < width; x += weaveSize) {
      // Alternating pattern for woven look
      const isHorizontal = (Math.floor(x / weaveSize) + Math.floor(y / weaveSize)) % 2 === 0;
      
      // Add subtle variation
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

  // Add subtle noise for realism
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 8;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  // Add subtle vignette
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

/**
 * Creates a curved backdrop plane for studio look
 */
export function createStudioBackdrop(
  texture: THREE.Texture,
  width: number = 20,
  height: number = 15,
  curveDepth: number = 5
): THREE.Mesh {
  // Create curved geometry (cyclorama style)
  const segments = 64;
  const geometry = new THREE.PlaneGeometry(width, height, segments, segments);
  const positionAttribute = geometry.getAttribute('position');
  
  for (let i = 0; i < positionAttribute.count; i++) {
    const y = positionAttribute.getY(i);
    const normalizedY = (y + height / 2) / height;
    
    // Curve the bottom portion back
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

/**
 * Creates a shadow-receiving floor plane
 */
export function createShadowFloor(
  width: number = 20,
  depth: number = 10
): THREE.Mesh {
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
```

**Step 2: Commit**

```bash
git add src/lib/three/studio-background.ts
git commit -m "feat(extractor): add studio background utilities for video extractor"
```

---

### Task 3: Create ExtractorSceneManager Class

**Files:**
- Create: `src/lib/three/extractor-scene-manager.ts`

**Step 1: Create the extractor scene manager**

```typescript
// src/lib/three/extractor-scene-manager.ts

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { ImageExtractorConfig, VideoExtractorConfig, PartViewConfig } from '@/types/extractor';
import { createFabricTexture, createStudioBackdrop, createShadowFloor } from './studio-background';

/**
 * Specialized SceneManager for high-quality image and video extraction.
 * Supports:
 * - Multi-part image capture at 45° angle
 * - Video recording with studio backdrop and shadows
 * - Independent from main preview SceneManager
 */
export class ExtractorSceneManager {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private model: THREE.Group | null = null;
  private clonedModel: THREE.Group | null = null;
  private pmremGenerator: THREE.PMREMGenerator;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private isDisposed = false;

  // Studio elements (for video)
  private backdrop: THREE.Mesh | null = null;
  private shadowFloor: THREE.Mesh | null = null;
  private spotLight: THREE.SpotLight | null = null;
  private fillLights: THREE.PointLight[] = [];

  // Animation state
  private animationFrameId: number | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  constructor(
    private width: number = 2048,
    private height: number = 2048
  ) {
    // Create offscreen renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(1); // Fixed for consistent output
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a1a);

    // Camera
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    this.camera.position.set(2, 0, 2);

    // PMREM for HDRI
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    // Basic lighting
    this.setupBasicLighting();
  }

  private setupBasicLighting() {
    // Ambient for fill
    const ambient = new THREE.AmbientLight(0xffffff, 0.3);
    this.scene.add(ambient);

    // Hemisphere for natural gradient
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
    this.scene.add(hemi);
  }

  /**
   * Setup studio lighting for video capture
   */
  setupStudioLighting(config: VideoExtractorConfig) {
    // Remove existing studio lights
    this.clearStudioElements();

    // Key light (main spot)
    this.spotLight = new THREE.SpotLight(0xffffff, 2);
    this.spotLight.position.set(3, 4, 2);
    this.spotLight.angle = Math.PI / 4;
    this.spotLight.penumbra = 0.5;
    this.spotLight.decay = 1.5;
    this.spotLight.distance = 20;
    this.spotLight.castShadow = true;
    this.spotLight.shadow.mapSize.width = 2048;
    this.spotLight.shadow.mapSize.height = 2048;
    this.spotLight.shadow.camera.near = 0.5;
    this.spotLight.shadow.camera.far = 20;
    this.spotLight.shadow.bias = -0.0001;
    this.spotLight.shadow.radius = config.shadowBlur;
    this.scene.add(this.spotLight);

    // Fill lights
    const fillPositions = [
      [-2, 1, 2],
      [0, -2, 3],
      [2, 0, -1],
    ];
    fillPositions.forEach(([x, y, z]) => {
      const fill = new THREE.PointLight(0xffffff, 0.3);
      fill.position.set(x, y, z);
      this.fillLights.push(fill);
      this.scene.add(fill);
    });

    // Backdrop
    const fabricTexture = createFabricTexture(1024, 1024, config.backgroundColor);
    this.backdrop = createStudioBackdrop(fabricTexture);
    this.scene.add(this.backdrop);

    // Shadow floor
    if (config.enableShadow) {
      this.shadowFloor = createShadowFloor();
      this.scene.add(this.shadowFloor);
    }
  }

  private clearStudioElements() {
    if (this.spotLight) {
      this.scene.remove(this.spotLight);
      this.spotLight.dispose();
      this.spotLight = null;
    }
    this.fillLights.forEach(light => {
      this.scene.remove(light);
      light.dispose();
    });
    this.fillLights = [];
    if (this.backdrop) {
      this.scene.remove(this.backdrop);
      (this.backdrop.material as THREE.Material).dispose();
      this.backdrop.geometry.dispose();
      this.backdrop = null;
    }
    if (this.shadowFloor) {
      this.scene.remove(this.shadowFloor);
      (this.shadowFloor.material as THREE.Material).dispose();
      this.shadowFloor.geometry.dispose();
      this.shadowFloor = null;
    }
  }

  /**
   * Load HDRI environment
   */
  async loadHDRI(hdriUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const loader = new RGBELoader();
      loader.load(
        hdriUrl,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          const rt = this.pmremGenerator.fromEquirectangular(texture);
          texture.dispose();
          
          if (this.envRenderTarget) {
            this.envRenderTarget.dispose();
          }
          this.envRenderTarget = rt;
          this.scene.environment = rt.texture;
          resolve();
        },
        undefined,
        reject
      );
    });
  }

  /**
   * Clone model from main SceneManager
   */
  setModel(sourceModel: THREE.Group) {
    // Remove existing
    if (this.clonedModel) {
      this.scene.remove(this.clonedModel);
      this.disposeModel(this.clonedModel);
    }

    // Deep clone
    this.clonedModel = sourceModel.clone(true);
    
    // Enable shadow casting on all meshes
    this.clonedModel.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = false;
      }
    });

    this.model = this.clonedModel;
    this.scene.add(this.clonedModel);
  }

  private disposeModel(model: THREE.Group) {
    model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }

  /**
   * Position camera for a specific part view
   */
  private positionCameraForPart(partConfig: PartViewConfig, partCenterY: number) {
    const { cameraDistance, cameraAngleX, cameraAngleY, zoom } = partConfig;

    // Calculate camera position from spherical coordinates
    const x = cameraDistance * Math.sin(cameraAngleY) * Math.cos(cameraAngleX);
    const y = partCenterY + cameraDistance * Math.sin(cameraAngleX);
    const z = cameraDistance * Math.cos(cameraAngleY) * Math.cos(cameraAngleX);

    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, partCenterY, 0);
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Capture a single frame as data URL
   */
  captureFrame(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * Capture image with 3 parts layout
   */
  async captureImageParts(config: ImageExtractorConfig): Promise<string> {
    if (!this.model) {
      throw new Error('No model loaded');
    }

    // Resize renderer for output
    this.renderer.setSize(config.width, config.height);
    this.camera.aspect = config.width / config.height;
    this.camera.updateProjectionMatrix();

    // Create output canvas
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = config.width;
    outputCanvas.height = config.height;
    const ctx = outputCanvas.getContext('2d')!;

    // Clear with transparent background
    ctx.clearRect(0, 0, config.width, config.height);

    // Get model bounding box to determine part centers
    const box = new THREE.Box3().setFromObject(this.model);
    const modelHeight = box.max.y - box.min.y;
    const modelCenter = box.getCenter(new THREE.Vector3());

    // Part Y positions (relative to model)
    const partYPositions = {
      bottomBump: modelCenter.y - modelHeight * 0.4,  // Bottom 20%
      centerCue: modelCenter.y,                        // Center
      topCap: modelCenter.y + modelHeight * 0.4,      // Top 20%
    };

    // Set model rotation for 45° view
    this.model.rotation.set(0, Math.PI / 4, 0);

    // Render each part
    for (const [partName, partConfig] of Object.entries(config.parts)) {
      const partKey = partName as keyof typeof config.parts;
      const partCenterY = partYPositions[partKey];

      // Position camera
      this.positionCameraForPart(partConfig, partCenterY);

      // Render
      this.renderer.render(this.scene, this.camera);

      // Copy to output canvas at specified bounds
      const { x, y, width, height } = partConfig.bounds;
      const destX = x * config.width;
      const destY = y * config.height;
      const destW = width * config.width;
      const destH = height * config.height;

      ctx.drawImage(
        this.renderer.domElement,
        0, 0, config.width, config.height,
        destX, destY, destW, destH
      );
    }

    // Export based on format
    let dataUrl: string;
    switch (config.format) {
      case 'jpeg':
        dataUrl = outputCanvas.toDataURL('image/jpeg', config.quality);
        break;
      case 'webp':
        dataUrl = outputCanvas.toDataURL('image/webp', config.quality);
        break;
      default:
        dataUrl = outputCanvas.toDataURL('image/png');
    }

    return dataUrl;
  }

  /**
   * Start video recording
   */
  async startVideoRecording(
    config: VideoExtractorConfig,
    onProgress?: (progress: number) => void
  ): Promise<Blob> {
    if (!this.model) {
      throw new Error('No model loaded');
    }

    return new Promise((resolve, reject) => {
      // Setup renderer for video
      this.renderer.setSize(config.width, config.height);
      this.camera.aspect = config.width / config.height;
      this.camera.updateProjectionMatrix();

      // Setup studio
      this.setupStudioLighting(config);

      // Set model angle
      this.model!.rotation.set(0, 0, -config.cueAngle); // Tilt to right

      // Get model bounds for pan
      const box = new THREE.Box3().setFromObject(this.model!);
      const modelHeight = box.max.y - box.min.y;

      // Recording setup
      const stream = this.renderer.domElement.captureStream(config.fps);
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: config.format === 'webm' ? 'video/webm;codecs=vp9' : 'video/mp4',
        videoBitsPerSecond: config.bitrate,
      });

      this.recordedChunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, {
          type: config.format === 'webm' ? 'video/webm' : 'video/mp4',
        });
        resolve(blob);
      };

      this.mediaRecorder.onerror = (e) => {
        reject(new Error('Recording failed'));
      };

      // Animation state
      const totalFrames = config.fps * config.duration;
      let currentFrame = 0;
      const startTime = performance.now();

      // Camera start position (zoomed in at bottom)
      const cameraDistance = 2;

      const animate = () => {
        if (this.isDisposed || currentFrame >= totalFrames) {
          this.mediaRecorder?.stop();
          this.animationFrameId = null;
          return;
        }

        const progress = currentFrame / totalFrames;
        onProgress?.(Math.round(progress * 100));

        // Rotate model
        this.model!.rotation.y += config.rotationSpeed / config.fps;

        // Pan camera from bottom to top
        const panY = config.panStartY + (config.panEndY - config.panStartY) * progress;
        this.camera.position.set(
          cameraDistance * Math.cos(Math.PI / 6),
          panY,
          cameraDistance * Math.sin(Math.PI / 6)
        );
        this.camera.lookAt(0, panY, 0);

        // Render
        this.renderer.render(this.scene, this.camera);

        currentFrame++;
        this.animationFrameId = requestAnimationFrame(animate);
      };

      // Start recording
      this.mediaRecorder.start();
      animate();
    });
  }

  /**
   * Stop video recording
   */
  stopRecording() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
  }

  /**
   * Get renderer canvas for preview
   */
  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * Resize renderer
   */
  resize(width: number, height: number) {
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Cleanup
   */
  dispose() {
    this.isDisposed = true;
    this.stopRecording();
    this.clearStudioElements();

    if (this.clonedModel) {
      this.scene.remove(this.clonedModel);
      this.disposeModel(this.clonedModel);
    }

    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
    }

    this.pmremGenerator.dispose();
    this.renderer.dispose();
  }
}
```

**Step 2: Commit**

```bash
git add src/lib/three/extractor-scene-manager.ts
git commit -m "feat(extractor): add ExtractorSceneManager for image/video capture"
```

---

### Task 4: Add Extractor Methods to Main SceneManager

**Files:**
- Modify: `src/lib/three/scene-manager.ts`

**Step 1: Add getter and clone methods to SceneManager**

Add these methods at the end of the SceneManager class (before the closing brace, around line 1170):

```typescript
  /**
   * Get the current model for cloning (used by extractors)
   */
  getModelForClone(): THREE.Group | null {
    return this.model;
  }

  /**
   * Get current HDRI URL for extractor to use same environment
   */
  getCurrentHdriUrl(): string {
    return this.currentHdriUrl;
  }

  /**
   * Get current material configs for extractor
   */
  getMaterialConfigs() {
    return {
      leatherConfig: { ...this.currentLeatherConfig },
      cylinderConfig: { ...this.currentCylinderConfig },
      jointConfig: { ...this.currentJointConfig },
      bodyRoughness: this.bodyRoughness,
      textureScale: this.textureScale,
      isLeatherProduct: this.isLeatherProduct,
    };
  }

  /**
   * Quick single-frame capture for thumbnail generation
   */
  captureFrame(width: number = 512, height: number = 512): string {
    // Store original size
    const originalWidth = this.container.clientWidth;
    const originalHeight = this.container.clientHeight;

    // Temporarily resize
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Render and capture
    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.renderer.domElement.toDataURL('image/png');

    // Restore original size
    this.renderer.setSize(originalWidth, originalHeight);
    this.camera.aspect = originalWidth / originalHeight;
    this.camera.updateProjectionMatrix();

    return dataUrl;
  }
```

**Step 2: Commit**

```bash
git add src/lib/three/scene-manager.ts
git commit -m "feat(extractor): add model/config getters and captureFrame to SceneManager"
```

---

### Phase 2: Image Extractor Component (Tasks 5-7)

### Task 5: Create Image Extractor UI Component

**Files:**
- Create: `src/components/editor/image-extractor.tsx`

**Step 1: Create the image extractor component**

```typescript
// src/components/editor/image-extractor.tsx

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Camera, Download, RefreshCw, ZoomIn, Move, RotateCcw, Loader2 } from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import type { ImageExtractorConfig, PartViewConfig } from "@/types/extractor";
import { DEFAULT_IMAGE_CONFIG } from "@/types/extractor";

interface ImageExtractorProps {
  sceneManager: SceneManager | null;
  productName: string;
  onClose: () => void;
  open: boolean;
}

type PartKey = "bottomBump" | "centerCue" | "topCap";

const PART_LABELS: Record<PartKey, string> = {
  bottomBump: "Bottom Bump",
  centerCue: "Full Cue",
  topCap: "Top Cap",
};

export function ImageExtractor({ sceneManager, productName, onClose, open }: ImageExtractorProps) {
  const [config, setConfig] = useState<ImageExtractorConfig>(DEFAULT_IMAGE_CONFIG);
  const [selectedPart, setSelectedPart] = useState<PartKey>("centerCue");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // Initialize extractor when dialog opens
  useEffect(() => {
    if (!open || !sceneManager) return;

    const initExtractor = async () => {
      try {
        // Create extractor with preview size
        const extractor = new ExtractorSceneManager(800, 800);
        extractorRef.current = extractor;

        // Clone model from main scene
        const model = sceneManager.getModelForClone();
        if (model) {
          extractor.setModel(model);
        }

        // Load same HDRI
        const hdriUrl = sceneManager.getCurrentHdriUrl();
        await extractor.loadHDRI(hdriUrl);

        // Mount preview canvas
        if (previewContainerRef.current) {
          const canvas = extractor.getCanvas();
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.objectFit = "contain";
          previewContainerRef.current.appendChild(canvas);
        }

        // Generate initial preview
        updatePreview(extractor, config);
      } catch (err) {
        setError("Failed to initialize extractor");
        console.error(err);
      }
    };

    initExtractor();

    return () => {
      if (extractorRef.current) {
        extractorRef.current.dispose();
        extractorRef.current = null;
      }
    };
  }, [open, sceneManager]);

  const updatePreview = useCallback(async (extractor: ExtractorSceneManager, cfg: ImageExtractorConfig) => {
    try {
      const url = await extractor.captureImageParts(cfg);
      setPreviewUrl(url);
    } catch (err) {
      console.error("Preview generation failed:", err);
    }
  }, []);

  // Update preview when config changes
  useEffect(() => {
    if (extractorRef.current && open) {
      updatePreview(extractorRef.current, config);
    }
  }, [config, open, updatePreview]);

  const updatePartConfig = (part: PartKey, updates: Partial<PartViewConfig>) => {
    setConfig(prev => ({
      ...prev,
      parts: {
        ...prev.parts,
        [part]: { ...prev.parts[part], ...updates },
      },
    }));
  };

  const handleGenerate = async () => {
    if (!extractorRef.current) return;

    setIsGenerating(true);
    setError(null);

    try {
      const dataUrl = await extractorRef.current.captureImageParts({
        ...config,
        width: config.width,
        height: config.height,
      });
      setPreviewUrl(dataUrl);
    } catch (err) {
      setError("Failed to generate image");
      console.error(err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!previewUrl) return;

    const link = document.createElement("a");
    link.href = previewUrl;
    link.download = `${productName.replace(/\s+/g, "-")}-cue-parts.${config.format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleReset = () => {
    setConfig(DEFAULT_IMAGE_CONFIG);
  };

  const currentPart = config.parts[selectedPart];

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            Image Extractor
          </DialogTitle>
          <DialogDescription>
            Generate a 2048×2048 image with 3 views of your cue at 45° angle
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
          {/* Preview Panel */}
          <div className="flex-1 flex flex-col min-w-0">
            <div
              ref={previewContainerRef}
              className="flex-1 bg-muted rounded-lg overflow-hidden relative"
              style={{ minHeight: 400 }}
            >
              {previewUrl && (
                <img
                  src={previewUrl}
                  alt="Preview"
                  className="w-full h-full object-contain"
                />
              )}
              {isGenerating && (
                <div className="absolute inset-0 bg-background/80 flex items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              )}
            </div>
          </div>

          {/* Controls Panel */}
          <div className="w-72 flex flex-col gap-4 overflow-y-auto">
            {/* Output Settings */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Output Settings</h4>
              
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Width</Label>
                  <Input
                    type="number"
                    value={config.width}
                    onChange={(e) => setConfig(prev => ({ ...prev, width: parseInt(e.target.value) || 2048 }))}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Height</Label>
                  <Input
                    type="number"
                    value={config.height}
                    onChange={(e) => setConfig(prev => ({ ...prev, height: parseInt(e.target.value) || 2048 }))}
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div>
                <Label className="text-xs">Format</Label>
                <Select
                  value={config.format}
                  onValueChange={(v) => setConfig(prev => ({ ...prev, format: v as "png" | "jpeg" | "webp" }))}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="png">PNG (lossless)</SelectItem>
                    <SelectItem value="jpeg">JPEG (smaller)</SelectItem>
                    <SelectItem value="webp">WebP (modern)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Part Selection */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Adjust Part View</h4>
              
              <div className="flex gap-1">
                {(Object.keys(PART_LABELS) as PartKey[]).map((part) => (
                  <Button
                    key={part}
                    variant={selectedPart === part ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedPart(part)}
                    className="flex-1 text-xs px-2"
                  >
                    {PART_LABELS[part]}
                  </Button>
                ))}
              </div>

              {/* Part Controls */}
              <div className="space-y-3 p-3 bg-muted/50 rounded-lg">
                <div>
                  <Label className="text-xs flex items-center gap-1">
                    <ZoomIn className="h-3 w-3" /> Zoom
                  </Label>
                  <Slider
                    value={[currentPart.zoom]}
                    min={0.5}
                    max={5}
                    step={0.1}
                    onValueChange={([v]) => updatePartConfig(selectedPart, { zoom: v })}
                    className="mt-1"
                  />
                  <span className="text-xs text-muted-foreground">{currentPart.zoom.toFixed(1)}x</span>
                </div>

                <div>
                  <Label className="text-xs flex items-center gap-1">
                    <Move className="h-3 w-3" /> Distance
                  </Label>
                  <Slider
                    value={[currentPart.cameraDistance]}
                    min={0.5}
                    max={5}
                    step={0.1}
                    onValueChange={([v]) => updatePartConfig(selectedPart, { cameraDistance: v })}
                    className="mt-1"
                  />
                  <span className="text-xs text-muted-foreground">{currentPart.cameraDistance.toFixed(1)}</span>
                </div>

                <div>
                  <Label className="text-xs flex items-center gap-1">
                    <RotateCcw className="h-3 w-3" /> Angle (Y)
                  </Label>
                  <Slider
                    value={[currentPart.cameraAngleY * (180 / Math.PI)]}
                    min={-90}
                    max={90}
                    step={5}
                    onValueChange={([v]) => updatePartConfig(selectedPart, { cameraAngleY: v * (Math.PI / 180) })}
                    className="mt-1"
                  />
                  <span className="text-xs text-muted-foreground">{Math.round(currentPart.cameraAngleY * (180 / Math.PI))}°</span>
                </div>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button variant="outline" onClick={handleReset} size="sm">
            <RefreshCw className="h-4 w-4 mr-1" />
            Reset
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} size="sm">
              Cancel
            </Button>
            <Button onClick={handleDownload} disabled={!previewUrl || isGenerating} size="sm">
              <Download className="h-4 w-4 mr-1" />
              Download
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/editor/image-extractor.tsx
git commit -m "feat(extractor): add ImageExtractor dialog component"
```

---

### Task 6: Create Video Extractor UI Component

**Files:**
- Create: `src/components/editor/video-extractor.tsx`

**Step 1: Create the video extractor component**

```typescript
// src/components/editor/video-extractor.tsx

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Video, Download, Play, Square, RefreshCw, Loader2, Settings } from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import type { VideoExtractorConfig, ExtractorQuality } from "@/types/extractor";
import { DEFAULT_VIDEO_CONFIG, QUALITY_PRESETS } from "@/types/extractor";

interface VideoExtractorProps {
  sceneManager: SceneManager | null;
  productName: string;
  onClose: () => void;
  open: boolean;
}

export function VideoExtractor({ sceneManager, productName, onClose, open }: VideoExtractorProps) {
  const [config, setConfig] = useState<VideoExtractorConfig>(DEFAULT_VIDEO_CONFIG);
  const [quality, setQuality] = useState<ExtractorQuality>("hd");
  const [isRecording, setIsRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(true);

  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const previewAnimationRef = useRef<number | null>(null);

  // Initialize extractor when dialog opens
  useEffect(() => {
    if (!open || !sceneManager) return;

    const initExtractor = async () => {
      try {
        const extractor = new ExtractorSceneManager(640, 360); // Preview size
        extractorRef.current = extractor;

        // Clone model
        const model = sceneManager.getModelForClone();
        if (model) {
          extractor.setModel(model);
        }

        // Load HDRI
        const hdriUrl = sceneManager.getCurrentHdriUrl();
        await extractor.loadHDRI(hdriUrl);

        // Setup studio
        extractor.setupStudioLighting(config);

        // Mount canvas
        if (previewContainerRef.current) {
          const canvas = extractor.getCanvas();
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.objectFit = "contain";
          previewContainerRef.current.appendChild(canvas);
        }

        // Start preview animation
        startPreviewAnimation(extractor);
      } catch (err) {
        setError("Failed to initialize video extractor");
        console.error(err);
      }
    };

    initExtractor();

    return () => {
      if (previewAnimationRef.current) {
        cancelAnimationFrame(previewAnimationRef.current);
      }
      if (extractorRef.current) {
        extractorRef.current.dispose();
        extractorRef.current = null;
      }
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [open, sceneManager]);

  const startPreviewAnimation = useCallback((extractor: ExtractorSceneManager) => {
    let rotation = 0;
    
    const animate = () => {
      if (!previewMode) return;
      
      rotation += 0.01;
      // Simple rotation preview - full animation during recording
      extractor.getCanvas(); // Triggers render
      previewAnimationRef.current = requestAnimationFrame(animate);
    };
    
    animate();
  }, [previewMode]);

  // Update config when quality changes
  useEffect(() => {
    const preset = QUALITY_PRESETS[quality];
    setConfig(prev => ({ ...prev, ...preset }));
  }, [quality]);

  const handleStartRecording = async () => {
    if (!extractorRef.current) return;

    setIsRecording(true);
    setProgress(0);
    setError(null);
    setPreviewMode(false);

    // Stop preview animation
    if (previewAnimationRef.current) {
      cancelAnimationFrame(previewAnimationRef.current);
      previewAnimationRef.current = null;
    }

    try {
      // Resize for recording
      extractorRef.current.resize(config.width, config.height);

      const blob = await extractorRef.current.startVideoRecording(
        config,
        (p) => setProgress(p)
      );

      // Create URL for download
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
      const url = URL.createObjectURL(blob);
      setVideoUrl(url);
    } catch (err) {
      setError("Recording failed. Try reducing quality or duration.");
      console.error(err);
    } finally {
      setIsRecording(false);
      setPreviewMode(true);
      // Restart preview
      if (extractorRef.current) {
        extractorRef.current.resize(640, 360);
        startPreviewAnimation(extractorRef.current);
      }
    }
  };

  const handleStopRecording = () => {
    if (extractorRef.current) {
      extractorRef.current.stopRecording();
    }
  };

  const handleDownload = () => {
    if (!videoUrl) return;

    const link = document.createElement("a");
    link.href = videoUrl;
    link.download = `${productName.replace(/\s+/g, "-")}-cue-video.${config.format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleReset = () => {
    setConfig(DEFAULT_VIDEO_CONFIG);
    setQuality("hd");
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="h-5 w-5" />
            Video Extractor
          </DialogTitle>
          <DialogDescription>
            Generate a studio-quality video of your cue rotating with shadow effects
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
          {/* Preview Panel */}
          <div className="flex-1 flex flex-col min-w-0">
            <div
              ref={previewContainerRef}
              className="flex-1 bg-black rounded-lg overflow-hidden relative"
              style={{ minHeight: 360 }}
            >
              {isRecording && (
                <div className="absolute top-2 left-2 flex items-center gap-2 bg-red-600 text-white px-2 py-1 rounded text-sm">
                  <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                  Recording...
                </div>
              )}
              {videoUrl && !isRecording && (
                <video
                  src={videoUrl}
                  controls
                  className="absolute inset-0 w-full h-full object-contain"
                />
              )}
            </div>

            {isRecording && (
              <div className="mt-2">
                <Progress value={progress} className="h-2" />
                <p className="text-xs text-muted-foreground mt-1 text-center">
                  Recording: {progress}%
                </p>
              </div>
            )}
          </div>

          {/* Controls Panel */}
          <div className="w-72 flex flex-col gap-4 overflow-y-auto">
            {/* Quality Preset */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Quality Preset
              </h4>
              
              <Select value={quality} onValueChange={(v) => setQuality(v as ExtractorQuality)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hd">HD (1920×1080)</SelectItem>
                  <SelectItem value="2k">2K (2560×1440)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Video Settings */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Video Settings</h4>
              
              <div>
                <Label className="text-xs">Duration (seconds)</Label>
                <Slider
                  value={[config.duration]}
                  min={5}
                  max={30}
                  step={1}
                  onValueChange={([v]) => setConfig(prev => ({ ...prev, duration: v }))}
                  className="mt-1"
                  disabled={isRecording}
                />
                <span className="text-xs text-muted-foreground">{config.duration}s</span>
              </div>

              <div>
                <Label className="text-xs">Rotation Speed</Label>
                <Slider
                  value={[config.rotationSpeed]}
                  min={0.5}
                  max={3}
                  step={0.1}
                  onValueChange={([v]) => setConfig(prev => ({ ...prev, rotationSpeed: v }))}
                  className="mt-1"
                  disabled={isRecording}
                />
                <span className="text-xs text-muted-foreground">{config.rotationSpeed.toFixed(1)} rad/s</span>
              </div>

              <div>
                <Label className="text-xs">Cue Angle</Label>
                <Slider
                  value={[config.cueAngle * (180 / Math.PI)]}
                  min={0}
                  max={45}
                  step={5}
                  onValueChange={([v]) => setConfig(prev => ({ ...prev, cueAngle: v * (Math.PI / 180) }))}
                  className="mt-1"
                  disabled={isRecording}
                />
                <span className="text-xs text-muted-foreground">{Math.round(config.cueAngle * (180 / Math.PI))}°</span>
              </div>
            </div>

            {/* Background Settings */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Background</h4>
              
              <div>
                <Label className="text-xs">Background Color</Label>
                <div className="flex gap-2 items-center mt-1">
                  <input
                    type="color"
                    value={config.backgroundColor}
                    onChange={(e) => setConfig(prev => ({ ...prev, backgroundColor: e.target.value }))}
                    className="w-8 h-8 rounded border cursor-pointer"
                    disabled={isRecording}
                  />
                  <span className="text-xs text-muted-foreground">{config.backgroundColor}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="enableShadow"
                  checked={config.enableShadow}
                  onChange={(e) => setConfig(prev => ({ ...prev, enableShadow: e.target.checked }))}
                  disabled={isRecording}
                />
                <Label htmlFor="enableShadow" className="text-xs">Enable Shadow</Label>
              </div>

              {config.enableShadow && (
                <div>
                  <Label className="text-xs">Shadow Intensity</Label>
                  <Slider
                    value={[config.shadowIntensity]}
                    min={0.1}
                    max={1}
                    step={0.1}
                    onValueChange={([v]) => setConfig(prev => ({ ...prev, shadowIntensity: v }))}
                    className="mt-1"
                    disabled={isRecording}
                  />
                </div>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button variant="outline" onClick={handleReset} size="sm" disabled={isRecording}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Reset
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} size="sm" disabled={isRecording}>
              Cancel
            </Button>
            {isRecording ? (
              <Button onClick={handleStopRecording} variant="destructive" size="sm">
                <Square className="h-4 w-4 mr-1" />
                Stop
              </Button>
            ) : videoUrl ? (
              <Button onClick={handleDownload} size="sm">
                <Download className="h-4 w-4 mr-1" />
                Download
              </Button>
            ) : (
              <Button onClick={handleStartRecording} size="sm">
                <Play className="h-4 w-4 mr-1" />
                Start Recording
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/editor/video-extractor.tsx
git commit -m "feat(extractor): add VideoExtractor dialog component"
```

---

### Task 7: Integrate Extractors into Editor Client

**Files:**
- Modify: `src/components/editor/editor-client.tsx`

**Step 1: Add imports at the top of the file (after line 37)**

```typescript
import { ImageExtractor } from "@/components/editor/image-extractor";
import { VideoExtractor } from "@/components/editor/video-extractor";
```

**Step 2: Add import for icons (modify the existing lucide-react import around line 16)**

Add `Camera, Video,` to the existing import from lucide-react.

**Step 3: Add state for extractor dialogs (after line 65, near other useState declarations)**

```typescript
  const [showImageExtractor, setShowImageExtractor] = useState(false);
  const [showVideoExtractor, setShowVideoExtractor] = useState(false);
```

**Step 4: Add extractor buttons in the header (around line 418, after the save button)**

Find the header section and add these buttons after the existing buttons but before the closing `</div>`:

```typescript
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowImageExtractor(true)}
            title="Image Extractor"
            className="h-8 w-8 sm:h-10 sm:w-10"
            disabled={!sceneManager}
          >
            <Camera className="h-4 w-4 sm:h-5 sm:w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowVideoExtractor(true)}
            title="Video Extractor"
            className="h-8 w-8 sm:h-10 sm:w-10"
            disabled={!sceneManager}
          >
            <Video className="h-4 w-4 sm:h-5 sm:w-5" />
          </Button>
```

**Step 5: Add extractor dialog components (before the final closing div of the return statement, around line 1377)**

```typescript
      {/* Image Extractor Dialog */}
      <ImageExtractor
        sceneManager={sceneManager}
        productName={product.name}
        open={showImageExtractor}
        onClose={() => setShowImageExtractor(false)}
      />

      {/* Video Extractor Dialog */}
      <VideoExtractor
        sceneManager={sceneManager}
        productName={product.name}
        open={showVideoExtractor}
        onClose={() => setShowVideoExtractor(false)}
      />
```

**Step 6: Commit**

```bash
git add src/components/editor/editor-client.tsx
git commit -m "feat(extractor): integrate image and video extractors into editor"
```

---

### Phase 3: UI Components & Polish (Tasks 8-10)

### Task 8: Create Slider Component (if not exists)

**Files:**
- Create: `src/components/ui/slider.tsx` (if it doesn't exist)

**Step 1: Check if slider exists and create if needed**

```bash
ls -la src/components/ui/slider.tsx 2>/dev/null || echo "needs creation"
```

If needs creation:

```typescript
// src/components/ui/slider.tsx

"use client"

import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex w-full touch-none select-none items-center",
      className
    )}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" />
  </SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
```

**Step 2: Install dependency if needed**

```bash
npm install @radix-ui/react-slider
```

**Step 3: Commit**

```bash
git add src/components/ui/slider.tsx package.json package-lock.json
git commit -m "feat(ui): add Slider component for extractor controls"
```

---

### Task 9: Create Progress Component (if not exists)

**Files:**
- Create: `src/components/ui/progress.tsx` (if it doesn't exist)

**Step 1: Check and create**

```typescript
// src/components/ui/progress.tsx

"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
      className
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-primary transition-all"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
```

**Step 2: Install dependency**

```bash
npm install @radix-ui/react-progress
```

**Step 3: Commit**

```bash
git add src/components/ui/progress.tsx package.json package-lock.json
git commit -m "feat(ui): add Progress component for video recording"
```

---

### Task 10: Export Types and Update Index

**Files:**
- Modify: `src/lib/three/index.ts`

**Step 1: Add exports to the three library index**

```typescript
// Add to src/lib/three/index.ts

export { ExtractorSceneManager } from './extractor-scene-manager';
export { createFabricTexture, createStudioBackdrop, createShadowFloor } from './studio-background';
```

**Step 2: Commit**

```bash
git add src/lib/three/index.ts
git commit -m "feat(extractor): export extractor modules from three library"
```

---

### Phase 4: Testing & Refinement (Tasks 11-13)

### Task 11: Manual Testing Checklist

**Step 1: Test Image Extractor**

```
1. Open product editor page
2. Click Camera icon in header
3. Verify dialog opens with 3-part preview
4. Test zoom slider for each part
5. Test distance slider for each part
6. Test angle slider for each part
7. Change output format (PNG/JPEG/WebP)
8. Click Download and verify file
9. Verify image has 3 parts at 45° angle
```

**Step 2: Test Video Extractor**

```
1. Click Video icon in header
2. Verify dialog opens with studio preview
3. Change quality preset (HD/2K)
4. Adjust duration slider
5. Adjust rotation speed
6. Adjust cue angle
7. Change background color
8. Toggle shadow on/off
9. Click Start Recording
10. Verify progress bar updates
11. Wait for completion
12. Preview video in dialog
13. Click Download and verify file
14. Verify video shows rotating cue with shadow
```

**Step 3: Document issues found**

Create notes on any bugs or improvements needed.

---

### Task 12: Fix Browser Compatibility

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts`

**Step 1: Add MediaRecorder format detection**

Add this helper function at the top of the file:

```typescript
/**
 * Detect best supported video format for MediaRecorder
 */
function getSupportedMimeType(): string {
  const types = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  
  return 'video/webm'; // Fallback
}
```

**Step 2: Update startVideoRecording to use detected format**

Replace the hardcoded mimeType in the MediaRecorder creation:

```typescript
this.mediaRecorder = new MediaRecorder(stream, {
  mimeType: getSupportedMimeType(),
  videoBitsPerSecond: config.bitrate,
});
```

**Step 3: Commit**

```bash
git add src/lib/three/extractor-scene-manager.ts
git commit -m "fix(extractor): add MediaRecorder format detection for browser compatibility"
```

---

### Task 13: Final Integration Test

**Step 1: Build project**

```bash
npm run build
```

Expected: Build succeeds with no TypeScript errors.

**Step 2: Run linter**

```bash
npm run lint
```

Expected: No linting errors.

**Step 3: Start development server**

```bash
npm run dev
```

**Step 4: Full flow test**

1. Navigate to `/dashboard`
2. Create or select a product
3. Open product editor
4. Test image extractor end-to-end
5. Test video extractor end-to-end
6. Verify downloads work correctly

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat(extractor): complete image and video extractor feature

- Add ImageExtractor for 3-part cue images at 45° angle
- Add VideoExtractor with studio backdrop and shadow
- Support HD and 2K video quality presets
- Procedural fabric texture generation
- MediaRecorder-based video capture
- Full UI controls for customization"
```

---

## Summary

### Files Created
1. `src/types/extractor.ts` - Type definitions and defaults
2. `src/lib/three/studio-background.ts` - Studio backdrop utilities
3. `src/lib/three/extractor-scene-manager.ts` - Core extraction engine
4. `src/components/editor/image-extractor.tsx` - Image extractor UI
5. `src/components/editor/video-extractor.tsx` - Video extractor UI
6. `src/components/ui/slider.tsx` - Slider component (if needed)
7. `src/components/ui/progress.tsx` - Progress component (if needed)

### Files Modified
1. `src/lib/three/scene-manager.ts` - Add getters for model/config
2. `src/lib/three/index.ts` - Export new modules
3. `src/components/editor/editor-client.tsx` - Integrate extractors

### Dependencies Added
- `@radix-ui/react-slider` (if not present)
- `@radix-ui/react-progress` (if not present)

### Features Delivered

**Image Extractor:**
- 2048×2048 output with 3 isolated views
- 45° angle with Y vertical
- Adjustable zoom/distance/angle per part
- PNG/JPEG/WebP format options
- Real-time preview

**Video Extractor:**
- HD (1920×1080) and 2K (2560×1440) presets
- 30° angle with studio fabric background
- Shadow casting with adjustable intensity
- Rotating cue with camera pan from bump to cap
- Configurable duration, rotation speed, background color
- WebM/MP4 output via MediaRecorder
