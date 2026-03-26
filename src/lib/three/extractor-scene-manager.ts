import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type {
  ImageExtractorConfig,
  VideoExtractorConfig,
  PartViewConfig,
  HdriLayer,
} from '@/types/extractor';
import {
  createFabricTexture,
  createStudioBackdrop,
  createShadowFloor,
} from './studio-background';

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
  private spotLight: THREE.SpotLight | null = null;
  private fillLights: THREE.PointLight[] = [];
  private directionalLight: THREE.DirectionalLight | null = null;

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

  setupStudioLighting(config: VideoExtractorConfig) {
    this.clearStudioElements();

    // Key spotlight
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
    const fillPositions: [number, number, number][] = [
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

    // Fabric backdrop
    const fabricTexture = createFabricTexture(
      1024,
      1024,
      config.backgroundColor
    );
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
    if (!this.isDisposed) {
      this.renderer.render(this.scene, this.camera);
    }
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

      this.setupStudioLighting(config);
      this.model!.rotation.set(0, 0, -config.cueAngle);

      const stream = this.renderer.domElement.captureStream(config.fps);
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: getSupportedMimeType(),
        videoBitsPerSecond: config.bitrate,
      });

      this.recordedChunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const mimeType = getSupportedMimeType();
        const blob = new Blob(this.recordedChunks, { type: mimeType });
        resolve(blob);
      };

      this.mediaRecorder.onerror = () => {
        reject(new Error('Recording failed'));
      };

      const totalFrames = config.fps * config.duration;
      let currentFrame = 0;
      const cameraDistance = 2;

      const animate = () => {
        if (this.isDisposed || currentFrame >= totalFrames) {
          this.mediaRecorder?.stop();
          this.animationFrameId = null;
          return;
        }

        const progress = currentFrame / totalFrames;
        onProgress?.(Math.round(progress * 100));

        this.model!.rotation.y += config.rotationSpeed / config.fps;

        const panY =
          config.panStartY + (config.panEndY - config.panStartY) * progress;
        this.camera.position.set(
          cameraDistance * Math.cos(Math.PI / 6),
          panY,
          cameraDistance * Math.sin(Math.PI / 6)
        );
        this.camera.lookAt(0, panY, 0);

        this.renderer.render(this.scene, this.camera);

        currentFrame++;
        this.animationFrameId = requestAnimationFrame(animate);
      };

      this.mediaRecorder.start();
      animate();
    });
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

  resize(width: number, height: number) {
    // Pass updateStyle: false to prevent Three.js from overwriting canvas CSS styles
    // This allows the canvas to scale via CSS (100% width/height) while maintaining
    // the internal rendering resolution
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.isDisposed = true;
    this.stopLivePreview();
    this.stopRecording();
    this.clearStudioElements();

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
    this.renderer.dispose();
  }
}
