import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
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

// Canvas size for texture maps
const TEXTURE_CANVAS_SIZE = 4096;

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
  private currentHdriUrl = "/hdri/bloem_train_track_clear_2k.hdr";
  private hdriLoadSeq = 0;
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
  private bodyRoughness = 0; // For smooth cue body (default: 0)
  private textureScale = 1; // Texture tiling scale (1 = no tiling)
  private isLeatherProduct = false; // Track product type
  private leatherRoughnessTexture: THREE.CanvasTexture | null = null; // For dynamic roughness map updates
  private autoRotate = true; // Auto-rotate model on Y axis
  private autoRotateSpeed = 0.003; // Slow rotation speed (radians per frame)

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
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    // HDRI preprocessing for correct image-based lighting
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

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

    // Lock pan to Y-axis only (for vertical movement along cue)
    this.controls.addEventListener("change", () => {
      this.controls.target.x = 0;
      this.controls.target.z = 0;
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

  /**
   * Update HDRI exposure (tone mapping exposure)
   */
  updateHdriExposure(exposure: number) {
    console.log("[SceneManager] updateHdriExposure:", exposure);
    this.renderer.toneMappingExposure = exposure;
  }

  /**
   * Update HDRI environment map.
   * Accepts either a full URL ("/hdri/foo.hdr") or a filename ("foo.hdr").
   */
  updateHdriEnvironment(hdriTypeOrUrl: string) {
    const url = hdriTypeOrUrl.startsWith("/") ? hdriTypeOrUrl : `/hdri/${encodeURIComponent(hdriTypeOrUrl)}`;
    this.currentHdriUrl = url;

    if (!this.pmremGenerator) return;

    const loadSeq = ++this.hdriLoadSeq;
    const rgbeLoader = new RGBELoader();
    rgbeLoader.load(
      url,
      (texture) => {
        // If a newer request started, ignore this result.
        if (loadSeq !== this.hdriLoadSeq) {
          texture.dispose();
          return;
        }

        texture.mapping = THREE.EquirectangularReflectionMapping;

        const rt = this.pmremGenerator!.fromEquirectangular(texture);
        texture.dispose();

        if (this.envRenderTarget) {
          this.envRenderTarget.dispose();
        }
        this.envRenderTarget = rt;

        this.scene.environment = rt.texture;
        // Keep solid background color (don't set scene.background to HDRI)

        // Make sure any GLB-provided envMap doesn't override scene.environment
        this.forceSceneEnvironmentOnMaterials();
      },
      undefined,
      (error) => {
        console.error("[SceneManager] Failed to load HDRI:", url, error);
      }
    );
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
   * Rubber: keeps original GLB material
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
          // Rubber: keep original GLB material
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

  private handleResize = () => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private animate = () => {
    this.animationId = requestAnimationFrame(this.animate);

    // Auto-rotate model on Y axis
    if (this.autoRotate && this.model) {
      this.model.rotation.y += this.autoRotateSpeed;
    }

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

          // Force FrontSide rendering on all meshes to hide the hollow interior
          this.model.traverse((child) => {
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

          // Ensure HDRI lighting is driven by scene.environment (not any baked GLB envMap)
          this.forceSceneEnvironmentOnMaterials();

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
          const physMat = ensurePhysicalMaterial(child, mat, idx);
          physMat.roughness = this.currentJointConfig.roughness / 255;
          physMat.clearcoat = this.currentJointConfig.clearcoat / 100;
          physMat.metalness = this.currentJointConfig.metalness;
          physMat.needsUpdate = true;
          console.log("[SceneManager] ✅ Applied joint config to TOP CAP BODY:", matName || meshName);
          return;
        } else if (isCylinderLeatherMaterial(matName, meshName)) {
          console.log("[SceneManager] ⏭️ Skipping cylinder (using original GLB material):", matName || meshName);
          return;
        } else if (isRubberMaterial(matName, meshName)) {
          applyLogoToExistingMaterial(mat, "rubber");
          console.log("[SceneManager] ✅ Applied RUBBER logo to:", matName || meshName);
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
    console.log(`[SceneManager #${this.instanceId}] dispose() called`);
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }

    window.removeEventListener("resize", this.handleResize);

    // Dispose HDRI environment map
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
}
