import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type {
  ImageExtractorConfig,
  VideoExtractorConfig,
  PartViewConfig,
  HdriLayer,
  VideoBackgroundLayer,
} from '@/types/extractor';
import {
  createVelvetTableTexture,
  createCementWallTexture,
  createWallBackdrop,
  createShadowFloor,
  createTableSurface,
  createFabricTexture,
  createStudioBackdrop,
} from './studio-background';
import type { VideoStudioConfig, CameraKeyframe, CueConfig, CueInstance, BackgroundFrame, SurfaceConfig } from '@/types/video-studio';
import { computeVideoDuration, createEasingFunction, VIDEO_QUALITY_PRESETS, GRADIENT_PRESETS } from '@/types/video-studio';
import { compositeSurfaceFrames, preloadFrameImages } from './background-compositor';

// Available HDRI options (same as editor-client)
export const HDRI_OPTIONS_FALLBACK = [
  { id: "bloem_train_track_clear_2k.hdr", label: "Bloem Train Track Clear 2k" },
  { id: "church_museum_2k.hdr", label: "Church Museum 2k" },
  { id: "church_stairway_2k.hdr", label: "Church Stairway 2k" },
  { id: "ferndale_studio_07_2k.hdr", label: "Ferndale Studio 07 2k" },
];

/**
 * Detect best supported video format for MediaRecorder
 */
export function getSupportedMimeType(): string {
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

/** Cached HDRI texture with URL key */
interface CachedHdri {
  url: string;
  texture: THREE.DataTexture;
}

/**
 * Specialized Three.js scene manager for high-quality image and video extraction.
 * Creates an offscreen WebGL renderer with preserveDrawingBuffer for canvas capture.
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

  // HDRI state - supports multi-HDRI
  private currentHdriUrl: string = '';
  private hdriTexture: THREE.DataTexture | null = null;
  private hdriRotation: number = 0; // radians (legacy single rotation)
  
  // Multi-HDRI cache and state
  private hdriCache: Map<string, THREE.DataTexture> = new Map();
  private currentHdriLayers: HdriLayer[] = [];
  private lastHdriLayersKey: string = ''; // Track last applied layers to skip redundant updates
  private pendingHdriUpdate: boolean = false;

  // Studio elements (for video)
  private backdrop: THREE.Mesh | null = null;
  private shadowFloor: THREE.Mesh | null = null;
  private tableSurface: THREE.Mesh | null = null;
  private spotLight: THREE.SpotLight | null = null;
  private fillLights: THREE.PointLight[] = [];
  private directionalLight: THREE.DirectionalLight | null = null;

  // Wrapper group used during video recording to apply tilt independently from spin
  private videoWrapperGroup: THREE.Group | null = null;

  // Live video preview state
  private videoPreviewWrapperGroup: THREE.Group | null = null;
  private backgroundLayerMeshes: THREE.Mesh[] = [];
  private videoPreviewConfigRef: VideoExtractorConfig | null = null;
  private studioConfigRef: VideoStudioConfig | null = null;

  // Multi-cue instancing
  private instancedMeshes: THREE.InstancedMesh[] = [];
  private sourceModelRef: THREE.Group | null = null;
  private currentCueConfig: CueConfig | null = null;

  // Scene view (god camera)
  private godCamera: THREE.PerspectiveCamera | null = null;
  private cameraHelper: THREE.CameraHelper | null = null;
  private isSceneView: boolean = false;

  // Camera gizmo for scene view selection
  private cameraGizmo: THREE.Group | null = null;

  // Frame plane meshes (for interactive scene view)
  private wallFramePlanes: THREE.Mesh[] = [];
  private tableFramePlanes: THREE.Mesh[] = [];

  // Smooth camera interpolation
  private cameraTargetPos = new THREE.Vector3();
  private cameraLookAtYOffset = 0.5; // 0 = cue bottom, 1 = cue top, default center
  private cameraSmoothEnabled = false;

  // Animation state
  private animationFrameId: number | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  constructor(
    private width: number = 2048,
    private height: number = 2048
  ) {
    // Create offscreen renderer with preserveDrawingBuffer for canvas capture
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

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a1a);

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    this.camera.position.set(2, 0, 2);

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    this.setupBasicLighting();
  }

  private setupBasicLighting() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.3);
    this.scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
    this.scene.add(hemi);
  }

  /** Load a texture from a URL, with repeat/wrapping applied */
  private loadTexture(
    url: string,
    repeatS: number = 4,
    repeatT: number = 4
  ): Promise<THREE.Texture> {
    return new Promise((resolve) => {
      new THREE.TextureLoader().load(
        url,
        (tex) => {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(repeatS, repeatT);
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        () => resolve(null as unknown as THREE.Texture) // fallback handled by caller
      );
    });
  }

  async setupStudioLighting(config: VideoExtractorConfig): Promise<void> {
    this.clearStudioElements();

    // ── Load HDRI from config if specified ──
    if (config.hdriFile) {
      try {
        await this.loadHDRI(`/hdri/${config.hdriFile}`);
      } catch (err) {
        console.warn('[ExtractorSceneManager] Failed to load HDRI from config:', config.hdriFile, err);
      }
    }

    // ── Apply HDRI rotation from config ──
    if (config.hdriRotationY !== undefined && config.hdriRotationY !== 0) {
      this.setHdriRotation(config.hdriRotationY);
    }

    // Key spotlight — angled from above-front to cast a clear shadow on the table
    this.spotLight = new THREE.SpotLight(0xffffff, 2.2);
    this.spotLight.position.set(2, 5, 3);
    this.spotLight.angle = Math.PI / 4.5;
    this.spotLight.penumbra = 0.45;
    this.spotLight.decay = 1.3;
    this.spotLight.distance = 22;
    this.spotLight.castShadow = true;
    this.spotLight.shadow.mapSize.width = 2048;
    this.spotLight.shadow.mapSize.height = 2048;
    this.spotLight.shadow.camera.near = 0.5;
    this.spotLight.shadow.camera.far = 22;
    this.spotLight.shadow.bias = -0.0001;
    this.spotLight.shadow.radius = config.shadowBlur;
    this.scene.add(this.spotLight);

    // Subtle fill lights so cue details are visible in shadow areas
    const fillPositions: [number, number, number][] = [
      [-3, 1, 2],
      [0, -1, 3],
      [3, 0.5, -1],
    ];
    fillPositions.forEach(([x, y, z]) => {
      const fill = new THREE.PointLight(0xffffff, 0.2);
      fill.position.set(x, y, z);
      this.fillLights.push(fill);
      this.scene.add(fill);
    });

    // ── Load wall texture (real file or procedural fallback) ──
    let wallTex: THREE.Texture | null = null;
    if (config.wallTextureUrl) {
      wallTex = await this.loadTexture(config.wallTextureUrl, 5, 5);
    }
    if (!wallTex) {
      wallTex = createCementWallTexture(1024, 1024);
    }
    // Tall flat wall, far back, elevated so a gap is visible between table and wall
    this.backdrop = createWallBackdrop(wallTex, 34, 22);
    this.backdrop.position.set(0, 4.5, -5.5);
    this.scene.add(this.backdrop);

    // ── Load table texture (real file or procedural fallback) ──
    let tableTex: THREE.Texture | null = null;
    if (config.tableTextureUrl) {
      tableTex = await this.loadTexture(config.tableTextureUrl, 4, 4);
    }
    if (!tableTex) {
      tableTex = createVelvetTableTexture(1024, 1024);
    }
    // Table at y=-1.2: 3× gap from cue (was y=-0.4) — visible shadow gap
    this.tableSurface = createTableSurface(tableTex, 28, 5, -1.2);
    this.scene.add(this.tableSurface);

    // Shadow-only plane just above table so shadow is crisp and distinct from velvet
    if (config.enableShadow) {
      this.shadowFloor = createShadowFloor();
      this.shadowFloor.position.y = -1.18;
      this.scene.add(this.shadowFloor);
    }

    // ── Additional background layers (overlay on top of wall) ──
    if (config.backgroundLayers && config.backgroundLayers.length > 0) {
      await this.applyVideoBackgroundLayers(config.backgroundLayers);
    }
  }

  private clearStudioElements() {
    this.clearFramePlanes();
    if (this.spotLight) {
      this.scene.remove(this.spotLight);
      this.spotLight.dispose();
      this.spotLight = null;
    }
    this.fillLights.forEach((light) => {
      this.scene.remove(light);
      light.dispose();
    });
    this.fillLights = [];
    if (this.backdrop) {
      this.scene.remove(this.backdrop);
      const material = this.backdrop.material as THREE.MeshStandardMaterial;
      if (material.map) {
        material.map.dispose();
      }
      material.dispose();
      this.backdrop.geometry.dispose();
      this.backdrop = null;
    }
    if (this.shadowFloor) {
      this.scene.remove(this.shadowFloor);
      (this.shadowFloor.material as THREE.Material).dispose();
      this.shadowFloor.geometry.dispose();
      this.shadowFloor = null;
    }
    if (this.tableSurface) {
      this.scene.remove(this.tableSurface);
      const mat = this.tableSurface.material as THREE.MeshStandardMaterial;
      if (mat.map) mat.map.dispose();
      mat.dispose();
      this.tableSurface.geometry.dispose();
      this.tableSurface = null;
    }
    for (const mesh of this.backgroundLayerMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.backgroundLayerMeshes = [];
  }

  async loadHDRI(hdriUrl: string): Promise<void> {
    this.currentHdriUrl = hdriUrl;
    return new Promise((resolve, reject) => {
      const loader = new RGBELoader();
      loader.load(
        hdriUrl,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          
          // Store the original texture for rotation
          if (this.hdriTexture) {
            this.hdriTexture.dispose();
          }
          this.hdriTexture = texture;
          
          // Apply with current rotation
          this.applyHdriWithRotation();
          resolve();
        },
        undefined,
        reject
      );
    });
  }

  /**
   * Apply HDRI environment with current rotation offset
   */
  private applyHdriWithRotation(): void {
    if (!this.hdriTexture) {
      console.warn('[ExtractorSceneManager] applyHdriWithRotation: No HDRI texture loaded');
      return;
    }
    
    try {
      // Create rotated version of the texture
      const rotatedTexture = this.createRotatedHdriTexture(this.hdriTexture, this.hdriRotation);
      if (!rotatedTexture) {
        console.warn('[ExtractorSceneManager] Failed to create rotated texture, using original');
        // Fall back to original texture
        const rt = this.pmremGenerator.fromEquirectangular(this.hdriTexture);
        if (this.envRenderTarget) {
          this.envRenderTarget.dispose();
        }
        this.envRenderTarget = rt;
        this.scene.environment = rt.texture;
        return;
      }
      
      rotatedTexture.mapping = THREE.EquirectangularReflectionMapping;
      
      const rt = this.pmremGenerator.fromEquirectangular(rotatedTexture);
      rotatedTexture.dispose();

      if (this.envRenderTarget) {
        this.envRenderTarget.dispose();
      }
      this.envRenderTarget = rt;
      this.scene.environment = rt.texture;
      
      console.log('[ExtractorSceneManager] HDRI rotation applied:', (this.hdriRotation * 180 / Math.PI).toFixed(1), '°');
    } catch (error) {
      console.error('[ExtractorSceneManager] Error applying HDRI rotation:', error);
      // Fall back to original texture without rotation
      try {
        const rt = this.pmremGenerator.fromEquirectangular(this.hdriTexture);
        if (this.envRenderTarget) {
          this.envRenderTarget.dispose();
        }
        this.envRenderTarget = rt;
        this.scene.environment = rt.texture;
      } catch (fallbackError) {
        console.error('[ExtractorSceneManager] Fallback also failed:', fallbackError);
      }
    }
  }

  /**
   * Create a rotated copy of an HDRI texture
   * Rotation is applied by shifting pixels horizontally (since HDRI is equirectangular)
   */
  private createRotatedHdriTexture(sourceTexture: THREE.DataTexture, rotation: number): THREE.DataTexture | null {
    try {
      // Normalize rotation to 0-2π
      const normalizedRotation = ((rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      
      // If no rotation, return a clone
      if (Math.abs(normalizedRotation) < 0.001) {
        const clonedTexture = sourceTexture.clone();
        clonedTexture.needsUpdate = true;
        return clonedTexture;
      }

      // Check if image data exists
      if (!sourceTexture.image || !sourceTexture.image.width || !sourceTexture.image.height) {
        console.warn('[ExtractorSceneManager] Source texture has no valid image data');
        return null;
      }

      const width = sourceTexture.image.width;
      const height = sourceTexture.image.height;
      const sourceData = sourceTexture.image.data as Float32Array | Uint8Array | Uint16Array | null;
      
      // If no source data, return null
      if (!sourceData || sourceData.length === 0) {
        console.warn('[ExtractorSceneManager] Source texture has no pixel data');
        return null;
      }
      
      const channels = sourceData.length / (width * height);
      
      // Validate channel count is reasonable (3 for RGB, 4 for RGBA, etc.)
      if (channels < 1 || channels > 4 || !Number.isInteger(channels)) {
        console.warn('[ExtractorSceneManager] Invalid channel count:', channels);
        return null;
      }
      
      // Calculate pixel shift (rotation as fraction of width)
      const shift = Math.round((normalizedRotation / (2 * Math.PI)) * width);
      
      // Create new data array with same type as source
      let newData: Float32Array | Uint8Array | Uint16Array;
      if (sourceData instanceof Float32Array) {
        newData = new Float32Array(sourceData.length);
      } else if (sourceData instanceof Uint16Array) {
        newData = new Uint16Array(sourceData.length);
      } else {
        newData = new Uint8Array(sourceData.length);
      }
      
      // Shift pixels horizontally
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sourceX = (x + shift) % width;
          const sourceIdx = (y * width + sourceX) * channels;
          const destIdx = (y * width + x) * channels;
          
          for (let c = 0; c < channels; c++) {
            newData[destIdx + c] = sourceData[sourceIdx + c];
          }
        }
      }
      
      const rotatedTexture = new THREE.DataTexture(
        newData,
        width,
        height,
        sourceTexture.format as THREE.PixelFormat,
        sourceTexture.type
      );
      rotatedTexture.colorSpace = sourceTexture.colorSpace;
      rotatedTexture.needsUpdate = true;
    
      return rotatedTexture;
    } catch (error) {
      console.error('[ExtractorSceneManager] Error creating rotated texture:', error);
      return null;
    }
  }

  /**
   * Set HDRI rotation angle (0-360 degrees) - Legacy single-HDRI method
   * This rotates the environment lighting around the model
   */
  setHdriRotation(angleDegrees: number): void {
    this.hdriRotation = (angleDegrees * Math.PI) / 180;
    if (this.hdriTexture) {
      this.applyHdriWithRotation();
    }
  }

  /**
   * Load an HDRI texture and cache it
   * Returns a deep copy of the texture data to allow independent manipulation
   */
  private async loadAndCacheHdri(hdriType: string): Promise<THREE.DataTexture> {
    const url = `/hdri/${encodeURIComponent(hdriType)}`;
    
    // Check cache first - return a deep copy to avoid modifying cached texture
    if (this.hdriCache.has(hdriType)) {
      const cached = this.hdriCache.get(hdriType)!;
      return this.deepCloneDataTexture(cached);
    }
    
    return new Promise((resolve, reject) => {
      const loader = new RGBELoader();
      loader.load(
        url,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          this.hdriCache.set(hdriType, texture);
          // Return a deep clone so the cached version remains unmodified
          resolve(this.deepCloneDataTexture(texture));
        },
        undefined,
        (error) => {
          console.error('[ExtractorSceneManager] Failed to load HDRI:', url, error);
          reject(error);
        }
      );
    });
  }
  
  /**
   * Deep clone a DataTexture including its pixel data
   */
  private deepCloneDataTexture(source: THREE.DataTexture): THREE.DataTexture {
    const sourceData = source.image.data;
    let newData: Float32Array | Uint8Array | Uint16Array;
    
    if (sourceData instanceof Float32Array) {
      newData = new Float32Array(sourceData);
    } else if (sourceData instanceof Uint16Array) {
      newData = new Uint16Array(sourceData);
    } else if (sourceData instanceof Uint8Array) {
      newData = new Uint8Array(sourceData);
    } else {
      // Fallback - try to copy as Float32Array
      newData = new Float32Array(sourceData as ArrayLike<number>);
    }
    
    const clone = new THREE.DataTexture(
      newData,
      source.image.width,
      source.image.height,
      source.format as THREE.PixelFormat,
      source.type
    );
    clone.mapping = source.mapping;
    clone.colorSpace = source.colorSpace;
    clone.needsUpdate = true;
    
    return clone;
  }

  /**
   * Apply multiple HDRI layers with X and Y rotation (additive blending)
   */
  async setHdriLayers(layers: HdriLayer[]): Promise<void> {
    if (layers.length === 0) {
      console.warn('[ExtractorSceneManager] No HDRI layers provided');
      return;
    }
    
    // Skip if same as last applied (avoid redundant expensive operations)
    const layersKey = JSON.stringify(layers);
    if (layersKey === this.lastHdriLayersKey) {
      return;
    }
    
    // Prevent concurrent updates
    if (this.pendingHdriUpdate) {
      return;
    }
    this.pendingHdriUpdate = true;
    
    this.currentHdriLayers = layers;
    
    try {
      // Load all needed HDRIs
      const textures: THREE.DataTexture[] = [];
      for (const layer of layers) {
        try {
          const tex = await this.loadAndCacheHdri(layer.hdriType);
          textures.push(tex);
        } catch (loadError) {
          console.error('[ExtractorSceneManager] Failed to load HDRI:', layer.hdriType, loadError);
        }
      }
      
      if (textures.length === 0) {
        console.error('[ExtractorSceneManager] No HDRIs could be loaded');
        this.pendingHdriUpdate = false;
        return;
      }
      
      // Create rotated versions of each texture
      const rotatedTextures: THREE.DataTexture[] = [];
      for (let i = 0; i < textures.length; i++) {
        const layer = layers[i];
        const rotated = this.createRotatedHdriTextureXY(textures[i], layer.rotationX, layer.rotationY);
        if (rotated) {
          rotatedTextures.push(rotated);
          console.log('[ExtractorSceneManager] Rotated texture', i, 'created, rotX:', layer.rotationX, 'rotY:', layer.rotationY);
        } else {
          console.warn('[ExtractorSceneManager] Failed to rotate texture', i);
        }
      }
      
      if (rotatedTextures.length === 0) {
        console.warn('[ExtractorSceneManager] No valid rotated textures created, falling back to first HDRI');
        // Fallback: use first texture without rotation
        if (textures.length > 0) {
          const rt = this.pmremGenerator.fromEquirectangular(textures[0]);
          if (this.envRenderTarget) {
            this.envRenderTarget.dispose();
          }
          this.envRenderTarget = rt;
          this.scene.environment = rt.texture;
        }
        return;
      }
      
      // Combine textures if multiple, otherwise use single
      let finalTexture: THREE.DataTexture;
      if (rotatedTextures.length === 1) {
        finalTexture = rotatedTextures[0];
      } else {
        finalTexture = this.blendHdriTextures(rotatedTextures);
        // Dispose individual rotated textures after blending
        rotatedTextures.forEach(t => t.dispose());
      }
      
      finalTexture.mapping = THREE.EquirectangularReflectionMapping;
      
      const rt = this.pmremGenerator.fromEquirectangular(finalTexture);
      finalTexture.dispose();
      
      if (this.envRenderTarget) {
        this.envRenderTarget.dispose();
      }
      this.envRenderTarget = rt;
      this.scene.environment = rt.texture;
      
      // Mark as successfully applied
      this.lastHdriLayersKey = layersKey;
    } catch (error) {
      console.error('[ExtractorSceneManager] Error applying HDRI layers:', error);
      // Try to recover by loading default HDRI
      try {
        const fallbackUrl = `/hdri/bloem_train_track_clear_2k.hdr`;
        await this.loadHDRI(fallbackUrl);
      } catch (fallbackError) {
        console.error('[ExtractorSceneManager] Fallback also failed:', fallbackError);
      }
    } finally {
      this.pendingHdriUpdate = false;
    }
  }

  /**
   * Create a rotated copy of an HDRI texture with X and Y rotation
   * X rotation = vertical shift (tilt up/down)
   * Y rotation = horizontal shift (rotate around)
   */
  private createRotatedHdriTextureXY(
    sourceTexture: THREE.DataTexture, 
    rotationXDeg: number, 
    rotationYDeg: number
  ): THREE.DataTexture | null {
    try {
      // Normalize rotations to 0-360
      const rotX = ((rotationXDeg % 360) + 360) % 360;
      const rotY = ((rotationYDeg % 360) + 360) % 360;

      if (!sourceTexture.image || !sourceTexture.image.width || !sourceTexture.image.height) {
        console.warn('[ExtractorSceneManager] Source texture has no valid image data');
        return null;
      }

      const width = sourceTexture.image.width;
      const height = sourceTexture.image.height;
      const sourceData = sourceTexture.image.data as Float32Array | Uint8Array | Uint16Array | null;
      
      if (!sourceData || sourceData.length === 0) {
        console.warn('[ExtractorSceneManager] Source texture has no pixel data');
        return null;
      }
      
      const channels = sourceData.length / (width * height);
      if (channels < 1 || channels > 4 || !Number.isInteger(channels)) {
        console.warn('[ExtractorSceneManager] Invalid channel count:', channels);
        return null;
      }
      
      // If no rotation, still create a deep copy
      if (Math.abs(rotX) < 0.1 && Math.abs(rotY) < 0.1) {
        return this.deepCloneDataTexture(sourceTexture);
      }
      
      // Calculate pixel shifts
      const shiftX = Math.round((rotY / 360) * width);  // Horizontal shift (Y rotation)
      const shiftY = Math.round((rotX / 360) * height); // Vertical shift (X rotation)
      
      // Create new data array matching source type
      let newData: Float32Array | Uint8Array | Uint16Array;
      if (sourceData instanceof Float32Array) {
        newData = new Float32Array(sourceData.length);
      } else if (sourceData instanceof Uint16Array) {
        newData = new Uint16Array(sourceData.length);
      } else {
        newData = new Uint8Array(sourceData.length);
      }
      
      // Shift pixels both horizontally (Y rot) and vertically (X rot)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          // Use proper modulo that handles any value
          const sourceX = ((x + shiftX) % width + width) % width;
          const sourceY = ((y + shiftY) % height + height) % height;
          const sourceIdx = (sourceY * width + sourceX) * channels;
          const destIdx = (y * width + x) * channels;
          
          for (let c = 0; c < channels; c++) {
            newData[destIdx + c] = sourceData[sourceIdx + c];
          }
        }
      }
      
      const rotatedTexture = new THREE.DataTexture(
        newData,
        width,
        height,
        sourceTexture.format as THREE.PixelFormat,
        sourceTexture.type
      );
      rotatedTexture.colorSpace = sourceTexture.colorSpace;
      rotatedTexture.needsUpdate = true;
      
      return rotatedTexture;
    } catch (error) {
      console.error('[ExtractorSceneManager] Error creating rotated texture XY:', error);
      return null;
    }
  }

  /**
   * Convert IEEE 754 half-precision float (16-bit) to 32-bit float
   */
  private halfToFloat(h: number): number {
    const s = (h & 0x8000) >> 15;  // sign
    const e = (h & 0x7C00) >> 10;  // exponent
    const f = h & 0x03FF;          // fraction
    
    if (e === 0) {
      // Subnormal or zero
      return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    } else if (e === 0x1F) {
      // Infinity or NaN
      return f ? NaN : ((s ? -1 : 1) * Infinity);
    }
    
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  
  /**
   * Convert 32-bit float to IEEE 754 half-precision float (16-bit)
   */
  private floatToHalf(f: number): number {
    if (isNaN(f)) return 0x7E00;
    if (!isFinite(f)) return f > 0 ? 0x7C00 : 0xFC00;
    if (f === 0) return 0;
    
    const sign = f < 0 ? 1 : 0;
    f = Math.abs(f);
    
    // Clamp to half-float range
    if (f > 65504) f = 65504;
    
    let exponent = Math.floor(Math.log2(f));
    let mantissa = f / Math.pow(2, exponent) - 1;
    
    exponent += 15;
    
    if (exponent <= 0) {
      // Subnormal
      mantissa = f / Math.pow(2, -14);
      return (sign << 15) | Math.round(mantissa * 1024);
    }
    
    if (exponent >= 31) {
      // Overflow to infinity
      return (sign << 15) | 0x7C00;
    }
    
    return (sign << 15) | (exponent << 10) | Math.round(mantissa * 1024);
  }

  /**
   * Blend multiple HDRI textures additively (both lights at full intensity)
   * Each HDRI contributes its full lighting, not averaged
   * Properly handles half-float (Uint16Array) data encoding
   */
  private blendHdriTextures(textures: THREE.DataTexture[]): THREE.DataTexture {
    if (textures.length === 0) {
      throw new Error('No textures to blend');
    }
    if (textures.length === 1) {
      return this.deepCloneDataTexture(textures[0]);
    }
    
    const first = textures[0];
    const width = first.image.width;
    const height = first.image.height;
    const firstData = first.image.data as Float32Array | Uint8Array | Uint16Array | null;
    
    if (!firstData || firstData.length === 0) {
      throw new Error('First texture has no data');
    }
    
    const channels = firstData.length / (width * height);
    const totalPixels = firstData.length;
    const isHalfFloat = first.type === THREE.HalfFloatType;
    
    // Convert to Float64Array for intermediate calculations
    // If half-float, decode the values first
    const blendedFloat = new Float64Array(totalPixels);
    
    if (isHalfFloat && firstData instanceof Uint16Array) {
      for (let i = 0; i < totalPixels; i++) {
        blendedFloat[i] = this.halfToFloat(firstData[i]);
      }
    } else {
      for (let i = 0; i < totalPixels; i++) {
        blendedFloat[i] = firstData[i];
      }
    }
    
    // Add remaining textures (additive - both lights contribute fully)
    for (let t = 1; t < textures.length; t++) {
      const tex = textures[t];
      const texWidth = tex.image.width;
      const texHeight = tex.image.height;
      const texData = tex.image.data as Float32Array | Uint8Array | Uint16Array | null;
      
      if (!texData || texData.length === 0) {
        continue;
      }
      
      const texIsHalfFloat = tex.type === THREE.HalfFloatType;
      
      // If same size, add directly
      if (texWidth === width && texHeight === height && texData.length === totalPixels) {
        if (texIsHalfFloat && texData instanceof Uint16Array) {
          for (let i = 0; i < totalPixels; i++) {
            blendedFloat[i] += this.halfToFloat(texData[i]);
          }
        } else {
          for (let i = 0; i < totalPixels; i++) {
            blendedFloat[i] += texData[i];
          }
        }
      } else {
        // Different sizes - need to resample
        const texChannels = texData.length / (texWidth * texHeight);
        
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const srcX = Math.floor((x / width) * texWidth);
            const srcY = Math.floor((y / height) * texHeight);
            const srcIdx = (srcY * texWidth + srcX) * texChannels;
            const dstIdx = (y * width + x) * channels;
            
            for (let c = 0; c < Math.min(channels, texChannels); c++) {
              const val = texIsHalfFloat && texData instanceof Uint16Array 
                ? this.halfToFloat(texData[srcIdx + c])
                : texData[srcIdx + c];
              blendedFloat[dstIdx + c] += val;
            }
          }
        }
      }
    }
    
    // Convert back to original type
    let outputData: Float32Array | Uint8Array | Uint16Array;
    if (isHalfFloat) {
      // Encode back to half-float
      outputData = new Uint16Array(totalPixels);
      for (let i = 0; i < totalPixels; i++) {
        (outputData as Uint16Array)[i] = this.floatToHalf(blendedFloat[i]);
      }
    } else if (firstData instanceof Float32Array) {
      outputData = new Float32Array(totalPixels);
      for (let i = 0; i < totalPixels; i++) {
        outputData[i] = blendedFloat[i];
      }
    } else {
      outputData = new Uint8Array(totalPixels);
      for (let i = 0; i < totalPixels; i++) {
        outputData[i] = Math.max(0, Math.min(255, Math.round(blendedFloat[i])));
      }
    }
    
    const blendedTexture = new THREE.DataTexture(
      outputData,
      width,
      height,
      first.format as THREE.PixelFormat,
      first.type
    );
    blendedTexture.colorSpace = first.colorSpace;
    blendedTexture.needsUpdate = true;
    
    return blendedTexture;
  }

  /**
   * Get current HDRI URL
   */
  getCurrentHdriUrl(): string {
    return this.currentHdriUrl;
  }

  setModel(sourceModel: THREE.Group) {
    console.log('[ExtractorSceneManager] setModel called, source children:', sourceModel.children.length);
    
    if (this.clonedModel) {
      this.scene.remove(this.clonedModel);
      this.disposeModel(this.clonedModel);
    }

    this.clonedModel = sourceModel.clone(true);
    console.log('[ExtractorSceneManager] Cloned model, children:', this.clonedModel.children.length);

    let meshCount = 0;
    this.clonedModel.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        meshCount++;
        child.castShadow = true;
        child.receiveShadow = false;
        console.log('[ExtractorSceneManager] Mesh:', child.name, 'visible:', child.visible, 'material:', (child.material as THREE.Material).name);
      }
    });
    console.log('[ExtractorSceneManager] Total meshes:', meshCount);

    this.model = this.clonedModel;
    this.scene.add(this.clonedModel);
    console.log('[ExtractorSceneManager] Model added to scene. Scene children:', this.scene.children.length);
  }

  private disposeModel(model: THREE.Group) {
    model.traverse((child) => {
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

  private positionCameraForPart(partConfig: PartViewConfig, partCenterY: number) {
    const { cameraDistance, cameraAngleX, cameraAngleY, zoom } = partConfig;

    const x = cameraDistance * Math.sin(cameraAngleY) * Math.cos(cameraAngleX);
    const y = partCenterY + cameraDistance * Math.sin(cameraAngleX);
    const z = cameraDistance * Math.cos(cameraAngleY) * Math.cos(cameraAngleX);

    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, partCenterY, 0);
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Set model offset within the frame (for right-click drag positioning)
   */
  setModelOffset(offsetX: number, offsetY: number): void {
    if (this.clonedModel) {
      this.clonedModel.position.x = offsetX;
      this.clonedModel.position.y = offsetY;
    }
  }

  /**
   * Set model Y-axis rotation (turntable spin)
   * Like main preview: horizontal drag spins the model
   */
  setModelRotation(rotationY: number): void {
    if (this.clonedModel) {
      this.clonedModel.rotation.y = rotationY;
      this.clonedModel.rotation.x = 0;
      this.clonedModel.rotation.z = 0;
    }
  }

  /**
   * Set camera vertical orbit (phi angle)
   * Like main preview: vertical drag moves camera up/down around cue
   */
  setCameraPhi(phi: number, distance: number = 2): void {
    // phi = polar angle (0 = top, PI/2 = side, PI = bottom)
    // Clamp to avoid singularity at poles
    const clampedPhi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));
    
    // Camera positioned in front of model (along +Z axis) at given phi angle
    // phi = PI/2 means side view (camera at y=0, z=distance)
    // phi = 0 means top view (camera at y=distance, z=0)
    // phi = PI means bottom view (camera at y=-distance, z=0)
    const y = distance * Math.cos(clampedPhi);
    const z = distance * Math.sin(clampedPhi);
    
    // Position camera in front (along Z axis), orbiting vertically
    this.camera.position.set(0, y, z);
    this.camera.lookAt(0, 0, 0);
    
    console.log('[ExtractorSceneManager] setCameraPhi: phi=', phi.toFixed(3), 'rad (', (phi * 180 / Math.PI).toFixed(1), '°) → camera at (0,', y.toFixed(2), ',', z.toFixed(2), ')');
  }

  /**
   * Set directional light angle (0-360 degrees, like sun position)
   * Light orbits around the model at a fixed elevation
   */
  setDirectionalLight(angleDegrees: number): void {
    if (!this.directionalLight) {
      this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
      this.directionalLight.castShadow = true;
      this.scene.add(this.directionalLight);
    }

    const angleRad = (angleDegrees * Math.PI) / 180;
    const radius = 5;
    const elevation = 3;

    this.directionalLight.position.set(
      Math.cos(angleRad) * radius,
      elevation,
      Math.sin(angleRad) * radius
    );
    this.directionalLight.target.position.set(0, 0, 0);
  }

  /**
   * Set scene background to transparent (for PNG export with alpha)
   */
  setTransparentBackground(transparent: boolean): void {
    this.scene.background = transparent ? null : new THREE.Color(0x1a1a1a);
    console.log('[ExtractorSceneManager] Background set to:', transparent ? 'transparent' : 'dark');
  }

  private async applyVideoBackgroundLayers(layers: VideoBackgroundLayer[]): Promise<void> {
    // Remove existing layer meshes
    for (const mesh of this.backgroundLayerMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.backgroundLayerMeshes = [];

    const enabledLayers = layers.filter(l => l.enabled);
    if (enabledLayers.length === 0) return;

    for (let i = 0; i < enabledLayers.length; i++) {
      const layer = enabledLayers[i];
      const geometry = new THREE.PlaneGeometry(38, 26);

      let material: THREE.MeshBasicMaterial;

      if (layer.type === 'image' && layer.imageUrl) {
        const tex = await this.loadTexture(layer.imageUrl, 1, 1);
        material = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          opacity: layer.opacity,
          depthWrite: false,
        });
      } else {
        const color = new THREE.Color(layer.color);
        material = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: layer.opacity,
          depthWrite: false,
        });
      }

      if (layer.blendMode === 'additive') {
        material.blending = THREE.AdditiveBlending;
      } else if (layer.blendMode === 'multiply') {
        material.blending = THREE.MultiplyBlending;
      } else {
        material.blending = THREE.NormalBlending;
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = -100 + i;
      mesh.position.set(0, 4.5, -5.4 + i * 0.01);
      this.backgroundLayerMeshes.push(mesh);
      this.scene.add(mesh);
    }
  }

  /**
   * Start animated live preview for video extractor:
   * cue spins with Dutch tilt, camera at start position.
   */
  startVideoPreview(config: VideoExtractorConfig): void {
    this.stopVideoPreview();
    if (!this.model) return;

    this.videoPreviewConfigRef = config;

    const modelScale = config.modelScale ?? 7;
    this.model.scale.setScalar(modelScale);
    this.model.rotation.set(0, 0, 0);
    this.model.position.set(0, 0, 0);

    const wrapperGroup = new THREE.Group();
    wrapperGroup.rotation.z = -Math.PI / 2;
    this.scene.remove(this.model);
    wrapperGroup.add(this.model);
    this.scene.add(wrapperGroup);
    this.videoPreviewWrapperGroup = wrapperGroup;

    wrapperGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrapperGroup);
    const cueLen = box.max.x - box.min.x;
    const buttX = box.min.x;

    const camY = 0.55;
    const camZ = 1.7;
    const rollRad = 20 * Math.PI / 180;
    this.camera.up.set(Math.sin(rollRad), Math.cos(rollRad), 0);
    this.camera.position.set(buttX + cueLen * 0.05, camY, camZ);
    this.camera.lookAt(buttX + cueLen * 0.05, 0, 0);

    const animate = () => {
      if (this.isDisposed || !this.videoPreviewWrapperGroup) return;
      this.animationFrameId = requestAnimationFrame(animate);
      const cfg = this.videoPreviewConfigRef ?? config;
      this.model!.rotation.y += cfg.rotationSpeed / 60;
      this.model!.scale.setScalar(cfg.modelScale ?? 7);
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  /** Stop the live video preview and restore model/camera state */
  stopVideoPreview(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.videoPreviewWrapperGroup) {
      if (this.model) {
        this.videoPreviewWrapperGroup.remove(this.model);
        this.model.scale.setScalar(1);
        this.model.rotation.set(0, 0, 0);
        this.model.position.set(0, 0, 0);
        this.scene.add(this.model);
      }
      this.scene.remove(this.videoPreviewWrapperGroup);
      this.videoPreviewWrapperGroup = null;
      this.camera.up.set(0, 1, 0);
    }
    this.videoPreviewConfigRef = null;
  }

  /** Update config for the live preview without restarting */
  updateVideoPreviewConfig(config: VideoExtractorConfig): void {
    this.videoPreviewConfigRef = config;
  }

  // ════════════════════════════════════════════════════════════════
  //  VIDEO STUDIO — New camera system with start/end positions
  // ════════════════════════════════════════════════════════════════

  /** Setup studio environment from the new VideoStudioConfig (compositor-based backgrounds) */
  async setupStudioFromStudioConfig(config: VideoStudioConfig): Promise<void> {
    this.clearStudioElements();

    // Load HDRI
    if (config.hdriFile) {
      try { await this.loadHDRI(`/hdri/${config.hdriFile}`); }
      catch (err) { console.warn('[ESM] Failed to load HDRI:', err); }
    }

    // Apply HDRI rotation from first layer
    if (config.hdriConfig.layers.length > 0) {
      const firstLayer = config.hdriConfig.layers[0];
      if (firstLayer.rotationY !== 0) this.setHdriRotation(firstLayer.rotationY);
    }

    // Key spotlight
    this.spotLight = new THREE.SpotLight(0xffffff, 2.2);
    this.spotLight.position.set(2, 5, 3);
    this.spotLight.angle = Math.PI / 4.5;
    this.spotLight.penumbra = 0.45;
    this.spotLight.decay = 1.3;
    this.spotLight.distance = 22;
    this.spotLight.castShadow = true;
    this.spotLight.shadow.mapSize.set(2048, 2048);
    this.spotLight.shadow.camera.near = 0.5;
    this.spotLight.shadow.camera.far = 22;
    this.spotLight.shadow.bias = -0.0001;
    this.spotLight.shadow.radius = 2;
    this.scene.add(this.spotLight);

    // Fill lights
    const fillPositions: [number, number, number][] = [[-3, 1, 2], [0, -1, 3], [3, 0.5, -1]];
    fillPositions.forEach(([x, y, z]) => {
      const fill = new THREE.PointLight(0xffffff, 0.2);
      fill.position.set(x, y, z);
      this.fillLights.push(fill);
      this.scene.add(fill);
    });

    // Wall from surface frames — single 2048×2048 canvas, no tiling
    const wallImages = await preloadFrameImages(config.wallSurface.frames);
    const wallTex = compositeSurfaceFrames(config.wallSurface, 2048, 2048, wallImages);
    wallTex.wrapS = THREE.ClampToEdgeWrapping;
    wallTex.wrapT = THREE.ClampToEdgeWrapping;
    wallTex.repeat.set(1, 1);
    this.backdrop = createWallBackdrop(wallTex, 34, 22);
    this.backdrop.position.set(0, 4.5, -5.5);
    this.scene.add(this.backdrop);
    this.backdrop.userData = { type: 'wall' };

    // Table from surface frames — single 2048×2048 canvas, no tiling
    // Position table at bottom edge of wall: wallY - wallHeight/2 = 4.5 - 11 = -6.5
    const wallBottomY = this.backdrop.position.y - 11;
    const tableImages = await preloadFrameImages(config.tableSurface.frames);
    const tableTex = compositeSurfaceFrames(config.tableSurface, 2048, 2048, tableImages);
    tableTex.wrapS = THREE.ClampToEdgeWrapping;
    tableTex.wrapT = THREE.ClampToEdgeWrapping;
    tableTex.repeat.set(1, 1);
    this.tableSurface = createTableSurface(tableTex, 28, 5, wallBottomY);
    this.scene.add(this.tableSurface);
    this.tableSurface.userData = { type: 'table' };

    // Build frame planes for interactive scene view
    this.wallFramePlanes = this.buildFramePlanes(config.wallSurface, this.backdrop!, false, wallImages);
    this.tableFramePlanes = this.buildFramePlanes(config.tableSurface, this.tableSurface!, true, tableImages);

    // Shadow floor
    if (config.shadow.enabled) {
      this.shadowFloor = createShadowFloor();
      this.shadowFloor.position.y = -1.18;
      this.scene.add(this.shadowFloor);
    }

    // Setup cue instances
    this.setupCueInstances(config.cueConfig);
  }

  /** Create material for a frame plane based on its type */
  private createFramePlaneMaterial(
    frame: BackgroundFrame,
    loadedImages?: Map<string, HTMLImageElement>
  ): THREE.MeshBasicMaterial {
    const opts: THREE.MeshBasicMaterialParameters = {
      transparent: true,
      opacity: frame.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    };

    if (frame.type === "color" && frame.color) {
      return new THREE.MeshBasicMaterial({ ...opts, color: frame.color });
    }

    if (frame.type === "gradient" && frame.gradient) {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d")!;

      const preset = GRADIENT_PRESETS.find((p) => p.id === frame.gradient!.presetId);
      if (preset) {
        const angleDeg = frame.gradient.angle ?? preset.angle;
        const angleRad = (angleDeg * Math.PI) / 180;
        const len = 128;
        const grad = ctx.createLinearGradient(
          128 - Math.cos(angleRad) * len, 128 - Math.sin(angleRad) * len,
          128 + Math.cos(angleRad) * len, 128 + Math.sin(angleRad) * len
        );
        if (preset.colors.length === 2) {
          grad.addColorStop(0, preset.colors[0]);
          grad.addColorStop(1, preset.colors[1]);
        } else if (preset.colors.length >= 3) {
          grad.addColorStop(0, preset.colors[0]);
          grad.addColorStop(0.5, preset.colors[1]);
          grad.addColorStop(1, preset.colors[2]);
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 256);
      }

      const tex = new THREE.CanvasTexture(canvas);
      return new THREE.MeshBasicMaterial({ ...opts, map: tex });
    }

    if (frame.type === "image" && frame.imageUrl && loadedImages) {
      const img = loadedImages.get(frame.imageUrl);
      if (img) {
        const tex = new THREE.Texture(img);
        tex.needsUpdate = true;
        return new THREE.MeshBasicMaterial({ ...opts, map: tex });
      }
    }

    // Fallback
    return new THREE.MeshBasicMaterial({ ...opts, color: 0x333333 });
  }

  /** Build frame plane meshes for a surface and add to scene */
  private buildFramePlanes(
    surface: SurfaceConfig,
    parentMesh: THREE.Mesh,
    isTable: boolean,
    loadedImages?: Map<string, HTMLImageElement>
  ): THREE.Mesh[] {
    const planes: THREE.Mesh[] = [];
    const enabledFrames = surface.frames.filter(f => f.enabled);

    for (let i = 0; i < enabledFrames.length; i++) {
      const frame = enabledFrames[i];
      const material = this.createFramePlaneMaterial(frame, loadedImages);

      if (isTable) {
        const tableWidth = 28;
        const tableDepth = 5;
        const pw = frame.width * tableWidth;
        const pd = frame.height * tableDepth;
        const geo = new THREE.PlaneGeometry(pw, pd);
        const mesh = new THREE.Mesh(geo, material);

        const tablePos = parentMesh.position;
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(
          tablePos.x + (frame.x - 0.5) * tableWidth,
          tablePos.y + 0.01 * (i + 1),
          tablePos.z + (frame.y - 0.5) * tableDepth
        );
        mesh.rotation.z = (frame.rotation * Math.PI) / 180;
        mesh.userData = { type: 'tableFrame', frameId: frame.id, frameIndex: i };
        this.scene.add(mesh);
        planes.push(mesh);
      } else {
        const wallWidth = 34;
        const wallHeight = 22;
        const pw = frame.width * wallWidth;
        const ph = frame.height * wallHeight;
        const geo = new THREE.PlaneGeometry(pw, ph);
        const mesh = new THREE.Mesh(geo, material);

        const wallPos = parentMesh.position;
        mesh.position.set(
          wallPos.x + (frame.x - 0.5) * wallWidth,
          wallPos.y + (0.5 - frame.y) * wallHeight,
          wallPos.z + 0.01 * (i + 1)
        );
        mesh.rotation.z = (frame.rotation * Math.PI) / 180;
        mesh.userData = { type: 'wallFrame', frameId: frame.id, frameIndex: i };
        this.scene.add(mesh);
        planes.push(mesh);
      }
    }

    return planes;
  }

  /** Clear all frame plane meshes */
  private clearFramePlanes(): void {
    for (const mesh of [...this.wallFramePlanes, ...this.tableFramePlanes]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.MeshBasicMaterial;
      if (mat.map) mat.map.dispose();
      mat.dispose();
    }
    this.wallFramePlanes = [];
    this.tableFramePlanes = [];
  }

  /** Update frame plane positions/sizes from config without rebuilding textures */
  updateFramePlaneTransforms(config: VideoStudioConfig): void {
    const wallPos = this.backdrop?.position;
    if (wallPos) {
      const wallWidth = 34;
      const wallHeight = 22;
      const wallFrames = config.wallSurface.frames.filter(f => f.enabled);

      for (const mesh of this.wallFramePlanes) {
        const frame = wallFrames.find(f => f.id === mesh.userData.frameId);
        if (!frame) continue;
        mesh.position.set(
          wallPos.x + (frame.x - 0.5) * wallWidth,
          wallPos.y + (0.5 - frame.y) * wallHeight,
          wallPos.z + 0.01 * (mesh.userData.frameIndex + 1)
        );
        mesh.rotation.z = (frame.rotation * Math.PI) / 180;
        const pw = frame.width * wallWidth;
        const ph = frame.height * wallHeight;
        mesh.scale.set(pw / (mesh.geometry as THREE.PlaneGeometry).parameters.width,
                       ph / (mesh.geometry as THREE.PlaneGeometry).parameters.height, 1);
        (mesh.material as THREE.MeshBasicMaterial).opacity = frame.opacity;
      }
    }

    const tablePos = this.tableSurface?.position;
    if (tablePos) {
      const tableWidth = 28;
      const tableDepth = 5;
      const tableFrames = config.tableSurface.frames.filter(f => f.enabled);

      for (const mesh of this.tableFramePlanes) {
        const frame = tableFrames.find(f => f.id === mesh.userData.frameId);
        if (!frame) continue;
        mesh.position.set(
          tablePos.x + (frame.x - 0.5) * tableWidth,
          tablePos.y + 0.01 * (mesh.userData.frameIndex + 1),
          tablePos.z + (frame.y - 0.5) * tableDepth
        );
        mesh.rotation.z = (frame.rotation * Math.PI) / 180;
        (mesh.material as THREE.MeshBasicMaterial).opacity = frame.opacity;
      }
    }
  }

  /** Start animated preview for Video Studio (cue positioned + camera at start) */
  startStudioVideoPreview(config: VideoStudioConfig): void {
    this.stopVideoPreview();
    if (!this.model) return;

    this.studioConfigRef = config;
    const cue = config.cueConfig;

    // Setup cue instances
    this.setupCueInstances(cue);

    // Camera at start position
    this.setCameraFromKeyframe(config.cameraStart, cue);
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();

    const animate = () => {
      if (this.isDisposed || !this.studioConfigRef) return;
      this.animationFrameId = requestAnimationFrame(animate);
      const cfg = this.studioConfigRef;
      if (cfg.cueConfig.spinSpeed > 0) {
        this.spinCueInstances(cfg.cueConfig.spinSpeed * 0.02);
      }
      this.render();
    };
    animate();
  }

  /** Update studio preview config without restarting the loop */
  updateStudioPreviewConfig(config: VideoStudioConfig): void {
    this.studioConfigRef = config;
    if (!this.model) return;

    // Update cue instances
    this.updateCueInstances(config.cueConfig);

    // Sync frame plane positions/scales from config
    this.updateFramePlaneTransforms(config);

    // Update camera from start keyframe
    this.setCameraFromKeyframe(config.cameraStart, config.cueConfig);
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
  }

  /** Record video using the new start/end camera animation system */
  async startStudioRecording(
    config: VideoStudioConfig,
    onProgress?: (progress: number) => void
  ): Promise<Blob> {
    if (!this.model) throw new Error('No model loaded');

    const qp = VIDEO_QUALITY_PRESETS[config.quality];

    return new Promise((resolve, reject) => {
      this.renderer.setSize(qp.width, qp.height);
      this.camera.aspect = qp.width / qp.height;
      this.camera.updateProjectionMatrix();

      this.setupStudioFromStudioConfig(config).then(() => {
        this._startStudioRecordingLoop(config, qp, onProgress, resolve, reject);
      }).catch(reject);
    });
  }

  private _startStudioRecordingLoop(
    config: VideoStudioConfig,
    qp: { readonly width: number; readonly height: number; readonly bitrate: number; readonly fps: number },
    onProgress: ((p: number) => void) | undefined,
    resolve: (blob: Blob) => void,
    reject: (err: Error) => void
  ) {
    this.stopVideoPreview();

    // Setup cue instances for recording
    this.setupCueInstances(config.cueConfig);

    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();

    // Compute duration from path + speed
    const duration = computeVideoDuration(config.cameraStart, config.cameraEnd, config.cameraSpeed);
    const totalFrames = Math.ceil(qp.fps * duration);
    const easingFn = createEasingFunction(config.easing);

    // MediaRecorder setup
    const stream = this.renderer.domElement.captureStream(qp.fps);
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: getSupportedMimeType(),
      videoBitsPerSecond: qp.bitrate,
    });
    this.recordedChunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      resolve(new Blob(this.recordedChunks, { type: getSupportedMimeType() }));
    };
    this.mediaRecorder.onerror = () => {
      reject(new Error('Recording failed'));
    };

    let currentFrame = 0;
    const frameDuration = 1000 / qp.fps;
    let lastTimestamp = -1;
    const start = config.cameraStart;
    const end = config.cameraEnd;
    const cue = config.cueConfig;

    const animate = (timestamp: number) => {
      if (this.isDisposed || currentFrame >= totalFrames) {
        this.mediaRecorder?.stop();
        this.animationFrameId = null;
        return;
      }

      if (lastTimestamp >= 0 && timestamp - lastTimestamp < frameDuration) {
        this.animationFrameId = requestAnimationFrame(animate);
        return;
      }
      lastTimestamp = timestamp;

      const progress = currentFrame / totalFrames;
      onProgress?.(Math.round(progress * 100));
      const t = easingFn(progress);

      // Interpolate camera keyframe
      const interpolatedKeyframe = {
        cuePercent: start.cuePercent + (end.cuePercent - start.cuePercent) * t,
        distanceFromCue: start.distanceFromCue + (end.distanceFromCue - start.distanceFromCue) * t,
        offsetX: start.offsetX + (end.offsetX - start.offsetX) * t,
      };
      this.setCameraFromKeyframe(interpolatedKeyframe, cue);

      // Cue spin
      if (cue.spinSpeed > 0) {
        this.spinCueInstances(cue.spinSpeed * 0.02);
      }

      this.renderer.render(this.scene, this.camera);
      currentFrame++;
      this.animationFrameId = requestAnimationFrame(animate);
    };

    this.mediaRecorder.start();
    this.animationFrameId = requestAnimationFrame(animate);
  }

  /**
   * Start continuous animation loop for live preview
   */
  startLivePreview(): void {
    if (this.animationFrameId !== null) return; // Already running
    
    console.log('[ExtractorSceneManager] Starting live preview...');
    console.log('[ExtractorSceneManager] Scene children:', this.scene.children.length);
    console.log('[ExtractorSceneManager] Camera position:', this.camera.position.x.toFixed(2), this.camera.position.y.toFixed(2), this.camera.position.z.toFixed(2));
    console.log('[ExtractorSceneManager] Model in scene:', this.clonedModel ? 'yes' : 'no');
    
    const animate = () => {
      if (this.isDisposed) return;
      this.animationFrameId = requestAnimationFrame(animate);
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  /**
   * Stop continuous animation loop
   */
  stopLivePreview(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Render the current scene (call after making changes to see updates)
   */
  render(): void {
    if (this.isDisposed) return;
    this.updateCameraSmooth();
    if (this.cameraHelper) this.cameraHelper.update();
    const cam = this.isSceneView && this.godCamera ? this.godCamera : this.camera;
    this.renderer.render(this.scene, cam);
  }

  /**
   * Capture current view as data URL with transparency
   */
  captureFrame(format: 'png' | 'jpeg' | 'webp' = 'png'): string {
    this.renderer.render(this.scene, this.camera);
    const mimeType =
      format === 'jpeg'
        ? 'image/jpeg'
        : format === 'webp'
          ? 'image/webp'
          : 'image/png';
    return this.renderer.domElement.toDataURL(mimeType);
  }

  /**
   * Position camera using spherical coordinates (for orbit-style controls)
   */
  setCameraOrbit(
    orbitX: number,
    orbitY: number,
    distance: number,
    targetY: number = 0
  ): void {
    // orbitX = horizontal angle, orbitY = vertical angle (tilt)
    const x = distance * Math.sin(orbitX) * Math.cos(orbitY);
    const y = distance * Math.sin(orbitY) + targetY;
    const z = distance * Math.cos(orbitX) * Math.cos(orbitY);

    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, targetY, 0);
  }

  /**
   * Set camera zoom (adjusts FOV)
   */
  setCameraZoom(zoom: number): void {
    // Zoom by adjusting FOV inversely
    this.camera.fov = 50 / zoom;
    this.camera.updateProjectionMatrix();
  }

  async captureImageParts(config: ImageExtractorConfig): Promise<string> {
    if (!this.model) {
      throw new Error('No model loaded');
    }

    this.renderer.setSize(config.width, config.height);
    this.camera.aspect = config.width / config.height;
    this.camera.updateProjectionMatrix();

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = config.width;
    outputCanvas.height = config.height;
    const ctx = outputCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, config.width, config.height);

    const box = new THREE.Box3().setFromObject(this.model);
    const modelHeight = box.max.y - box.min.y;
    const modelCenter = box.getCenter(new THREE.Vector3());

    const partYPositions = {
      bottomBump: modelCenter.y - modelHeight * 0.4,
      centerCue: modelCenter.y,
      topCap: modelCenter.y + modelHeight * 0.4,
    };

    this.model.rotation.set(0, Math.PI / 4, 0);

    for (const [partName, partConfig] of Object.entries(config.parts)) {
      const partKey = partName as keyof typeof config.parts;
      const partCenterY = partYPositions[partKey];

      this.positionCameraForPart(partConfig, partCenterY);
      this.renderer.render(this.scene, this.camera);

      const { x, y, width, height } = partConfig.bounds;
      const destX = x * config.width;
      const destY = y * config.height;
      const destW = width * config.width;
      const destH = height * config.height;

      ctx.drawImage(
        this.renderer.domElement,
        0,
        0,
        config.width,
        config.height,
        destX,
        destY,
        destW,
        destH
      );
    }

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

  async startVideoRecording(
    config: VideoExtractorConfig,
    onProgress?: (progress: number) => void
  ): Promise<Blob> {
    if (!this.model) {
      throw new Error('No model loaded');
    }

    return new Promise((resolve, reject) => {
      this.renderer.setSize(config.width, config.height);
      this.camera.aspect = config.width / config.height;
      this.camera.updateProjectionMatrix();

      // setupStudioLighting is async but we call it synchronously here because
      // we already called it (with await) during init — textures are loaded.
      // Re-setup synchronously for recording resolution.
      this.setupStudioLighting(config).then(() => {
        this._startRecordingLoop(config, onProgress, resolve, reject);
      });
    });
  }

  private _startRecordingLoop(
    config: VideoExtractorConfig,
    onProgress: ((p: number) => void) | undefined,
    resolve: (blob: Blob) => void,
    reject: (err: Error) => void
  ) {
    // Stop any running video preview before starting recording
    this.stopVideoPreview();

    // ── Scale cue ──
    const modelScale = config.modelScale ?? 7;
    const prevScale = this.model!.scale.clone();
    this.model!.scale.setScalar(modelScale);
    this.model!.rotation.set(0, 0, 0);
    this.model!.position.set(0, 0, 0);

    // ── Tilt wrapper: lay cue perfectly horizontal, butt on LEFT ──
    const wrapperGroup = new THREE.Group();
    wrapperGroup.rotation.z = -Math.PI / 2;
    this.scene.remove(this.model!);
    wrapperGroup.add(this.model!);
    this.scene.add(wrapperGroup);
    this.videoWrapperGroup = wrapperGroup;

    // ── Compute cue world-space bounds for camera positioning ──
    wrapperGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrapperGroup);
    const cueLen = box.max.x - box.min.x;
    const buttX  = box.min.x;
    const endFraction = config.cameraEndFraction ?? 0.68;
    const camEndX = buttX + cueLen * endFraction;
    const camStartX = buttX + cueLen * 0.05; // start just inside butt end

    // ── Camera setup ──
    // Fixed height (parallel to table), 20° Dutch-angle roll so cue appears tilted.
    // As camera pans right, the tilted cue appears to "go down" in frame.
    const camY = 0.55;  // Fixed — parallel to table, no rising
    const camZ = 1.7;
    const rollDeg = config.cameraRoll ?? 20;
    const rollRad = rollDeg * Math.PI / 180;
    // Clockwise camera tilt (hold camera rotated right):
    //   up rotates clockwise → up.x = +sin, up.y = cos
    //   Cue (horizontal) appears to go lower-right → gives the "cue going down" feel
    this.camera.up.set(Math.sin(rollRad), Math.cos(rollRad), 0);
    this.camera.position.set(camStartX, camY, camZ);
    this.camera.lookAt(camStartX, 0, 0);

    const stream = this.renderer.domElement.captureStream(config.fps);
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: getSupportedMimeType(),
      videoBitsPerSecond: config.bitrate,
    });

    this.recordedChunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };

    const cleanup = () => {
      this.camera.up.set(0, 1, 0); // Reset camera roll
      if (wrapperGroup.parent) this.scene.remove(wrapperGroup);
      wrapperGroup.remove(this.model!);
      this.model!.scale.copy(prevScale);
      this.model!.rotation.set(0, 0, 0);
      this.model!.position.set(0, 0, 0);
      this.scene.add(this.model!);
      this.videoWrapperGroup = null;
    };

    this.mediaRecorder.onstop = () => {
      cleanup();
      const blob = new Blob(this.recordedChunks, { type: getSupportedMimeType() });
      resolve(blob);
    };

    this.mediaRecorder.onerror = () => {
      cleanup();
      reject(new Error('Recording failed'));
    };

    const totalFrames = config.fps * config.duration;
    let currentFrame = 0;

    // ── Timestamp-throttled animation loop ──
    // Critical: we must render at real wall-clock FPS so MediaRecorder captures
    // the correct duration. Without throttling, all frames render instantly and
    // the video ends up ~2 seconds regardless of duration setting.
    const frameDuration = 1000 / config.fps; // ms per frame
    let lastTimestamp = -1;

    const animate = (timestamp: number) => {
      if (this.isDisposed || currentFrame >= totalFrames) {
        this.mediaRecorder?.stop();
        this.animationFrameId = null;
        return;
      }

      // Skip this rAF tick if not enough wall-clock time has elapsed
      if (lastTimestamp >= 0 && timestamp - lastTimestamp < frameDuration) {
        this.animationFrameId = requestAnimationFrame(animate);
        return;
      }
      lastTimestamp = timestamp;

      const progress = currentFrame / totalFrames;
      onProgress?.(Math.round(progress * 100));

      // Cue spins around its own long axis
      this.model!.rotation.y += config.rotationSpeed / config.fps;

      // Camera pans right along cue — cameraDollySpeed controls fraction covered per video
      const dollySpeed = config.cameraDollySpeed ?? 0.15;
      const camX = camStartX + (camEndX - camStartX) * Math.min(1, progress * dollySpeed);
      this.camera.position.set(camX, camY, camZ);
      this.camera.lookAt(camX, 0, 0);

      this.renderer.render(this.scene, this.camera);

      currentFrame++;
      this.animationFrameId = requestAnimationFrame(animate);
    };

    this.mediaRecorder.start();
    this.animationFrameId = requestAnimationFrame(animate);
  }

  stopRecording() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  // ---------------------------------------------------------------------------
  // Scene view — god camera + CameraHelper frustum
  // ---------------------------------------------------------------------------

  /** Initialize scene view with god camera + studio camera frustum helper */
  initSceneView(): void {
    this.godCamera = new THREE.PerspectiveCamera(60, this.width / this.height, 0.1, 200);
    this.godCamera.position.set(0, 8, 15);
    this.godCamera.lookAt(0, 2, 0);

    this.cameraHelper = new THREE.CameraHelper(this.camera);
    this.cameraHelper.visible = false;
    this.cameraHelper.scale.setScalar(1.5);
    this.scene.add(this.cameraHelper);

    // Camera gizmo — visible, selectable proxy
    const gizmoGroup = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.45, 0.45),
      new THREE.MeshBasicMaterial({ color: 0xff6600 })
    );
    gizmoGroup.add(body);
    const lens = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 0.5, 4),
      new THREE.MeshBasicMaterial({ color: 0xff9933 })
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.z = 0.4;
    gizmoGroup.add(lens);
    gizmoGroup.userData = { type: 'camera' };
    this.cameraGizmo = gizmoGroup;
    this.scene.add(gizmoGroup);
    this.syncCameraGizmo();
  }

  setViewMode(mode: "scene" | "camera"): void {
    this.isSceneView = mode === "scene";
    if (this.cameraHelper) {
      this.cameraHelper.visible = this.isSceneView;
    }
    if (this.cameraGizmo) this.cameraGizmo.visible = this.isSceneView;
  }

  getViewMode(): "scene" | "camera" {
    return this.isSceneView ? "scene" : "camera";
  }

  getGodCamera(): THREE.PerspectiveCamera | null {
    return this.godCamera;
  }

  /** Position studio camera from a CameraKeyframe — cuePercent maps to Y along cue length */
  setCameraFromKeyframe(keyframe: CameraKeyframe, cueConfig: CueConfig): void {
    const mainCue = cueConfig.instances.find(i => i.isMain) || cueConfig.instances[0];
    if (!mainCue) return;

    const cueBottom = mainCue.positionY - 1.2;
    const cueHeight = mainCue.scale * 1.3;
    const cueTop = cueBottom + cueHeight;

    const targetY = cueBottom + (cueTop - cueBottom) * (keyframe.cuePercent / 100);
    const targetX = mainCue.positionX;
    const targetZ = mainCue.positionZ;

    this.camera.position.set(
      targetX + keyframe.offsetX,
      targetY,
      targetZ + keyframe.distanceFromCue
    );

    // Look straight at cue at camera's own Y — cameraman on vertical rail
    this.camera.lookAt(targetX, targetY, targetZ);
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();

    // Instant jump — sync target so lerp doesn't animate from old position
    this.cameraTargetPos.copy(this.camera.position);

    if (this.cameraHelper) this.cameraHelper.update();
    this.syncCameraGizmo();
  }

  /** Move studio camera by screen-space delta, with optional axis lock. Returns updated position for UI sync. */
  moveStudioCamera(
    dx: number,
    dy: number,
    axisLock: "x" | "y" | "z" | null = null
  ): { x: number; y: number; z: number } {
    const sensitivity = 0.03;

    // Initialize target from current position if not smooth yet
    if (!this.cameraSmoothEnabled) {
      this.cameraTargetPos.copy(this.camera.position);
      this.cameraSmoothEnabled = true;
    }

    switch (axisLock) {
      case "x":
        this.cameraTargetPos.x += dx * sensitivity;
        break;
      case "y":
        // Move camera Y position AND slide lookAt point along the cue
        this.cameraTargetPos.y -= dy * sensitivity;
        this.cameraLookAtYOffset = Math.max(0, Math.min(1,
          this.cameraLookAtYOffset - dy * 0.005
        ));
        break;
      case "z":
        this.cameraTargetPos.z -= dy * sensitivity;
        break;
      default:
        this.cameraTargetPos.x += dx * sensitivity;
        this.cameraTargetPos.y -= dy * sensitivity;
        break;
    }

    // Clamp target position
    this.cameraTargetPos.x = Math.max(-15, Math.min(15, this.cameraTargetPos.x));
    this.cameraTargetPos.y = Math.max(-1.0, Math.min(14, this.cameraTargetPos.y));
    this.cameraTargetPos.z = Math.max(0.3, Math.min(12, this.cameraTargetPos.z));

    return { x: this.cameraTargetPos.x, y: this.cameraTargetPos.y, z: this.cameraTargetPos.z };
  }

  /** Clamp camera so it stays within studio bounds */
  private clampCameraToStudioBounds(): void {
    const pos = this.camera.position;

    const minX = -15;
    const maxX = 15;
    const minY = -1.0;
    const maxY = 14;
    const minZ = 0.3;
    const maxZ = 12;

    pos.x = Math.max(minX, Math.min(maxX, pos.x));
    pos.y = Math.max(minY, Math.min(maxY, pos.y));
    pos.z = Math.max(minZ, Math.min(maxZ, pos.z));
  }

  /** Convert current camera position to a CameraKeyframe (for "Set Start/End" buttons) */
  getCameraKeyframeFromPosition(cueConfig: CueConfig): CameraKeyframe {
    const mainCue = cueConfig.instances.find(i => i.isMain) || cueConfig.instances[0];
    if (!mainCue) return { cuePercent: 50, distanceFromCue: 3, offsetX: 0 };

    const cueBottom = mainCue.positionY - 1.2;
    const cueHeight = mainCue.scale * 1.3;
    const cueTop = cueBottom + cueHeight;

    const pos = this.camera.position;
    const cuePercent = ((pos.y - cueBottom) / (cueTop - cueBottom)) * 100;
    const distanceFromCue = pos.z - mainCue.positionZ;
    const offsetX = pos.x - mainCue.positionX;

    return {
      cuePercent: Math.max(0, Math.min(100, cuePercent)),
      distanceFromCue: Math.max(0.5, Math.min(5, distanceFromCue)),
      offsetX: Math.max(-2, Math.min(2, offsetX)),
    };
  }

  private syncCameraGizmo(): void {
    if (!this.cameraGizmo) return;
    this.cameraGizmo.position.copy(this.camera.position);
    this.cameraGizmo.quaternion.copy(this.camera.quaternion);
  }

  /** Reverse sync: copy gizmo position/rotation back to the studio camera + update helper */
  syncCameraFromGizmo(): void {
    if (!this.cameraGizmo) return;
    this.camera.position.copy(this.cameraGizmo.position);
    this.camera.quaternion.copy(this.cameraGizmo.quaternion);
    this.camera.updateProjectionMatrix();
    this.cameraTargetPos.copy(this.camera.position);
    if (this.cameraHelper) this.cameraHelper.update();
  }

  /** Update smooth camera interpolation — call each frame */
  updateCameraSmooth(): void {
    if (!this.cameraSmoothEnabled) return;
    this.camera.position.lerp(this.cameraTargetPos, 0.15);

    // Look straight at cue at camera's own Y level — cameraman on vertical rail
    const mainCue = this.currentCueConfig?.instances.find(i => i.isMain)
      || this.currentCueConfig?.instances[0];
    if (mainCue) {
      this.camera.lookAt(mainCue.positionX, this.camera.position.y, mainCue.positionZ);
    }

    this.camera.updateProjectionMatrix();
    if (this.cameraHelper) this.cameraHelper.update();
    this.syncCameraGizmo();
  }

  getCameraGizmo(): THREE.Group | null { return this.cameraGizmo; }

  /** Set camera lookAt Y offset along cue: 0 = bottom, 0.5 = center, 1 = top */
  setCameraLookAtYOffset(offset: number): void {
    this.cameraLookAtYOffset = Math.max(0, Math.min(1, offset));
  }

  getCameraLookAtYOffset(): number { return this.cameraLookAtYOffset; }

  getScene(): THREE.Scene { return this.scene; }

  getSelectableObjects(): THREE.Object3D[] {
    const objects: THREE.Object3D[] = [];
    if (this.cameraGizmo) objects.push(this.cameraGizmo);
    if (this.backdrop) objects.push(this.backdrop);
    if (this.tableSurface) objects.push(this.tableSurface);
    objects.push(...this.wallFramePlanes);
    objects.push(...this.tableFramePlanes);
    if (this.model) objects.push(this.model);
    for (const im of this.instancedMeshes) objects.push(im);
    return objects;
  }

  resize(width: number, height: number) {
    // Pass updateStyle: false to prevent Three.js from overwriting canvas CSS styles
    // This allows the canvas to scale via CSS (100% width/height) while maintaining
    // the internal rendering resolution
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.godCamera) {
      this.godCamera.aspect = width / height;
      this.godCamera.updateProjectionMatrix();
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-cue InstancedMesh support
  // ---------------------------------------------------------------------------

  setupCueInstances(config: CueConfig): void {
    this.clearInstancedMeshes();
    this.currentCueConfig = config;

    if (!this.clonedModel) return;

    const instances = config.instances;

    if (instances.length <= 1) {
      // Single cue — use regular model
      this.clonedModel.visible = true;
      if (instances.length === 1) {
        const inst = instances[0];
        this.clonedModel.position.set(inst.positionX, inst.positionY, inst.positionZ);
        this.clonedModel.scale.setScalar(inst.scale);
      }
      this.clonedModel.userData = { type: 'cue' };
      return;
    }

    // Multiple cues — use InstancedMesh
    this.clonedModel.visible = false;

    // Collect child meshes
    const childMeshes: THREE.Mesh[] = [];
    this.clonedModel.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        childMeshes.push(child);
      }
    });

    const dummy = new THREE.Object3D();

    for (const childMesh of childMeshes) {
      const im = new THREE.InstancedMesh(
        childMesh.geometry,
        childMesh.material,
        instances.length
      );
      im.castShadow = true;
      im.receiveShadow = false;

      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        dummy.position.set(inst.positionX, inst.positionY, inst.positionZ);
        dummy.scale.setScalar(inst.scale);
        dummy.rotation.set(0, config.spinY, 0);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      this.instancedMeshes.push(im);
      this.scene.add(im);
    }
    for (const mesh of this.instancedMeshes) {
      mesh.userData = { type: 'cue' };
    }
  }

  updateCueInstances(config: CueConfig): void {
    this.currentCueConfig = config;

    if (!this.clonedModel) return;

    const instances = config.instances;

    if (instances.length <= 1 && this.instancedMeshes.length === 0) {
      // Single cue using regular model
      if (instances.length === 1) {
        const inst = instances[0];
        this.clonedModel.position.set(inst.positionX, inst.positionY, inst.positionZ);
        this.clonedModel.scale.setScalar(inst.scale);
        this.clonedModel.rotation.y = config.spinY;
      }
      return;
    }

    // Update instanced mesh matrices
    if (this.instancedMeshes.length === 0) {
      // Need to recreate — instance count changed
      this.setupCueInstances(config);
      return;
    }

    // Check if instance count changed
    if (this.instancedMeshes[0]?.count !== instances.length) {
      this.setupCueInstances(config);
      return;
    }

    const dummy = new THREE.Object3D();

    for (const im of this.instancedMeshes) {
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        dummy.position.set(inst.positionX, inst.positionY, inst.positionZ);
        dummy.scale.setScalar(inst.scale);
        dummy.rotation.set(0, config.spinY, 0);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  }

  spinCueInstances(spinDelta: number): void {
    if (!this.currentCueConfig) return;

    const instances = this.currentCueConfig.instances;

    if (instances.length <= 1 && this.instancedMeshes.length === 0) {
      // Regular model
      if (this.clonedModel) {
        this.clonedModel.rotation.y += spinDelta;
      }
      return;
    }

    const dummy = new THREE.Object3D();
    const currentY = (this.currentCueConfig.spinY || 0) + spinDelta;
    // Update tracking
    this.currentCueConfig = { ...this.currentCueConfig, spinY: currentY };

    for (const im of this.instancedMeshes) {
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        dummy.position.set(inst.positionX, inst.positionY, inst.positionZ);
        dummy.scale.setScalar(inst.scale);
        dummy.rotation.set(0, currentY, 0);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  }

  private clearInstancedMeshes(): void {
    for (const im of this.instancedMeshes) {
      this.scene.remove(im);
      im.dispose();
    }
    this.instancedMeshes = [];
    if (this.clonedModel) {
      this.clonedModel.visible = true;
    }
  }

  dispose() {
    this.isDisposed = true;
    this.stopLivePreview();
    this.stopRecording();
    this.clearStudioElements();
    this.clearInstancedMeshes();

    if (this.cameraHelper) {
      this.scene.remove(this.cameraHelper);
      this.cameraHelper.dispose();
      this.cameraHelper = null;
    }
    if (this.cameraGizmo) {
      this.scene.remove(this.cameraGizmo);
      this.cameraGizmo = null;
    }
    this.godCamera = null;

    if (this.clonedModel) {
      this.scene.remove(this.clonedModel);
      this.disposeModel(this.clonedModel);
    }

    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
    }

    if (this.hdriTexture) {
      this.hdriTexture.dispose();
      this.hdriTexture = null;
    }

    if (this.directionalLight) {
      this.scene.remove(this.directionalLight);
      this.directionalLight.dispose();
      this.directionalLight = null;
    }

    this.pmremGenerator.dispose();

    // Shrink framebuffer to 1×1 before dispose to immediately free VRAM.
    // Three.js dispose() alone only frees JS-side references; the GPU driver
    // keeps the backing store until the context is actually lost.
    this.renderer.setSize(1, 1);
    this.renderer.renderLists.dispose();
    this.renderer.dispose();

    // Force the WebGL context loss so the GPU driver releases memory right away
    // rather than waiting for the JS garbage collector.
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext) ext.loseContext();
    } catch {
      // Ignore — some environments may not support WEBGL_lose_context
    }
  }
}
