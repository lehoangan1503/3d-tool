import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
// import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { ThreeJSSettings } from "@/types/settings";
import { DEFAULT_THREEJS_SETTINGS } from "@/types/settings";
import { LEATHER_CONFIG, TOP_CAP_CONFIG, CYLINDER_LEATHER_CONFIG, isRubberMaterial, isTopCapMaterial, isTopCapFaceMaterial, isCylinderLeatherMaterial } from "./leather-config";
import {
  loadLeatherNormal,
  createLeatherTextureMaps,
  createLeatherMaterial,
  createStandardMaterial,
  loadAllLogos,
  applyLogoToExistingMaterial,
  applyRubberLogoEmissive,
  type LeatherTextureMaps,
} from "./leather-material";
import { createLeatherRoughnessMap } from "./leather-overlay";
import type { ProductType, LeatherColor, LeatherTextureType } from "@/types/product";

export interface SurfaceOptions {
  surfaceUrl?: string | null;
  productType: ProductType;
  leatherColor?: LeatherColor | null;
  leatherTexture?: LeatherTextureType | null;
  textureScale?: number; // How many times to tile the normal map texture (1-8)
}

/**
 * Get optimal texture size based on device capabilities.
 * Mobile devices with limited RAM get smaller textures to prevent crashes.
 */
function getOptimalTextureSize(): number {
  // Check if running in browser
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 4096; // Server-side: assume desktop
  }
  
  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  
  // Mobile devices or low memory: use 2048
  // This reduces canvas texture VRAM from ~340MB to ~85MB (4x reduction)
  if (isMobile) {
    console.log('[SceneManager] 📱 Mobile detected → using 2048px textures');
    return 2048;
  }
  
  if (deviceMemoryGB !== undefined && deviceMemoryGB <= 4) {
    console.log(`[SceneManager] 💾 Low memory device (${deviceMemoryGB}GB) → using 2048px textures`);
    return 2048;
  }
  
  // Desktop with sufficient memory: use 4096 for best quality
  console.log('[SceneManager] 💻 Desktop with sufficient memory → using 4096px textures');
  return 4096;
}

// Canvas size for texture maps (adaptive based on device)
const TEXTURE_CANVAS_SIZE = getOptimalTextureSize();

// Instance counter for debugging
let sceneManagerInstanceId = 0;

/**
 * Upgrade a MeshStandardMaterial to MeshPhysicalMaterial (preserving all properties).
 * GLTFLoader creates MeshStandardMaterial by default; MeshPhysicalMaterial is needed
 * for clearcoat, sheen, and other physical properties.
 */
function ensurePhysicalMaterial(mesh: THREE.Mesh, mat: THREE.MeshStandardMaterial, index: number): THREE.MeshPhysicalMaterial {
  if (mat instanceof THREE.MeshPhysicalMaterial) return mat;

  const physMat = new THREE.MeshPhysicalMaterial({
    map: mat.map,
    color: mat.color,
    roughness: mat.roughness,
    metalness: mat.metalness,
    normalMap: mat.normalMap,
    normalScale: mat.normalScale?.clone(),
    aoMap: mat.aoMap,
    aoMapIntensity: mat.aoMapIntensity,
    emissive: mat.emissive?.clone(),
    emissiveMap: mat.emissiveMap,
    emissiveIntensity: mat.emissiveIntensity,
    bumpMap: mat.bumpMap,
    bumpScale: mat.bumpScale,
    displacementMap: mat.displacementMap,
    displacementScale: mat.displacementScale,
    // IMPORTANT: Do not copy GLB-provided envMap. We want scene.environment to drive HDRI lighting.
    envMap: null,
    envMapIntensity: mat.envMapIntensity,
    alphaMap: mat.alphaMap,
    side: mat.side,
    transparent: mat.transparent,
    opacity: mat.opacity,
    name: mat.name,
  });

  // Replace in mesh
  if (Array.isArray(mesh.material)) {
    mesh.material[index] = physMat;
  } else {
    mesh.material = physMat;
  }

  mat.dispose();
  console.log(`[SceneManager] Upgraded material "${mat.name}" to MeshPhysicalMaterial`);
  return physMat;
}

export class SceneManager {
  private instanceId: number;
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
  // private ambientLight: THREE.AmbientLight | null = null;
  // private hemisphereLight: THREE.HemisphereLight | null = null;
  private pmremGenerator: THREE.PMREMGenerator | null = null;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private ktx2Loader: KTX2Loader | null = null;
  private currentHdriUrl = "/hdri/bloem_train_track_clear_2k.hdr";
  private hdriLoadSeq = 0;
  private hdriRotationX = 0; // HDRI vertical rotation (degrees)
  private hdriRotationY = 300; // HDRI horizontal rotation (degrees)
  private cachedHdriTexture: THREE.DataTexture | null = null; // Cached source texture for rotation
  private isDisposed = false;
  private currentLeatherConfig = {
    roughness: LEATHER_CONFIG.roughness,
    clearcoat: LEATHER_CONFIG.clearcoat,
    sheen: LEATHER_CONFIG.sheen,
    normalStrength: LEATHER_CONFIG.normalStrength,
  };
  private currentCylinderConfig = {
    roughness: CYLINDER_LEATHER_CONFIG.roughness,
    clearcoat: CYLINDER_LEATHER_CONFIG.clearcoat,
    metalness: CYLINDER_LEATHER_CONFIG.metalness,
    color: CYLINDER_LEATHER_CONFIG.color,
    normalScale: CYLINDER_LEATHER_CONFIG.normalScale,
    sheen: CYLINDER_LEATHER_CONFIG.sheen,
    sheenColor: CYLINDER_LEATHER_CONFIG.sheenColor,
  };
  private currentJointConfig = {
    roughness: TOP_CAP_CONFIG.roughness,
    clearcoat: TOP_CAP_CONFIG.clearcoat,
    metalness: TOP_CAP_CONFIG.metalness,
  };
  private currentBumperConfig = {
    roughness: 50,
    metalness: 0.4,
    color: "#000000",
  };
  private bodyRoughness = 0; // For smooth cue body (default: 0)
  private textureScale = 1; // Texture tiling scale (1 = no tiling)
  private isLeatherProduct = false; // Track product type
  private leatherRoughnessTexture: THREE.CanvasTexture | null = null; // For dynamic roughness map updates
  private autoRotate = true; // Auto-rotate model on Y axis
  private autoRotateSpeed = 0.003; // Slow rotation speed (radians per frame)

  // Turntable-style rotation: rotate the MODEL on drag so HDRI/IBL stays world-fixed
  private isDraggingModel = false;
  private dragPointerId: number | null = null;
  private dragLastX = 0;
  private dragLastY = 0;
  private activePointers = new Set<number>();
  private restoreAutoRotateAfterDrag: boolean | null = null;
  private modelDragRotateSpeed = 0.005; // radians per pixel
  private cameraOrbitSpeed = 0.005; // radians per pixel (vertical drag)
  private wheelZoomSpeed = 0.00075; // world-units per wheel deltaY pixel
  private pinchZoomSpeed = 0.00225; // world units per pixel of pinch distance change

  // FOV clamp (used by adjustCameraFOV helper)
  private minFOV = 15;
  private maxFOV = 80;

  private cameraMinPolarAngle = 0.001; // ~0° (top view) without hitting the pole singularity
  private cameraMaxPolarAngle = Math.PI - 0.001; // ~180° (bottom view)

  // Inertia / velocity
  private inertiaDamping = 0.85; // closer to 1 = longer glide (reduced from 0.92 for slower momentum)
  private inertiaGain = 0.18; // scale down release velocity vs. drag delta
  private maxSpinVelocityY = 0.025; // radians per frame
  private maxOrbitVelocityPhi = 0.025; // radians per frame

  private spinVelocityY = 0;
  private orbitVelocityPhi = 0;
  private lastFrameTime = 0;

  // Pinch-zoom tracking (mobile)
  private pointerPositions = new Map<number, { x: number; y: number }>();
  private lastPinchDistance = 0;

  // Zoom-out cap: do not allow zooming out beyond the initial load distance.
  private maxZoomOutRadius: number | null = null;

  constructor(container: HTMLElement, settings?: ThreeJSSettings) {
    this.instanceId = ++sceneManagerInstanceId;
    console.log(`[SceneManager #${this.instanceId}] Constructor called`);

    this.container = container;
    this.settings = settings || DEFAULT_THREEJS_SETTINGS;

    // Initialize RectAreaLight uniforms (commented out — using HDRI instead)
    // RectAreaLightUniformsLib.init();

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.settings.background.dark);

    // Camera
    const { fov, position, near, far } = this.settings.camera;
    this.camera = new THREE.PerspectiveCamera(fov, container.clientWidth / container.clientHeight, near, far);
    this.camera.position.set(position[0], position[1], position[2]);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    // Handle WebGL context loss (e.g. GPU out-of-memory on mobile)
    this.renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost, false);
    this.renderer.domElement.addEventListener("webglcontextrestored", this.handleContextRestored, false);

    // HDRI preprocessing for correct image-based lighting
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    // KTX2 / Basis Universal transcoder — keeps textures GPU-compressed in VRAM.
    // Basis transcoder files are copied from three/examples/jsm/libs/basis/ to /public/basis/.
    this.ktx2Loader = new KTX2Loader();
    this.ktx2Loader.setTranscoderPath("/basis/");
    this.ktx2Loader.detectSupport(this.renderer);

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

    // Keep camera stable; rotate the model instead (prevents HDRI lighting from appearing to rotate with the cue)
    this.controls.enableRotate = false;

    // Custom drag-to-rotate (turntable)
    this.setupTurntableModelRotation();

    // Keep cue centered horizontally: allow vertical pan (Y), but prevent X/Z drift.
    this.controls.addEventListener("change", () => {
      const offsetX = this.camera.position.x - this.controls.target.x;
      const offsetZ = this.camera.position.z - this.controls.target.z;

      this.controls.target.x = 0;
      this.controls.target.z = 0;

      // Undo any horizontal pan by keeping the camera offset relative to the target.
      this.camera.position.x = offsetX;
      this.camera.position.z = offsetZ;
    });

    // Lighting — HDRI environment
    this.setupEnvironment();

    // Lighting (commented out — using HDRI instead)
    // this.setupLighting();

    // Handle resize
    window.addEventListener("resize", this.handleResize);

    // Start animation loop
    this.animate();
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    console.error(
      "[SceneManager] WebGL context lost — GPU ran out of memory. " +
        "Stop the animation loop to prevent errors."
    );
    // Pause the render loop; the browser will fire contextrestored when ready.
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  };

  private handleContextRestored = () => {
    console.warn("[SceneManager] WebGL context restored — restarting animation loop.");
    if (!this.isDisposed) {
      this.animate();
    }
  };

  private setupEnvironment() {
    // Load default HDRI (UI can override via updateHdriEnvironment)
    this.updateHdriEnvironment(this.currentHdriUrl);

    // Subtle fill light from below to illuminate the bumper area
    const bottomFill = new THREE.PointLight(0xffffff, 0.5, 10);
    bottomFill.position.set(0, -3, 1);
    this.scene.add(bottomFill);

    this.scene.add(this.camera);
  }

  // --- Commented out light config (may reuse later) ---
  // private setupLighting() {
  //   // Ambient light
  //   this.ambientLight = new THREE.AmbientLight(0xffffff, this.settings.lighting.ambient);
  //   this.scene.add(this.ambientLight);
  //
  //   // Hemisphere light
  //   this.hemisphereLight = new THREE.HemisphereLight(0xffffff, 0xf0f0f0, this.settings.lighting.hemisphere);
  //   this.scene.add(this.hemisphereLight);
  //
  //   // Studio-style RectAreaLights attached to camera
  //   const stripRight = new THREE.RectAreaLight(0xffffff, 5, 1.0, 5);
  //   stripRight.position.set(2, 0, 1);
  //   stripRight.lookAt(0, 0, 0);
  //   this.camera.add(stripRight);
  //
  //   const stripLeft = new THREE.RectAreaLight(0xffffff, 4, 0.8, 4.5);
  //   stripLeft.position.set(-1.8, 0, 1);
  //   stripLeft.lookAt(0, 0, 0);
  //   this.camera.add(stripLeft);
  //
  //   const stripTop = new THREE.RectAreaLight(0xffffff, 4.5, 4, 0.8);
  //   stripTop.position.set(0, 2, 1);
  //   stripTop.lookAt(0, 0, 0);
  //   this.camera.add(stripTop);
  //
  //   const stripBottom = new THREE.RectAreaLight(0xffffff, 3.5, 3.5, 0.6);
  //   stripBottom.position.set(0, -1.8, 1);
  //   stripBottom.lookAt(0, 0, 0);
  //   this.camera.add(stripBottom);
  //
  //   this.scene.add(this.camera);
  // }

  /**
   * Update lighting settings dynamically (commented out — using HDRI instead)
   */
  // updateLighting(ambient: number, hemisphere: number) {
  //   console.log("[SceneManager] updateLighting:", { ambient, hemisphere });
  //   if (this.ambientLight) {
  //     this.ambientLight.intensity = ambient;
  //     console.log("[SceneManager] Ambient light intensity set to:", ambient);
  //   }
  //   if (this.hemisphereLight) {
  //     this.hemisphereLight.intensity = hemisphere;
  //     console.log("[SceneManager] Hemisphere light intensity set to:", hemisphere);
  //   }
  // }

  updateToneMapping(_mode?: string) {
    if (this.isDisposed) return;
    // Use original/no tone mapping by default
    this.renderer.toneMapping = THREE.NoToneMapping;
  }

  /**
   * Update HDRI exposure (tone mapping exposure)
   */
  updateHdriExposure(exposure: number) {
    console.log("[SceneManager] updateHdriExposure:", exposure);
    this.renderer.toneMappingExposure = exposure;
  }

  /**
   * Update HDRI environment map.
   *
   * Accepted inputs:
   * - Absolute URL: "https://cdn.shopify.com/.../env.hdr" (Shopify Files/CDN)
   * - Root-relative URL: "/hdri/env.hdr" (Next.js public folder)
   * - Filename: "env.hdr" (resolved under "/hdri/")
   */
  updateHdriEnvironment(hdriTypeOrUrl: string) {
    if (this.isDisposed) return;

    const isAbsoluteUrl = /^https?:\/\//.test(hdriTypeOrUrl) || hdriTypeOrUrl.startsWith("//");
    const url = isAbsoluteUrl
      ? hdriTypeOrUrl
      : hdriTypeOrUrl.startsWith("/")
        ? hdriTypeOrUrl
        : `/hdri/${encodeURIComponent(hdriTypeOrUrl)}`;

    this.currentHdriUrl = url;

    // PMREMGenerator can be disposed during React unmount/remount while an HDRI load is in flight.
    // Lazily recreate it if needed.
    if (!this.pmremGenerator) {
      this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
      this.pmremGenerator.compileEquirectangularShader();
    }

    const loadSeq = ++this.hdriLoadSeq;
    const rgbeLoader = new RGBELoader();
    rgbeLoader.load(
      url,
      (texture) => {
        const pmremGenerator = this.pmremGenerator;

        // If we were disposed, a newer request started, or PMREM isn't available anymore, ignore this result.
        if (this.isDisposed || loadSeq !== this.hdriLoadSeq || !pmremGenerator) {
          texture.dispose();
          return;
        }

        // Cache the source texture for rotation support
        if (this.cachedHdriTexture) {
          this.cachedHdriTexture.dispose();
        }
        this.cachedHdriTexture = texture as THREE.DataTexture;

        // Apply rotation if any, otherwise use original
        if (Math.abs(this.hdriRotationX) > 0.1 || Math.abs(this.hdriRotationY) > 0.1) {
          this.applyHdriRotation();
        } else {
          texture.mapping = THREE.EquirectangularReflectionMapping;

          const rt = pmremGenerator.fromEquirectangular(texture);

          if (this.envRenderTarget) {
            this.envRenderTarget.dispose();
          }
          this.envRenderTarget = rt;

          this.scene.environment = rt.texture;
          // Keep solid background color (don't set scene.background to HDRI)

          // Make sure any GLB-provided envMap doesn't override scene.environment
          this.forceSceneEnvironmentOnMaterials();
        }
      },
      undefined,
      (error) => {
        if (!this.isDisposed) {
          console.error("[SceneManager] Failed to load HDRI:", url, error);
        }
      }
    );
  }

  /**
   * Update HDRI rotation (direction X and Y)
   * X = vertical shift (0-360°), Y = horizontal shift (0-360°)
   */
  updateHdriRotation(rotationX: number, rotationY: number) {
    if (this.isDisposed) return;
    
    // Only update if values changed
    if (this.hdriRotationX === rotationX && this.hdriRotationY === rotationY) {
      return;
    }
    
    this.hdriRotationX = rotationX;
    this.hdriRotationY = rotationY;
    
    // If we have a cached texture, apply rotation
    if (this.cachedHdriTexture) {
      this.applyHdriRotation();
    }
  }

  /**
   * Apply rotation to the cached HDRI texture
   */
  private applyHdriRotation() {
    if (!this.cachedHdriTexture || this.isDisposed) return;
    
    const pmremGenerator = this.pmremGenerator;
    if (!pmremGenerator) return;
    
    const rotatedTexture = this.createRotatedHdriTextureXY(
      this.cachedHdriTexture, 
      this.hdriRotationX, 
      this.hdriRotationY
    );
    
    if (!rotatedTexture) return;
    
    rotatedTexture.mapping = THREE.EquirectangularReflectionMapping;
    
    const rt = pmremGenerator.fromEquirectangular(rotatedTexture);
    rotatedTexture.dispose();
    
    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
    }
    this.envRenderTarget = rt;
    this.scene.environment = rt.texture;
    this.forceSceneEnvironmentOnMaterials();
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
      const rotX = ((rotationXDeg % 360) + 360) % 360;
      const rotY = ((rotationYDeg % 360) + 360) % 360;

      if (!sourceTexture.image || !sourceTexture.image.width || !sourceTexture.image.height) {
        return null;
      }

      const width = sourceTexture.image.width;
      const height = sourceTexture.image.height;
      const sourceData = sourceTexture.image.data as Float32Array | Uint8Array | Uint16Array | null;
      
      if (!sourceData || sourceData.length === 0) {
        return null;
      }
      
      const channels = sourceData.length / (width * height);
      if (channels < 1 || channels > 4 || !Number.isInteger(channels)) {
        return null;
      }
      
      // If no rotation, create a deep copy
      if (Math.abs(rotX) < 0.1 && Math.abs(rotY) < 0.1) {
        return this.deepCloneDataTexture(sourceTexture);
      }
      
      // Calculate pixel shifts
      const shiftX = Math.round((rotY / 360) * width);
      const shiftY = Math.round((rotX / 360) * height);
      
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
      console.error("[SceneManager] Failed to rotate HDRI texture:", error);
      return null;
    }
  }

  /**
   * Deep clone a DataTexture
   */
  private deepCloneDataTexture(source: THREE.DataTexture): THREE.DataTexture | null {
    if (!source.image || !source.image.data) return null;
    
    const sourceData = source.image.data;
    let newData: Float32Array | Uint8Array | Uint16Array;
    
    if (sourceData instanceof Float32Array) {
      newData = new Float32Array(sourceData);
    } else if (sourceData instanceof Uint16Array) {
      newData = new Uint16Array(sourceData);
    } else {
      newData = new Uint8Array(sourceData);
    }
    
    const clone = new THREE.DataTexture(
      newData,
      source.image.width,
      source.image.height,
      source.format as THREE.PixelFormat,
      source.type
    );
    clone.colorSpace = source.colorSpace;
    clone.needsUpdate = true;
    return clone;
  }

  /**
   * Update clearcoat on all body materials (works for both leather and smooth)
   */
  updateClearcoat(clearcoat: number) {
    console.log("[SceneManager] updateClearcoat:", clearcoat);
    this.currentLeatherConfig.clearcoat = clearcoat;
    this.updateModelMaterials();
  }

  /**
   * Update body roughness (for cue body)
   * For smooth products: applies to the outside mesh directly
   * For leather products: updates the roughnessMap's non-leather areas
   */
  updateBodyRoughness(roughness: number) {
    console.log(`[SceneManager #${this.instanceId}] updateBodyRoughness:`, roughness);
    this.bodyRoughness = roughness;

    // For leather products, regenerate the roughnessMap with new bodyRoughness
    if (this.isLeatherProduct && this.leatherRoughnessTexture) {
      const canvas = createLeatherRoughnessMap(
        TEXTURE_CANVAS_SIZE,
        TEXTURE_CANVAS_SIZE,
        this.currentLeatherConfig.roughness, // leather area roughness
        this.bodyRoughness // non-leather body area roughness
      );
      // Update the existing texture's image source
      this.leatherRoughnessTexture.image = canvas;
      this.leatherRoughnessTexture.needsUpdate = true;
      console.log(`[SceneManager #${this.instanceId}] Updated leatherRoughnessTexture with bodyRoughness:`, this.bodyRoughness);
    }

    this.updateModelMaterials();
  }

  /**
   * Update leather material config and re-apply to model
   */
  updateLeatherConfig(config: { roughness?: number; clearcoat?: number; sheen?: number; normalStrength?: number }) {
    console.log("[SceneManager] updateLeatherConfig:", config);
    const roughnessChanged = config.roughness !== undefined && config.roughness !== this.currentLeatherConfig.roughness;

    if (config.roughness !== undefined) this.currentLeatherConfig.roughness = config.roughness;
    if (config.clearcoat !== undefined) this.currentLeatherConfig.clearcoat = config.clearcoat;
    if (config.sheen !== undefined) this.currentLeatherConfig.sheen = config.sheen;
    if (config.normalStrength !== undefined) this.currentLeatherConfig.normalStrength = config.normalStrength;

    // If leather roughness changed, regenerate the roughnessMap
    if (roughnessChanged && this.isLeatherProduct && this.leatherRoughnessTexture) {
      const canvas = createLeatherRoughnessMap(
        TEXTURE_CANVAS_SIZE,
        TEXTURE_CANVAS_SIZE,
        this.currentLeatherConfig.roughness, // leather area roughness
        this.bodyRoughness // non-leather body area roughness
      );
      this.leatherRoughnessTexture.image = canvas;
      this.leatherRoughnessTexture.needsUpdate = true;
      console.log("[SceneManager] Updated leatherRoughnessTexture with leatherRoughness:", this.currentLeatherConfig.roughness);
    }

    // Update materials on the model
    this.updateModelMaterials();
  }

  /**
   * Get current leather config
   */
  getLeatherConfig() {
    return { ...this.currentLeatherConfig };
  }

  /**
   * Update cylinder (leather wrap) material config
   */
  updateCylinderConfig(config: { roughness?: number; clearcoat?: number; metalness?: number; color?: string; normalScale?: number; sheen?: number; sheenColor?: string }) {
    console.log("[SceneManager] updateCylinderConfig:", config);
    if (config.roughness !== undefined) this.currentCylinderConfig.roughness = config.roughness;
    if (config.clearcoat !== undefined) this.currentCylinderConfig.clearcoat = config.clearcoat;
    if (config.metalness !== undefined) this.currentCylinderConfig.metalness = config.metalness;
    if (config.color !== undefined) this.currentCylinderConfig.color = config.color;
    if (config.normalScale !== undefined) this.currentCylinderConfig.normalScale = config.normalScale;
    if (config.sheen !== undefined) this.currentCylinderConfig.sheen = config.sheen;
    if (config.sheenColor !== undefined) this.currentCylinderConfig.sheenColor = config.sheenColor;
    this.updateModelMaterials();
  }

  /**
   * Update joint top material config
   */
  updateJointConfig(config: { roughness?: number; clearcoat?: number; metalness?: number }) {
    console.log("[SceneManager] updateJointConfig:", config);
    if (config.roughness !== undefined) this.currentJointConfig.roughness = config.roughness;
    if (config.clearcoat !== undefined) this.currentJointConfig.clearcoat = config.clearcoat;
    if (config.metalness !== undefined) this.currentJointConfig.metalness = config.metalness;
    this.updateModelMaterials();
  }

  /**
   * Update materials on the model with current config
   * Cylinder leather: cylinderConfig controls roughness/clearcoat/metalness/color
   * Joint/Top cap: jointConfig controls roughness/clearcoat/metalness
   * Rubber: hardcoded bumperConfig + logo
   * Other meshes: bodyRoughness + clearcoat from leatherConfig
   */
  private forceSceneEnvironmentOnMaterials() {
    if (!this.model) return;

    this.model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((mat) => {
        if (mat instanceof THREE.MeshStandardMaterial) {
          // Null envMap forces Three.js to use scene.environment for PBR IBL
          if (mat.envMap !== null) {
            mat.envMap = null;
            mat.needsUpdate = true;
          }
        }
      });
    });
  }

  private updateModelMaterials() {
    if (!this.model) {
      console.log("[SceneManager] updateModelMaterials: No model loaded");
      return;
    }

    console.log(
      `[SceneManager #${this.instanceId}] updateModelMaterials - cylinder:`,
      this.currentCylinderConfig,
      "joint:",
      this.currentJointConfig,
      "bodyRoughness:",
      this.bodyRoughness
    );
    let updatedCount = 0;

    this.model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((mat, matIdx) => {
        if (!(mat instanceof THREE.MeshStandardMaterial)) return;

        const matName = mat.name?.toLowerCase() || "";
        const meshName = child.name?.toLowerCase() || "";

        const isCylinder = isCylinderLeatherMaterial(matName, meshName);
        const isTopCap = isTopCapMaterial(matName, meshName) || isTopCapFaceMaterial(matName);
        const isRubber = isRubberMaterial(matName, meshName);

        if (isCylinder) {
          // Cylinder: keep original GLB material
        } else if (isTopCap) {
          const physMat = ensurePhysicalMaterial(child, mat, matIdx);
          physMat.roughness = this.currentJointConfig.roughness / 255;
          physMat.clearcoat = this.currentJointConfig.clearcoat / 100;
          physMat.metalness = this.currentJointConfig.metalness;
          physMat.needsUpdate = true;
          updatedCount++;
        } else if (isRubber) {
          const physMat = ensurePhysicalMaterial(child, mat, matIdx);
          physMat.roughness = this.currentBumperConfig.roughness / 255;
          physMat.metalness = this.currentBumperConfig.metalness;
          physMat.color.set(this.currentBumperConfig.color);
          physMat.needsUpdate = true;
          updatedCount++;
        } else {
          const physMat = ensurePhysicalMaterial(child, mat, matIdx);
          physMat.roughness = this.bodyRoughness / 255;
          physMat.clearcoat = this.currentLeatherConfig.clearcoat / 100;
          physMat.needsUpdate = true;
          updatedCount++;
        }
      });
    });

    console.log(`[SceneManager] Updated ${updatedCount} materials`);
  }

  private setupTurntableModelRotation() {
    const el = this.renderer.domElement;
    // Prevent browser gestures (scroll/zoom) from fighting with pointer rotation.
    el.style.touchAction = "none";

    el.addEventListener("pointerdown", this.onTurntablePointerDown);
    el.addEventListener("pointermove", this.onTurntablePointerMove);
    el.addEventListener("pointerup", this.onTurntablePointerUp);
    el.addEventListener("pointercancel", this.onTurntablePointerUp);
    el.addEventListener("wheel", this.onTurntableWheel, { passive: false });
  }

  private teardownTurntableModelRotation() {
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onTurntablePointerDown);
    el.removeEventListener("pointermove", this.onTurntablePointerMove);
    el.removeEventListener("pointerup", this.onTurntablePointerUp);
    el.removeEventListener("pointercancel", this.onTurntablePointerUp);
    el.removeEventListener("wheel", this.onTurntableWheel);
    this.activePointers.clear();
    this.stopModelDrag();
  }

  private stopModelDrag() {
    if (!this.isDraggingModel) return;

    const pointerId = this.dragPointerId;
    this.isDraggingModel = false;
    this.dragPointerId = null;

    if (this.restoreAutoRotateAfterDrag !== null) {
      this.autoRotate = this.restoreAutoRotateAfterDrag;
      this.restoreAutoRotateAfterDrag = null;
    }

    if (pointerId !== null) {
      try {
        this.renderer.domElement.releasePointerCapture(pointerId);
      } catch {
        // no-op
      }
    }
  }

  private onTurntablePointerDown = (event: PointerEvent) => {
    if (this.isDisposed) return;

    // Stop any existing inertia when a new drag begins.
    this.spinVelocityY = 0;
    this.orbitVelocityPhi = 0;

    this.activePointers.add(event.pointerId);
    this.pointerPositions.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // Only start drag rotation on primary/left mouse button (or touch).
    if (event.pointerType !== "touch" && event.button !== 0) return;

    // Allow OrbitControls modifier gestures (e.g. shift/ctrl drag for pan)
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;

    // If the user is multi-touching (pinch/pan), don't rotate the model.
    if (this.activePointers.size !== 1) {
      this.stopModelDrag();
      return;
    }

    if (!this.model) return;

    this.isDraggingModel = true;
    this.dragPointerId = event.pointerId;
    this.dragLastX = event.clientX;
    this.dragLastY = event.clientY;

    // Pause auto-rotation while the user is dragging (restore on release).
    if (this.restoreAutoRotateAfterDrag === null) {
      this.restoreAutoRotateAfterDrag = this.autoRotate;
    }
    this.autoRotate = false;

    try {
      this.renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // no-op
    }
  };

  private onTurntablePointerMove = (event: PointerEvent) => {
    // Update stored position for this pointer (needed for pinch zoom).
    this.pointerPositions.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // Pinch zoom: two active touch pointers — apply zoom directly from distance delta.
    if (this.activePointers.size === 2 && event.pointerType === "touch") {
      const [id1, id2] = [...this.activePointers];
      const p1 = this.pointerPositions.get(id1);
      const p2 = this.pointerPositions.get(id2);
      if (p1 && p2) {
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (this.lastPinchDistance > 0) {
          const delta = this.lastPinchDistance - dist; // positive = fingers closer = zoom out
          this.applyCameraOrbitAndZoom(0, delta * this.pinchZoomSpeed);
          this.controls.update();
        }
        this.lastPinchDistance = dist;
      }
      return;
    }

    if (!this.isDraggingModel || this.dragPointerId !== event.pointerId) return;
    if (!this.model) return;
    if (this.activePointers.size !== 1) return;

    event.preventDefault();

    const dx = event.clientX - this.dragLastX;
    const dy = event.clientY - this.dragLastY;
    this.dragLastX = event.clientX;
    this.dragLastY = event.clientY;

    const deltaSpin = dx * this.modelDragRotateSpeed;
    const deltaPhi = -dy * this.cameraOrbitSpeed;

    // Apply drag deltas directly (responsive), but store smaller velocities for inertia after release.
    this.spinVelocityY = THREE.MathUtils.clamp(deltaSpin * this.inertiaGain, -this.maxSpinVelocityY, this.maxSpinVelocityY);
    this.orbitVelocityPhi = THREE.MathUtils.clamp(deltaPhi * this.inertiaGain, -this.maxOrbitVelocityPhi, this.maxOrbitVelocityPhi);

    // Keep the cue perfectly erect (no tilt/roll), but still allow spin.
    this.model.rotation.y += deltaSpin;
    this.model.rotation.x = 0;
    this.model.rotation.z = 0;

    // Vertical drag: orbit the CAMERA up/down around the cue.
    if (deltaPhi !== 0) {
      this.applyCameraOrbitAndZoom(deltaPhi);
      this.controls.update();
    }
  };

  private onTurntablePointerUp = (event: PointerEvent) => {
    this.activePointers.delete(event.pointerId);
    this.pointerPositions.delete(event.pointerId);
    if (this.activePointers.size < 2) this.lastPinchDistance = 0;

    if (this.dragPointerId === event.pointerId) {
      this.stopModelDrag();
    }
  };

  private onTurntableWheel = (event: WheelEvent) => {
    if (this.isDisposed) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    let dy = event.deltaY;
    if (event.deltaMode === 1) dy *= 16;
    if (event.deltaMode === 2) dy *= 100;

    this.applyCameraOrbitAndZoom(0, dy * this.wheelZoomSpeed);
    this.controls.update();
  };

  private applyCameraOrbitAndZoom(deltaPhi: number, deltaRadius: number = 0) {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const spherical = new THREE.Spherical().setFromVector3(offset);

    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi + deltaPhi,
      this.cameraMinPolarAngle,
      this.cameraMaxPolarAngle
    );

    const maxRadius = this.maxZoomOutRadius ?? this.controls.maxDistance;
    spherical.radius = THREE.MathUtils.clamp(
      spherical.radius + deltaRadius,
      this.controls.minDistance,
      maxRadius
    );

    offset.setFromSpherical(spherical);
    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
  }

  private adjustCameraFOV(deltaFOV: number) {
    this.camera.fov = THREE.MathUtils.clamp(
      this.camera.fov + deltaFOV,
      this.minFOV,
      this.maxFOV
    );
    this.camera.updateProjectionMatrix();
  }

  private handleResize = () => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private animate = (time: number = performance.now()) => {
    this.animationId = requestAnimationFrame(this.animate);

    // Frame-rate independent damping
    const dtMs = this.lastFrameTime ? Math.min(64, time - this.lastFrameTime) : 16.67;
    this.lastFrameTime = time;
    const damping = Math.pow(this.inertiaDamping, dtMs / (1000 / 60));

    // Auto-rotate model on Y axis
    if (this.autoRotate && this.model) {
      this.model.rotation.y += this.autoRotateSpeed;
    }

    // Inertia: continue motion after drag and slow down gradually.
    if (this.model && !this.isDraggingModel && this.spinVelocityY !== 0) {
      this.model.rotation.y += this.spinVelocityY;
    }

    const phiDelta = !this.isDraggingModel ? this.orbitVelocityPhi : 0;
    if (phiDelta !== 0) {
      this.applyCameraOrbitAndZoom(phiDelta);
    }

    // Decay velocities
    if (!this.isDraggingModel) {
      this.spinVelocityY *= damping;
      this.orbitVelocityPhi *= damping;
    }

    // Snap to zero to avoid tiny perpetual drift
    if (Math.abs(this.spinVelocityY) < 1e-5) this.spinVelocityY = 0;
    if (Math.abs(this.orbitVelocityPhi) < 1e-5) this.orbitVelocityPhi = 0;

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Toggle auto-rotation on/off
   */
  toggleAutoRotate(): boolean {
    this.autoRotate = !this.autoRotate;
    return this.autoRotate;
  }

  /**
   * Get current auto-rotate state
   */
  isAutoRotating(): boolean {
    return this.autoRotate;
  }

  /**
   * Set auto-rotate speed (radians per frame)
   */
  setAutoRotateSpeed(speed: number) {
    this.autoRotateSpeed = speed;
  }

  /**
   * Pause the render/animation loop (e.g. during GPU-intensive export).
   * Call resumeAnimation() to restart.
   */
  pauseAnimation(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Resume the render/animation loop after a pause.
   */
  resumeAnimation(): void {
    if (!this.isDisposed && this.animationId === null) {
      // Restore material state in case an extractor mutated shared materials
      this.forceSceneEnvironmentOnMaterials();
      this.animate();
    }
  }

  async loadModel(modelPath: string): Promise<THREE.Group> {
    // Memory guard: warn early on severely constrained devices.
    // navigator.deviceMemory is available in Chromium-based browsers (not Safari).
    const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (deviceMemoryGB !== undefined && deviceMemoryGB < 2) {
      console.warn(
        `[SceneManager] Low device memory detected (${deviceMemoryGB} GB). ` +
          "Loading a large model may cause instability on this device."
      );
    }

    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();

      // Wire KTX2 loader so GLB textures in KTX2/Basis format are GPU-decompressed natively.
      if (this.ktx2Loader) {
        loader.setKTX2Loader(this.ktx2Loader);
      }

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

          const gltfScene = gltf.scene;

          // Force FrontSide rendering on all meshes to hide the hollow interior
          gltfScene.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              mats.forEach((mat) => {
                if (mat instanceof THREE.Material) {
                  mat.side = THREE.FrontSide;
                  mat.needsUpdate = true;
                }
              });
              console.log(`[SceneManager] GLB mesh: "${child.name}" type: ${child.type} materials: [${mats.map((m) => m.name || "(unnamed)").join(", ")}]`);
            }
          });

          // Scale GLB content
          const box = new THREE.Box3().setFromObject(gltfScene);
          const size = box.getSize(new THREE.Vector3());
          const scale = 2.0 / Math.max(size.x, size.y, size.z);
          gltfScene.scale.setScalar(scale);

          // Create a centered pivot root so rotations happen around the cue center
          const pivot = new THREE.Group();
          pivot.rotation.order = "YXZ";
          pivot.rotation.x = 0;
          pivot.rotation.z = 0;
          pivot.add(gltfScene);

          const centerBox = new THREE.Box3().setFromObject(gltfScene);
          const centerPoint = centerBox.getCenter(new THREE.Vector3());
          gltfScene.position.set(-centerPoint.x, -centerPoint.y, -centerPoint.z);

          this.model = pivot;
          this.scene.add(this.model);

          // Ensure HDRI lighting is driven by scene.environment (not any baked GLB envMap)
          this.forceSceneEnvironmentOnMaterials();

          // Update camera position
          this.camera.position.set(2, 0, 2);
          this.controls.target.set(0, 0, 0);
          this.controls.update();

          // Cap zoom-out at the initial loaded view distance.
          this.maxZoomOutRadius = this.camera.position.distanceTo(this.controls.target);

          console.log("[SceneManager] Model loaded successfully");
          resolve(this.model);
        },
        (progressEvent) => {
          if (progressEvent.lengthComputable) {
            const pct = Math.round((progressEvent.loaded / progressEvent.total) * 100);
            console.log(`[SceneManager] Model loading: ${pct}% (${(progressEvent.loaded / 1024 / 1024).toFixed(1)} MB)`);
          }
        },
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          const isOom =
            message.toLowerCase().includes("out of memory") ||
            message.toLowerCase().includes("webgl") ||
            message.toLowerCase().includes("context lost");

          if (isOom) {
            console.error(
              "[SceneManager] GPU/memory error while loading model. " +
                "Consider using KTX2-compressed textures to reduce VRAM usage.",
              error
            );
            reject(new Error("GPU_OUT_OF_MEMORY: The 3D model could not be loaded due to insufficient GPU memory. Try closing other browser tabs or apps."));
          } else {
            console.error("[SceneManager] Failed to load model:", modelPath, error);
            reject(error);
          }
        }
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

    const { surfaceUrl, productType, leatherColor, leatherTexture, textureScale } = options;

    // Track product type and texture scale for material updates
    this.isLeatherProduct = productType === "leather";
    this.textureScale = textureScale || 1;

    // Clear old textures
    this.disposeTextures();

    // Load assets in parallel for better performance
    const baseSurfaceUrl = surfaceUrl || "/textures/defaults/surface-leather-default.jpg";

    let surfaceImage: HTMLImageElement;

    if (productType === "leather") {
      // v2 model: leather region is a separate cylinder mesh stacked above "outside"
      // Load raw surface for body mesh — no color overlay needed
      const [, , loadedImage] = await Promise.all([loadAllLogos(), loadLeatherNormal(leatherTexture || "crocodile"), this.loadImage(baseSurfaceUrl)]);
      surfaceImage = loadedImage;
    } else {
      // Smooth product: load logos and surface image in parallel
      const [, loadedImage] = await Promise.all([loadAllLogos(), this.loadImage(baseSurfaceUrl)]);
      surfaceImage = loadedImage;
    }

    console.log("[SceneManager] Surface loaded:", surfaceImage.width, "x", surfaceImage.height);

    // Create canvas texture
    const canvas = document.createElement("canvas");
    canvas.width = TEXTURE_CANVAS_SIZE;
    canvas.height = TEXTURE_CANVAS_SIZE;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(surfaceImage, 0, 0, TEXTURE_CANVAS_SIZE, TEXTURE_CANVAS_SIZE);

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
      textureMaps = createLeatherTextureMaps(TEXTURE_CANVAS_SIZE, TEXTURE_CANVAS_SIZE, this.bodyRoughness, this.textureScale);
      this.createdTextures.push(textureMaps.roughnessTexture, textureMaps.clearcoatTexture, textureMaps.normalTexture);
      // Store reference for dynamic updates
      this.leatherRoughnessTexture = textureMaps.roughnessTexture;
      console.log(`[SceneManager] Created leather textures with scale: ${this.textureScale}x`);
    } else {
      this.leatherRoughnessTexture = null;
    }

    // Apply to model meshes
    console.log("[SceneManager] Traversing model meshes...");
    this.model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      const meshName = child.name || "";
      const materials = Array.isArray(child.material) ? child.material : [child.material];

      console.log(`[SceneManager] Found mesh: "${meshName}" with ${materials.length} material(s)`);

      materials.forEach((mat, idx) => {
        const matName = mat?.name || "";

        console.log(`[SceneManager]   Material[${idx}]: "${matName}" type: ${mat?.type}`);
        console.log(
          `[SceneManager]   isCylinder: ${isCylinderLeatherMaterial(matName, meshName)}, isTopCapFace: ${isTopCapFaceMaterial(matName)}, isTopCap: ${isTopCapMaterial(
            matName,
            meshName
          )}, isRubber: ${isRubberMaterial(matName, meshName)}`
        );

        // Skip non-standard materials
        if (!(mat instanceof THREE.MeshStandardMaterial)) {
          console.log("[SceneManager]   ⏭️ Not a MeshStandardMaterial, skipping");
          return;
        }

        // Check material type: top cap face first (most specific), then top cap body, then cylinder, then rubber
        if (isTopCapFaceMaterial(matName)) {
          applyLogoToExistingMaterial(mat, "topCapFace");
          const physMat = ensurePhysicalMaterial(child, mat, idx);
          physMat.roughness = this.currentJointConfig.roughness / 255;
          physMat.clearcoat = this.currentJointConfig.clearcoat / 100;
          physMat.metalness = this.currentJointConfig.metalness;
          physMat.needsUpdate = true;
          console.log("[SceneManager] ✅ Applied TOP CAP FACE logo + joint config to:", matName);
          return;
        } else if (isTopCapMaterial(matName, meshName)) {
          applyLogoToExistingMaterial(mat, "topCapFace");
          const physMat = ensurePhysicalMaterial(child, mat, idx);
          physMat.roughness = this.currentJointConfig.roughness / 255;
          physMat.clearcoat = this.currentJointConfig.clearcoat / 100;
          physMat.metalness = this.currentJointConfig.metalness;
          physMat.needsUpdate = true;
          console.log("[SceneManager] ✅ Applied TOP CAP logo + joint config to:", matName || meshName);
          return;
        } else if (isCylinderLeatherMaterial(matName, meshName)) {
          console.log("[SceneManager] ⏭️ Skipping cylinder (using original GLB material):", matName || meshName);
          return;
        } else if (isRubberMaterial(matName, meshName)) {
          const physMat = ensurePhysicalMaterial(child, mat, idx);
          physMat.roughness = this.currentBumperConfig.roughness / 255;
          physMat.metalness = this.currentBumperConfig.metalness;
          physMat.color.set(this.currentBumperConfig.color);
          applyRubberLogoEmissive(physMat);
          physMat.needsUpdate = true;
          console.log("[SceneManager] ✅ Applied RUBBER emissive logo + bumper config to:", matName || meshName);
          return;
        } else {
          const physMat = ensurePhysicalMaterial(child, mat, idx);
          physMat.map = mapTexture;
          if (textureMaps) {
            physMat.normalMap = textureMaps.normalTexture;
            physMat.normalScale = new THREE.Vector2(LEATHER_CONFIG.normalScaleX, LEATHER_CONFIG.normalScaleY);
            physMat.roughnessMap = textureMaps.roughnessTexture;
            physMat.clearcoatMap = textureMaps.clearcoatTexture;
          }
          physMat.roughness = this.bodyRoughness / 255;
          physMat.clearcoat = this.currentLeatherConfig.clearcoat / 100;
          physMat.needsUpdate = true;
          console.log("[SceneManager] ✅ Applied surface texture + body config to:", matName || meshName);
          return;
        }
      });
    });

    // Apply current leather config to newly created materials
    this.updateModelMaterials();

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
    this.scene.background = new THREE.Color(this.isDarkBg ? this.settings.background.dark : this.settings.background.light);
    return this.isDarkBg;
  }

  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    // Invalidate any in-flight HDRI loads so their callbacks become no-ops.
    this.hdriLoadSeq++;

    console.log(`[SceneManager #${this.instanceId}] dispose() called`);
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }

    window.removeEventListener("resize", this.handleResize);
    this.teardownTurntableModelRotation();

    // Remove WebGL context loss listeners
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.handleContextRestored);

    // Dispose KTX2 transcoder
    if (this.ktx2Loader) {
      this.ktx2Loader.dispose();
      this.ktx2Loader = null;
    }

    // Dispose HDRI environment map
    if (this.cachedHdriTexture) {
      this.cachedHdriTexture.dispose();
      this.cachedHdriTexture = null;
    }
    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
      this.envRenderTarget = null;
    }
    if (this.pmremGenerator) {
      this.pmremGenerator.dispose();
      this.pmremGenerator = null;
    }

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
    // Only remove if still a child (might already be removed by React)
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }

    // Dispose controls
    this.controls.dispose();
  }

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
      bumperConfig: { ...this.currentBumperConfig },
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
}
