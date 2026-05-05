import * as THREE from 'three';
import fixWebmDuration from 'fix-webm-duration';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type {
  ImageExtractorConfig,
  VideoExtractorConfig,
  PartViewConfig,
  HdriLayer,
  VideoBackgroundLayer,
} from '@/types/extractor';
import { STUDIO_WHITE_HDRI } from '@/types/extractor';
import {
  createVelvetTableTexture,
  createCementWallTexture,
  createWallBackdrop,
  createShadowFloor,
  createWallShadowPlane,
  createLShapedShadowMesh,
  createCornerFillMesh,
  createTableSurface,
  createFabricTexture,
  createStudioBackdrop,
  loadTextureManifest,
  findTexturePack,
  loadPBRTexturePack,
} from './studio-background';
import type { VideoStudioConfig, CameraKeyframe, CueConfig, CueInstance, BackgroundFrame, SurfaceConfig, CueHdriConfig } from '@/types/video-studio';
import { computeVideoDuration, createEasingFunction, applyDirection, VIDEO_QUALITY_PRESETS, GRADIENT_PRESETS, DEFAULT_CUE_HDRI, getRecordingDimensions } from '@/types/video-studio';
import { compositeSurfaceFrames, preloadFrameImages } from './background-compositor';
import { applyBumperEmissiveShaderMask, applyLogoToExistingMaterial } from './leather-material';
import { isRubberMaterial, isTopCapMaterial, isTopCapFaceMaterial, isCylinderLeatherMaterial } from './leather-config';
import { createWhiteImmuneMaterial } from './studio-helpers';

// Available HDRI options (same as editor-client)
export const HDRI_OPTIONS_FALLBACK = [
  { id: "__studio_white__", label: "Studio White" },
  { id: "bloem_train_track_clear_2k.hdr", label: "Bloem Train Track Clear 2k" },
  { id: "church_museum_2k.hdr", label: "Church Museum 2k" },
  { id: "church_stairway_2k.hdr", label: "Church Stairway 2k" },
  { id: "ferndale_studio_07_2k.hdr", label: "Ferndale Studio 07 2k" },
];

/**
 * Detect best supported video format for MediaRecorder.
 * WebM is the most reliable container for streaming MediaRecorder output across browsers.
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
  /** Solid white env map for wall/table surfaces — prevents HDRI reflections */
  private surfaceEnvRT: THREE.WebGLRenderTarget | null = null;
  private _surfaceEnvColor: string = '#ffffff';
  /** Cue-only HDRI env map (separate from studio surfaces) */
  private cueEnvRT: THREE.WebGLRenderTarget | null = null;
  private cueEnvIntensity: number = 1.0;
  private lastCueHdriKey: string = '';
  private lastCueHdriLayersKey: string = '';
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
  private queuedHdriLayers: HdriLayer[] | null = null; // Queue latest request while pending
  private queuedHdriApplyCue: boolean = false; // Propagate applyCueEnv option through queue
  private hdriLayersActive: boolean = false; // true when setHdriLayers manages cue env
  private _lastHdriRotKey: string = '';

  // Studio elements (for video)
  private backdrop: THREE.Mesh | null = null;
  private shadowFloor: THREE.Mesh | null = null;
  private shadowFloorBaseY = 0;
  // Stored shadow offsets re-applied whenever lights are rebuilt
  private _shadowOffsetX = 0;
  private _shadowOffsetZ = 0;
  // Cue centroid in world X/Z — shadow lights track this so shadows follow the cue
  private _cueCenterX = 0;
  private _cueCenterZ = 0;
  private wallShadowPlane: THREE.Mesh | null = null;
  private tableSurface: THREE.Mesh | null = null;
  // Curved corner fill — backs the shadow mesh's curved section so shadows look natural
  private studioCornerFill: THREE.Mesh | null = null;

  // HDRI-driven shadow lights (one DirectionalLight per HDRI layer)
  private hdriShadowLights: Array<{
    layerId: string;
    light: THREE.DirectionalLight;
  }> = [];

  // Per-frame directional light for image extractor
  private directionalLight: THREE.DirectionalLight | null = null;

  // Studio shadow for CueFrame (image extractor) — independent from video-studio lights
  private frameShadowLight: THREE.DirectionalLight | null = null;
  private frameShadowFloor: THREE.Mesh | null = null;
  private frameShadowBaseY = 0;
  // Wall and table backdrops shown when shadow is enabled (matches Video Studio layout)
  private frameWallBackdrop: THREE.Mesh | null = null;
  private frameTableBackdrop: THREE.Mesh | null = null;

  // Frame shadow studio dimensions — SAME AS VIDEO STUDIO for consistency
  // Video studio: wall at (0, 10, -5.5), 34×24; table at y=-2, depth=12
  private static readonly FRAME_WALL_WIDTH = 34;
  private static readonly FRAME_WALL_HEIGHT = 24;
  private static readonly FRAME_WALL_Y = 10;
  private static readonly FRAME_WALL_Z = -5.5;
  private static readonly FRAME_TABLE_Y = -2;
  private static readonly FRAME_TABLE_DEPTH = 12;
  private static readonly FRAME_SHADOW_FRUSTUM = 20;

  // Track last loaded HDRI file for change detection
  private lastLoadedHdriFile: string = '';

  // HDRI light helpers — interactive sun spheres on a sky dome
  private static readonly HDRI_DOME_RADIUS = 10;
  private hdriLightHelpers: Array<{
    layerId: string;
    layerIndex: number;
    helper: THREE.Group;
  }> = [];

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

  // Simulator mode: per-cue individual groups instead of InstancedMesh
  private simulatorMode = false;
  private simulatorCueGroups: THREE.Group[] = [];
  // Per-instance surface texture overrides (disposed with the group)
  private cueGroupSurfaceTextures: Map<number, THREE.Texture> = new Map();

  // Scene view (god camera)
  private godCamera: THREE.PerspectiveCamera | null = null;
  private cameraHelper: THREE.CameraHelper | null = null;
  private isSceneView: boolean = false;

  // Camera gizmo for scene view selection
  private cameraGizmo: THREE.Group | null = null;

  // Minimap: render camera view to a separate canvas at low frequency
  private _minimapCanvas: HTMLCanvasElement | null = null;
  private _minimapTarget: THREE.WebGLRenderTarget | null = null;
  private _minimapBuf: Uint8Array | null = null;
  private _minimapFrameCount = 0;
  private static readonly MINIMAP_W = 576;
  private static readonly MINIMAP_H = 324;
  private static readonly MINIMAP_INTERVAL = 6; // render every Nth frame (~10fps)

  // Preview: render production camera view to a square canvas (used by shadow simulator)
  private _previewCanvas: HTMLCanvasElement | null = null;
  private _previewTarget: THREE.WebGLRenderTarget | null = null;
  private _previewBuf: Uint8Array | null = null;
  private _previewSize = 512;
  private _previewFrameCount = 0;
  private static readonly PREVIEW_INTERVAL = 10; // every 10th frame (~6fps) to reduce readback cost

  // Frame plane meshes (for interactive scene view)
  private wallFramePlanes: THREE.Mesh[] = [];
  private tableFramePlanes: THREE.Mesh[] = [];

  // Smooth camera interpolation
  private cameraTargetPos = new THREE.Vector3();
  private cameraSmoothEnabled = false;

  // Reusable Object3D for instanced mesh matrix updates — avoids per-frame GC allocations.
  private _spinDummy = new THREE.Object3D();

  // Animation state
  private animationFrameId: number | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private _spinPaused = false;
  private _isHelperDragging = false;
  /** When true, updateStudioPreviewConfig skips setCameraFromKeyframe so camera orbit controls can take effect */
  private _cameraPlacementMode = false;
  private _cameraOrbit: OrbitControls | null = null;
  /** Timer used to delay clearing _cameraPlacementMode past the config-sync debounce to prevent camera jumps */
  private _placementModeExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Shadow map type saved before recording; restored in onstop. */
  private _recordingSavedShadowType: THREE.ShadowMapType | null = null;

  constructor(
    private width: number = 2048,
    private height: number = 2048
  ) {
    // Create offscreen renderer with preserveDrawingBuffer for canvas capture
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2
    ));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACESFilmic tone mapping with moderate exposure boost compensates for
    // the front-view camera angle producing dimmer specular reflections
    // compared to the main scene's angled view.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.5;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a1a);

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    this.camera.position.set(2, 0, 2);

    // Subtle fill light matching main scene's PointLight
    const fillLight = new THREE.PointLight(0xffffff, 0.5, 10);
    fillLight.position.set(0, -3, 1);
    this.scene.add(fillLight);

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();
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

    // HDRI-driven shadow light based on HDRI rotation direction
    if (config.enableShadow) {
      const rotY = config.hdriRotationY ?? 0;
      const pos = this.hdriRotationToPosition(0, rotY);
      const light = new THREE.DirectionalLight(0xffffff, 0.8);
      light.position.copy(pos);
      light.target.position.set(0, 0, 0);
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = 50;
      light.shadow.camera.left = -20;
      light.shadow.camera.right = 20;
      light.shadow.camera.top = 20;
      light.shadow.camera.bottom = -20;
      light.shadow.bias = -0.0005;
      light.shadow.radius = config.shadowBlur;
      this.scene.add(light);
      this.scene.add(light.target);
      this.hdriShadowLights.push({ layerId: 'legacy', light });
    }

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
    this.clearHdriShadowLights();
    this.clearHdriLightHelpers();
    // Reset HDRI layers dedup key so next setup always applies
    this.lastHdriLayersKey = '';
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
      this.shadowFloorBaseY = 0;
    }
    if (this.wallShadowPlane) {
      this.scene.remove(this.wallShadowPlane);
      (this.wallShadowPlane.material as THREE.Material).dispose();
      this.wallShadowPlane.geometry.dispose();
      this.wallShadowPlane = null;
    }
    if (this.tableSurface) {
      this.scene.remove(this.tableSurface);
      const mat = this.tableSurface.material as THREE.MeshStandardMaterial;
      if (mat.map) mat.map.dispose();
      mat.dispose();
      this.tableSurface.geometry.dispose();
      this.tableSurface = null;
    }
    if (this.studioCornerFill) {
      this.scene.remove(this.studioCornerFill);
      (this.studioCornerFill.material as THREE.Material).dispose();
      this.studioCornerFill.geometry.dispose();
      this.studioCornerFill = null;
    }
    for (const mesh of this.backgroundLayerMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.backgroundLayerMeshes = [];
  }

  // ---------------------------------------------------------------------------
  // HDRI-driven shadow lights (DirectionalLight per HDRI layer)
  // ---------------------------------------------------------------------------

  private clearHdriShadowLights(): void {
    for (const entry of this.hdriShadowLights) {
      this.scene.remove(entry.light);
      if (entry.light.target.parent) {
        this.scene.remove(entry.light.target);
      }
      entry.light.dispose();
    }
    this.hdriShadowLights = [];
  }

  /** Create a DirectionalLight for each enabled HDRI layer, positioned by its rotation.
   *  These provide directional illumination (the HDRI is ambient-only now). */
  private setupHdriShadowLights(config: VideoStudioConfig): void {
    this.clearHdriShadowLights();

    const shadow = config.shadow;
    const layers = config.hdriConfig?.layers ?? [];
    for (const layer of layers) {
      if (layer.enabled === false) continue;

      const pos = this.hdriRotationToPosition(layer.rotationX, layer.rotationY);

      const baseIntensity = (layer.intensity ?? 1) * 1.2;
      const lightColor = new THREE.Color(layer.lightColor ?? '#ffffff');
      const light = new THREE.DirectionalLight(lightColor, baseIntensity);
      light.userData = { baseIntensity };
      light.position.copy(pos);
      light.target.position.set(0, 0, 0);
      light.castShadow = shadow.enabled;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = 50;
      light.shadow.camera.left = -20;
      light.shadow.camera.right = 20;
      light.shadow.camera.top = 20;
      light.shadow.camera.bottom = -20;
      light.shadow.bias = -0.0001;
      light.shadow.normalBias = 0.02;
      light.shadow.radius = Math.max(layer.shadowBlur ?? shadow.blur ?? 3, 4);
      light.shadow.blurSamples = 20;
      light.shadow.intensity = layer.shadowIntensity ?? 1.0;

      this.scene.add(light);
      this.scene.add(light.target);
      this.hdriShadowLights.push({ layerId: layer.id, light });
    }
    // Re-apply stored offset so lights point at the correct shadow target after rebuild
    this._applyShadowLightOffset(this._shadowOffsetX, this._shadowOffsetZ);
  }

  /** Update HDRI shadow light positions/properties without full rebuild */
  private updateHdriShadowLights(config: VideoStudioConfig): void {
    const shadow = config.shadow;
    const layers = (config.hdriConfig?.layers ?? []).filter(l => l.enabled !== false);

    if (layers.length !== this.hdriShadowLights.length) {
      this.setupHdriShadowLights(config);
      return;
    }

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const entry = this.hdriShadowLights[i];
      if (!entry) continue;

      const pos = this.hdriRotationToPosition(layer.rotationX, layer.rotationY);
      entry.light.position.copy(pos);
      const baseIntensity = (layer.intensity ?? 1) * 1.2;
      entry.light.intensity = baseIntensity;
      entry.light.color.set(layer.lightColor ?? '#ffffff');
      entry.light.userData = { baseIntensity };
      entry.light.castShadow = shadow.enabled;
      entry.light.shadow.radius = Math.max(layer.shadowBlur ?? shadow.blur ?? 3, 4);
      entry.light.shadow.blurSamples = 20;
      entry.light.shadow.intensity = layer.shadowIntensity ?? 1.0;
    }

    if (this.shadowFloor) {
      (this.shadowFloor.material as THREE.ShadowMaterial).opacity = shadow.intensity;
    }
  }

  /** Shift all HDRI shadow light targets to (offsetX, 0, offsetZ) so the shadow spot moves in X/Z. */
  private _applyShadowLightOffset(offsetX: number, offsetZ: number): void {
    for (const entry of this.hdriShadowLights) {
      entry.light.target.position.set(this._cueCenterX + offsetX, 0, this._cueCenterZ + offsetZ);
      entry.light.target.updateMatrixWorld();
      entry.light.shadow.needsUpdate = true;
    }
  }

  /** Recompute cue centroid X/Z from instances and re-aim shadow lights. */
  private _updateCueCenterForShadow(instances: { positionX: number; positionZ: number }[]): void {
    if (instances.length === 0) return;
    let sumX = 0, sumZ = 0;
    for (const inst of instances) { sumX += inst.positionX; sumZ += inst.positionZ; }
    this._cueCenterX = sumX / instances.length;
    this._cueCenterZ = sumZ / instances.length;
    this._applyShadowLightOffset(this._shadowOffsetX, this._shadowOffsetZ);
  }

  /** Show or hide backdrop wall, table surface and their frame planes (for transparent capture). */
  setWallsVisible(visible: boolean): void {
    if (this.backdrop) this.backdrop.visible = visible;
    if (this.tableSurface) this.tableSurface.visible = visible;
    if (this.studioCornerFill) this.studioCornerFill.visible = visible;
    for (const p of this.wallFramePlanes) p.visible = visible;
    for (const p of this.tableFramePlanes) p.visible = visible;
  }

  /**
   * Force the preview canvas to update on the very next render() call.
   * Call after changing shadow or wall visibility so the live preview reflects
   * the change immediately instead of waiting for the next preview interval.
   */
  forcePreviewUpdate(): void {
    this._previewFrameCount = ExtractorSceneManager.PREVIEW_INTERVAL;
  }

  /** Get HDRI light helper objects for raycasting */
  getStudioLightHelpers(): THREE.Group[] {
    return this.hdriLightHelpers.map(e => e.helper);
  }

  /** Show or hide all editor helpers (HDRI sun spheres, camera helper, camera gizmo) */
  private setHelpersVisible(visible: boolean): void {
    for (const entry of this.hdriLightHelpers) {
      entry.helper.visible = visible;
    }
    if (this.cameraHelper) this.cameraHelper.visible = visible;
    if (this.cameraGizmo) this.cameraGizmo.visible = visible;
  }

  // ---------------------------------------------------------------------------
  // HDRI Light helpers — interactive sun spheres on a virtual sky dome
  // ---------------------------------------------------------------------------

  private clearHdriLightHelpers(): void {
    for (const entry of this.hdriLightHelpers) {
      this.scene.remove(entry.helper);
      entry.helper.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
        if (child instanceof THREE.Sprite) {
          (child.material as THREE.SpriteMaterial).map?.dispose();
          (child.material as THREE.SpriteMaterial).dispose();
        }
      });
    }
    this.hdriLightHelpers = [];
  }

  /** Convert HDRI rotationX/rotationY (degrees) → 3D position on sky dome */
  private hdriRotationToPosition(rotX: number, rotY: number): THREE.Vector3 {
    const R = ExtractorSceneManager.HDRI_DOME_RADIUS;
    const phi = THREE.MathUtils.degToRad(90 - rotX);   // elevation: 0°→horizon, 90°→zenith
    const theta = THREE.MathUtils.degToRad(rotY);       // azimuth
    return new THREE.Vector3(
      R * Math.sin(phi) * Math.sin(theta),
      R * Math.cos(phi),
      R * Math.sin(phi) * Math.cos(theta)
    );
  }

  /** Convert 3D position → HDRI rotationX/rotationY (degrees) */
  positionToHdriRotation(pos: THREE.Vector3): { rotationX: number; rotationY: number } {
    const r = pos.length();
    const n = r > 0.001 ? pos.clone().divideScalar(r) : new THREE.Vector3(0, 1, 0);
    const phi = Math.acos(THREE.MathUtils.clamp(n.y, -1, 1));
    const theta = Math.atan2(n.x, n.z);
    let rotX = 90 - THREE.MathUtils.radToDeg(phi);
    let rotY = THREE.MathUtils.radToDeg(theta);
    if (rotY < 0) rotY += 360;
    rotX = THREE.MathUtils.clamp(rotX, -90, 90);
    return { rotationX: rotX, rotationY: rotY % 360 };
  }

  /**
   * Immediately move a shadow-casting DirectionalLight to a new HDRI position.
   * Called on every drag event so the shadow responds in real-time without
   * waiting for the 80 ms debounced config update.
   */
  directUpdateShadowLight(layerIndex: number, rotationX: number, rotationY: number, intensity?: number): void {
    const entry = this.hdriShadowLights[layerIndex];
    if (!entry) return;
    const pos = this.hdriRotationToPosition(rotationX, rotationY);
    entry.light.position.copy(pos);
    if (intensity !== undefined) {
      // Same multiplier used in setupHdriShadowLights / updateHdriShadowLights
      entry.light.intensity = intensity * 1.2;
    }
    // Ensure the shadow camera matrix is refreshed before the next render
    entry.light.target.updateMatrixWorld();
    entry.light.shadow.needsUpdate = true;
  }

  /** Create a visible HDRI light helper for a layer */
  private createHdriLightHelper(layer: HdriLayer, index: number): THREE.Group {
    const group = new THREE.Group();
    group.userData = { type: 'hdriLight', layerId: layer.id, layerIndex: index };

    // Sun sphere — green for high contrast on white studio surfaces
    const baseScale = 0.3 + (layer.intensity ?? 1) * 0.2;
    const sphereGeo = new THREE.SphereGeometry(baseScale, 16, 16);
    const sunColor = new THREE.Color(0x22cc66);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: sunColor,
      transparent: true,
      opacity: layer.enabled !== false ? 0.9 : 0.3,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    group.add(sphere);

    // Glow ring
    const ringGeo = new THREE.RingGeometry(baseScale * 1.3, baseScale * 1.6, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x22cc66,
      transparent: true,
      opacity: layer.enabled !== false ? 0.35 : 0.1,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.lookAt(0, 0, 0); // Face the center
    group.add(ring);

    // Label
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 40;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = layer.enabled !== false ? '#ffffff' : '#666666';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Light ${index + 1}`, 96, 28);
    const tex = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.8 });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1.4, 0.35, 1);
    sprite.position.y = baseScale + 0.4;
    group.add(sprite);

    // Direction line to origin
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x22cc66,
      transparent: true,
      opacity: layer.enabled !== false ? 0.25 : 0.08,
    });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0), // Will point toward origin
    ]);
    const line = new THREE.Line(lineGeo, lineMat);
    line.userData = { isDirectionLine: true };
    group.add(line);

    // Position on sky dome
    const pos = this.hdriRotationToPosition(layer.rotationX, layer.rotationY);
    group.position.copy(pos);

    // Update direction line to point from helper to origin
    const positions = lineGeo.attributes.position as THREE.BufferAttribute;
    positions.setXYZ(1, -pos.x, -pos.y, -pos.z);
    positions.needsUpdate = true;

    return group;
  }

  /** Setup HDRI light helpers from config layers */
  setupHdriLightHelpers(config: VideoStudioConfig): void {
    this.clearHdriLightHelpers();
    const layers = config.hdriConfig?.layers ?? [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const helper = this.createHdriLightHelper(layer, i);
      this.scene.add(helper);
      this.hdriLightHelpers.push({ layerId: layer.id, layerIndex: i, helper });
    }
  }

  /** Update HDRI light helper positions/visuals without full rebuild */
  updateHdriLightHelpers(config: VideoStudioConfig): void {
    const layers = config.hdriConfig?.layers ?? [];

    // When a template is loaded or undo/redo changes the config, the layer count
    // may differ from the number of helpers in the scene — rebuild helpers to match.
    if (layers.length !== this.hdriLightHelpers.length) {
      this.setupHdriLightHelpers(config);
      return;
    }

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const entry = this.hdriLightHelpers[i];
      if (!entry) continue;

      // When the config is replaced (template load / undo-redo / reset), the layer
      // IDs in the config diverge from the IDs stored on the helper objects.
      // Re-sync them by index so drag callbacks can find the layer by ID correctly.
      if (entry.layerId !== layer.id) {
        entry.layerId = layer.id;
        entry.helper.userData.layerId = layer.id;
      }

      // Skip position update while the user is actively dragging a helper
      if (!this._isHelperDragging) {
        const pos = this.hdriRotationToPosition(layer.rotationX, layer.rotationY);
        entry.helper.position.copy(pos);
      }

      // Update sun size based on intensity
      const baseScale = 0.3 + (layer.intensity ?? 1) * 0.2;
      entry.helper.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
          child.material.opacity = layer.enabled !== false ? 0.9 : 0.3;
        }
        if (child instanceof THREE.Line && child.userData.isDirectionLine) {
          const geo = child.geometry as THREE.BufferGeometry;
          const positions = geo.attributes.position as THREE.BufferAttribute;
          // Only update direction line target if not dragging
          if (!this._isHelperDragging) {
            const pos = this.hdriRotationToPosition(layer.rotationX, layer.rotationY);
            positions.setXYZ(1, -pos.x, -pos.y, -pos.z);
            positions.needsUpdate = true;
          }
        }
      });

      // Scale the whole helper to reflect intensity
      const scale = baseScale / (0.3 + 1 * 0.2); // Normalize to default
      entry.helper.scale.setScalar(scale);
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
  /**
   * Generate a flat solid-color equirectangular HDRI DataTexture.
   * Used for "Studio White" and custom-color studio lights.
   */
  private generateSolidColorHdri(hexColor: string, intensity: number = 1.0): THREE.DataTexture {
    const color = new THREE.Color(hexColor);
    const width = 64;
    const height = 32;
    const data = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4 + 0] = color.r * intensity;
      data[i * 4 + 1] = color.g * intensity;
      data[i * 4 + 2] = color.b * intensity;
      data[i * 4 + 3] = 1.0;
    }
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /** Get (or lazily create) a solid-color PMREM env map for surface materials.
   *  Surfaces use this instead of scene.environment so they receive uniform
   *  ambient light without reflecting the 3D HDRI scene.
   *  @param color - hex color string (default '#ffffff') */
  private getSurfaceEnvMap(color: string = '#ffffff'): THREE.Texture {
    // Recreate if color changed
    const key = color.toLowerCase();
    if (this.surfaceEnvRT && this._surfaceEnvColor === key) {
      return this.surfaceEnvRT.texture;
    }
    if (this.surfaceEnvRT) {
      this.surfaceEnvRT.dispose();
      this.surfaceEnvRT = null;
    }
    const tex = this.generateSolidColorHdri(color, 1.0);
    this.surfaceEnvRT = this.pmremGenerator.fromEquirectangular(tex);
    tex.dispose();
    this._surfaceEnvColor = key;
    return this.surfaceEnvRT.texture;
  }

  /** Apply an HDRI environment to cue materials only (not surfaces).
   *  Loads the HDRI, applies rotation, processes through PMREM, and sets
   *  material.envMap on all cue model meshes. */
  async setCueHdri(config: CueHdriConfig): Promise<void> {
    // When setHdriLayers() is actively managing cue env, skip standalone setCueHdri
    // to avoid overwriting the blended multi-layer result.
    if (this.hdriLayersActive) return;

    const key = JSON.stringify({
      t: config.hdriType,
      rx: Math.round(config.rotationX),
      ry: Math.round(config.rotationY),
      i: config.intensity,
    });
    if (key === this.lastCueHdriKey) return;

    try {
      let tex = await this.loadAndCacheHdri(config.hdriType);

      // Apply both X and Y rotation
      if (config.rotationX !== 0 || config.rotationY !== 0) {
        const rotated = this.createRotatedHdriTextureXY(tex, config.rotationX, config.rotationY);
        if (rotated) {
          tex.dispose();
          tex = rotated;
        }
      }

      tex.mapping = THREE.EquirectangularReflectionMapping;
      const rt = this.pmremGenerator.fromEquirectangular(tex);
      tex.dispose();

      if (this.cueEnvRT) {
        this.cueEnvRT.dispose();
      }
      this.cueEnvRT = rt;
      this.lastCueHdriKey = key;

      this.applyCueEnvMap(rt.texture, config.intensity);
    } catch (err) {
      console.error('[ESM] Failed to set cue HDRI:', err);
    }
  }

  /** Blend up to 2 HDRI layers and apply the result only to cue materials.
   *  Used by the Studio Simulator's mixed-HDRI feature. Deduplicates internally. */
  async setCueHdriLayers(layers: HdriLayer[]): Promise<void> {
    const activeLayers = layers.filter(l => l.enabled !== false);
    if (activeLayers.length === 0) return;

    const key = JSON.stringify(activeLayers.map(l => ({
      t: l.hdriType, i: l.intensity,
      rx: Math.round(l.rotationX), ry: Math.round(l.rotationY),
    })));
    if (key === this.lastCueHdriLayersKey) return;

    try {
      const textures: THREE.DataTexture[] = [];
      const intensities: number[] = [];
      for (const layer of activeLayers) {
        try {
          const tex = await this.loadAndCacheHdri(layer.hdriType);
          textures.push(tex);
          intensities.push(layer.intensity ?? 1);
        } catch (loadErr) {
          console.error('[ESM] setCueHdriLayers: failed to load HDRI', layer.hdriType, loadErr);
        }
      }
      if (textures.length === 0) return;

      // Apply per-layer rotation
      const rotated: THREE.DataTexture[] = [];
      for (let i = 0; i < textures.length; i++) {
        const rx = activeLayers[i].rotationX ?? 0;
        const ry = activeLayers[i].rotationY ?? 0;
        if (rx !== 0 || ry !== 0) {
          const r = this.createRotatedHdriTextureXY(textures[i], rx, ry);
          rotated.push(r ?? textures[i]);
        } else {
          rotated.push(textures[i]);
        }
      }

      let finalTex: THREE.DataTexture;
      if (rotated.length === 1) {
        finalTex = intensities[0] !== 1
          ? this.blendHdriTextures(rotated, intensities)
          : rotated[0].clone();
      } else {
        finalTex = this.blendHdriTextures(rotated, intensities);
      }

      // Dispose intermediate rotated copies (not the originals from cache)
      for (let i = 0; i < rotated.length; i++) {
        if (rotated[i] !== textures[i]) rotated[i].dispose();
      }

      finalTex.mapping = THREE.EquirectangularReflectionMapping;
      const rt = this.pmremGenerator.fromEquirectangular(finalTex);
      finalTex.dispose();

      if (this.cueEnvRT) this.cueEnvRT.dispose();
      this.cueEnvRT = rt;
      this.lastCueHdriLayersKey = key;
      // Invalidate single-HDRI cache so setCueHdri re-applies if called later
      this.lastCueHdriKey = '';

      this.applyCueEnvMap(rt.texture, 1.0);
    } catch (err) {
      console.error('[ESM] Failed to set cue HDRI layers:', err);
    }
  }

  /** Walk all cue materials (clonedModel + instancedMeshes + simulatorCueGroups) and set envMap */
  private applyCueEnvMap(envMap: THREE.Texture | null, intensity: number): void {
    this.cueEnvIntensity = intensity;
    if (this.clonedModel) {
      this.clonedModel.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
          child.material.envMap = envMap;
          child.material.envMapIntensity = intensity;
          child.material.needsUpdate = true;
        }
      });
    }
    for (const im of this.instancedMeshes) {
      if (im.material instanceof THREE.MeshStandardMaterial) {
        im.material.envMap = envMap;
        im.material.envMapIntensity = intensity;
        im.material.needsUpdate = true;
      } else if (Array.isArray(im.material)) {
        for (const mat of im.material) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            mat.envMap = envMap;
            mat.envMapIntensity = intensity;
            mat.needsUpdate = true;
          }
        }
      }
    }
    for (const group of this.simulatorCueGroups) {
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            mat.envMap = envMap;
            mat.envMapIntensity = intensity;
            mat.needsUpdate = true;
          }
        }
      });
    }
  }

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
   * Apply multiple HDRI layers (additive blending).
   * HDRI provides ambient lighting + reflections — NOT rotated per layer.
   * Per-layer rotation only affects DirectionalLight position (shadow lights).
   * When all layers are disabled, clears the environment to go dark.
   * Queues the latest request if an update is already in progress.
   */
  async setHdriLayers(layers: HdriLayer[], options?: { applyCueEnv?: boolean }): Promise<void> {
    const applyCueEnv = options?.applyCueEnv ?? false;
    // Filter to enabled layers only
    const activeLayers = layers.filter(l => l.enabled !== false);

    // Only manage cue env when explicitly requested (Image Extractor mixing).
    // Video Studio calls this for wall/surface lighting only — cue is handled by setCueHdri().
    this.hdriLayersActive = applyCueEnv && activeLayers.length > 0;

    // If no active layers, clear environment so scene goes dark
    if (activeLayers.length === 0) {
      if (this.envRenderTarget) {
        this.envRenderTarget.dispose();
        this.envRenderTarget = null;
      }
      this.scene.environment = null;
      this.lastHdriLayersKey = '';
      this.currentHdriLayers = layers;
      return;
    }
    
    // Dedup key: hdriType, intensity AND rotation affect the environment map.
    // Rotation changes the IBL direction on the cue model.
    const layersKey = JSON.stringify(activeLayers.map(l => ({
      t: l.hdriType, i: l.intensity,
      rx: Math.round(l.rotationX), ry: Math.round(l.rotationY),
      c: l.lightColor,
    })));

    // Skip if same as last applied (avoid redundant expensive operations)
    if (layersKey === this.lastHdriLayersKey) {
      return;
    }
    
    // If an update is already in progress, queue this one (latest wins)
    if (this.pendingHdriUpdate) {
      this.queuedHdriLayers = layers;
      this.queuedHdriApplyCue = applyCueEnv;
      return;
    }
    this.pendingHdriUpdate = true;
    
    this.currentHdriLayers = layers;
    
    try {
      // Load all needed HDRIs (or generate solid-color for studio lights)
      const textures: THREE.DataTexture[] = [];
      const intensities: number[] = [];
      for (const layer of activeLayers) {
        try {
          let tex: THREE.DataTexture;
          if (layer.hdriType === STUDIO_WHITE_HDRI) {
            tex = this.generateSolidColorHdri(layer.lightColor ?? "#ffffff", layer.intensity ?? 1);
            intensities.push(1); // intensity already baked into the texture
          } else {
            tex = await this.loadAndCacheHdri(layer.hdriType);
            intensities.push(layer.intensity ?? 1);
          }
          textures.push(tex);
        } catch (loadError) {
          console.error('[ExtractorSceneManager] Failed to load HDRI:', layer.hdriType, loadError);
        }
      }
      
      if (textures.length === 0) {
        console.error('[ExtractorSceneManager] No HDRIs could be loaded');
        this.pendingHdriUpdate = false;
        this.processQueuedHdriLayers();
        return;
      }
      
      // Rotate HDRI textures by their layer rotationX and rotationY so IBL on the cue
      // reflects the light direction, not just the shadow direction.
      const rotatedTextures: THREE.DataTexture[] = [];
      for (let i = 0; i < textures.length; i++) {
        const rotXDeg = activeLayers[i].rotationX ?? 0;
        const rotYDeg = activeLayers[i].rotationY ?? 0;
        if (rotXDeg !== 0 || rotYDeg !== 0) {
          const rotated = this.createRotatedHdriTextureXY(textures[i], rotXDeg, rotYDeg);
          rotatedTextures.push(rotated ?? textures[i]);
        } else {
          rotatedTextures.push(textures[i]);
        }
      }

      let finalTexture: THREE.DataTexture;
      if (rotatedTextures.length === 1) {
        if (intensities[0] !== 1) {
          finalTexture = this.blendHdriTextures(rotatedTextures, intensities);
        } else {
          // Clone so we don't dispose the cache entry
          finalTexture = rotatedTextures[0].clone();
        }
      } else {
        finalTexture = this.blendHdriTextures(rotatedTextures, intensities);
      }

      // Dispose intermediate rotated textures (not the original cached ones)
      for (let i = 0; i < rotatedTextures.length; i++) {
        if (rotatedTextures[i] !== textures[i]) {
          rotatedTextures[i].dispose();
        }
      }
      
      finalTexture.mapping = THREE.EquirectangularReflectionMapping;
      
      const rt = this.pmremGenerator.fromEquirectangular(finalTexture);
      finalTexture.dispose();
      
      if (this.envRenderTarget) {
        this.envRenderTarget.dispose();
      }
      this.envRenderTarget = rt;
      // Clear scene.environment since the old render target (set by loadHDRI) was just disposed.
      this.scene.environment = null;

      // Apply blended PMREM directly to cue materials when explicitly requested
      // (Image Extractor multi-layer mixing). Video Studio skips this — cue gets
      // its own env from setCueHdri().
      if (applyCueEnv) {
        this.applyCueEnvMap(rt.texture, 1.0);
        // Invalidate setCueHdri cache so it re-applies if layers are later cleared
        this.lastCueHdriKey = '';
      }
      
      // Mark as successfully applied
      this.lastHdriLayersKey = layersKey;
    } catch (error) {
      console.error('[ExtractorSceneManager] Error applying HDRI layers:', error);
      try {
        const fallbackUrl = `/hdri/bloem_train_track_clear_2k.hdr`;
        await this.loadHDRI(fallbackUrl);
      } catch (fallbackError) {
        console.error('[ExtractorSceneManager] Fallback also failed:', fallbackError);
      }
    } finally {
      this.pendingHdriUpdate = false;
      // Process queued update if any (latest request wins)
      this.processQueuedHdriLayers();
    }
  }

  /** Process queued HDRI layer update (called after current update completes) */
  private processQueuedHdriLayers(): void {
    if (this.queuedHdriLayers) {
      const queued = this.queuedHdriLayers;
      const applyCue = this.queuedHdriApplyCue;
      this.queuedHdriLayers = null;
      this.queuedHdriApplyCue = false;
      this.setHdriLayers(queued, { applyCueEnv: applyCue }).catch(err =>
        console.warn('[ESM] Queued HDRI update failed:', err)
      );
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
  private blendHdriTextures(textures: THREE.DataTexture[], weights?: number[]): THREE.DataTexture {
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
    const w0 = weights?.[0] ?? 1;
    
    if (isHalfFloat && firstData instanceof Uint16Array) {
      for (let i = 0; i < totalPixels; i++) {
        blendedFloat[i] = this.halfToFloat(firstData[i]) * w0;
      }
    } else {
      for (let i = 0; i < totalPixels; i++) {
        blendedFloat[i] = firstData[i] * w0;
      }
    }
    
    // Add remaining textures (additive blend, each weighted by its intensity)
    for (let t = 1; t < textures.length; t++) {
      const w = weights?.[t] ?? 1;
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
            blendedFloat[i] += this.halfToFloat(texData[i]) * w;
          }
        } else {
          for (let i = 0; i < totalPixels; i++) {
            blendedFloat[i] += texData[i] * w;
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
              blendedFloat[dstIdx + c] += val * w;
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

    // Deep-clone geometry and materials so the extractor is fully isolated
    // from the main scene. Without this, clone(true) shares geometry/material
    // instances — mutating envMap or disposing here would corrupt the main scene.
    this.clonedModel.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry = child.geometry.clone();
        if (Array.isArray(child.material)) {
          child.material = child.material.map((m: THREE.Material) => m.clone());
        } else {
          child.material = child.material.clone();
        }
        // Re-apply bumper shader mask — material.clone() drops onBeforeCompile
        const mat = child.material as THREE.MeshPhysicalMaterial;
        if (mat.emissiveMap && isRubberMaterial(mat.name, child.name)) {
          applyBumperEmissiveShaderMask(mat);
        }
      }
    });

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

  /** Pause continuous spin animation (during manual rotation) */
  pauseSpin(): void { this._spinPaused = true; }

  /** Resume continuous spin animation */
  resumeSpin(): void { this._spinPaused = false; }

  /** Mark that user is actively dragging an HDRI helper — skip position updates from config */
  setHelperDragging(dragging: boolean): void { this._isHelperDragging = dragging; }

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
   * Apply 3D studio shadow for a CueFrame in the image extractor.
   * The DirectionalLight is positioned at (lightX, lightY, lightZ) and casts shadows
   * onto a ShadowMaterial floor plane beneath the cue model.
   * This light is completely separate from HDRI/cue lighting — it only affects the shadow.
   * A white (or custom-color) floor base and back wall are also added to create the
   * seamless-paper studio look used in the simulator capture.
   * Layout matches Video Studio exactly: wall at (0, 10, -5.5), table at y=-2.
   */
  setFrameShadow(config: {
    enabled: boolean;
    lightX: number;
    lightY: number;
    lightZ: number;
    intensity: number;
    blur: number;
    wallColor?: string;
    wallGradientEnd?: string;
    shadowOffsetX?: number;
    shadowOffsetY?: number;
    shadowOffsetZ?: number;
    shadowScale?: number;
    shadowRotationY?: number;
  }): void {
    if (!config.enabled) {
      this.clearFrameShadow();
      return;
    }

    const wallColor = config.wallColor ?? '#ffffff';
    const wallGradientEnd = config.wallGradientEnd;
    const { FRAME_WALL_WIDTH, FRAME_WALL_HEIGHT, FRAME_WALL_Y, FRAME_WALL_Z,
            FRAME_TABLE_Y, FRAME_TABLE_DEPTH, FRAME_SHADOW_FRUSTUM } = ExtractorSceneManager;

    // ── Wall backdrop (vertical plane behind cue) ────────────────────────────
    if (!this.frameWallBackdrop) {
      this.frameWallBackdrop = new THREE.Mesh(
        new THREE.PlaneGeometry(FRAME_WALL_WIDTH, FRAME_WALL_HEIGHT),
        new THREE.MeshBasicMaterial({ color: wallColor, side: THREE.FrontSide })
      );
      this.frameWallBackdrop.position.set(0, FRAME_WALL_Y, FRAME_WALL_Z);
      this.scene.add(this.frameWallBackdrop);
    } else {
      this.applyStudioColor(
        this.frameWallBackdrop.material as THREE.MeshBasicMaterial,
        wallColor, wallGradientEnd
      );
    }

    // ── Table backdrop (horizontal plane below cue) ──────────────────────────
    if (!this.frameTableBackdrop) {
      this.frameTableBackdrop = new THREE.Mesh(
        new THREE.PlaneGeometry(FRAME_WALL_WIDTH, FRAME_TABLE_DEPTH),
        new THREE.MeshBasicMaterial({ color: wallColor, side: THREE.FrontSide })
      );
      this.frameTableBackdrop.rotation.x = -Math.PI / 2;
      this.frameTableBackdrop.position.set(0, FRAME_TABLE_Y, FRAME_WALL_Z + FRAME_TABLE_DEPTH / 2);
      this.scene.add(this.frameTableBackdrop);
    } else {
      this.applyStudioColor(
        this.frameTableBackdrop.material as THREE.MeshBasicMaterial,
        wallColor, wallGradientEnd
      );
    }

    // ── L-shaped shadow mesh (spans wall + table seamlessly) ─────────────────
    if (!this.frameShadowFloor) {
      this.frameShadowFloor = createLShapedShadowMesh(
        36,                    // width (slightly wider than surfaces)
        FRAME_WALL_HEIGHT,     // wall height
        FRAME_TABLE_DEPTH + 2, // floor depth (extra margin)
        FRAME_TABLE_Y,         // corner Y (where wall meets table)
        FRAME_WALL_Z,          // wall Z position
        config.intensity
      );
      this.frameShadowBaseY = this.frameShadowFloor.position.y;
      this.scene.add(this.frameShadowFloor);
    }
    (this.frameShadowFloor.material as THREE.ShadowMaterial).opacity = config.intensity;
    const frameShadowOffsetX = config.shadowOffsetX ?? 0;
    const frameShadowOffsetY = config.shadowOffsetY ?? 0;
    const frameShadowOffsetZ = config.shadowOffsetZ ?? 0;
    const frameShadowScale = config.shadowScale ?? 1;
    const frameShadowRotationY = config.shadowRotationY ?? 0;
    this.frameShadowFloor.position.set(
      frameShadowOffsetX,
      this.frameShadowBaseY + frameShadowOffsetY,
      frameShadowOffsetZ
    );
    this.frameShadowFloor.scale.set(frameShadowScale, 1, frameShadowScale);
    this.frameShadowFloor.rotation.y = frameShadowRotationY;

    // ── Shadow-casting DirectionalLight ──────────────────────────────────────
    if (!this.frameShadowLight) {
      this.frameShadowLight = new THREE.DirectionalLight(0xffffff, 0);
      this.frameShadowLight.castShadow = true;
      this.frameShadowLight.shadow.mapSize.set(2048, 2048);
      this.frameShadowLight.shadow.camera.near = 0.1;
      this.frameShadowLight.shadow.camera.far = 50;
      this.frameShadowLight.shadow.camera.left = -FRAME_SHADOW_FRUSTUM;
      this.frameShadowLight.shadow.camera.right = FRAME_SHADOW_FRUSTUM;
      this.frameShadowLight.shadow.camera.top = FRAME_SHADOW_FRUSTUM;
      this.frameShadowLight.shadow.camera.bottom = -FRAME_SHADOW_FRUSTUM;
      this.frameShadowLight.shadow.bias = -0.0001;
      this.frameShadowLight.shadow.normalBias = 0.02;
      this.frameShadowLight.shadow.blurSamples = 20;
      this.frameShadowLight.target.position.set(0, 0, 0);
      this.scene.add(this.frameShadowLight);
      this.scene.add(this.frameShadowLight.target);
    }

    this.frameShadowLight.position.set(config.lightX, config.lightY, config.lightZ);
    this.frameShadowLight.shadow.radius = Math.max(config.blur, 4);
    // Force shadow camera to update after position change
    this.frameShadowLight.shadow.camera.updateProjectionMatrix();
  }

  /** Set shadow map resolution for frame shadow light */
  setFrameShadowQuality(size: number): void {
    if (this.frameShadowLight) {
      this.frameShadowLight.shadow.mapSize.set(size, size);
      this.frameShadowLight.shadow.map?.dispose();
      this.frameShadowLight.shadow.map = null; // Force recreation
      this.frameShadowLight.shadow.camera.updateProjectionMatrix();
    }
  }

  /** Update only the wall/floor color without re-creating all shadow objects. */
  setFrameShadowWallColor(wallColor: string, wallGradientEnd?: string): void {
    if (this.frameWallBackdrop) {
      this.applyStudioColor(this.frameWallBackdrop.material as THREE.MeshBasicMaterial, wallColor, wallGradientEnd);
    }
    if (this.frameTableBackdrop) {
      this.applyStudioColor(this.frameTableBackdrop.material as THREE.MeshBasicMaterial, wallColor, wallGradientEnd);
    }
  }

  /** Returns a deep-cloned copy of the current cue model for use in the simulator. */
  getModelClone(): THREE.Group | null {
    if (!this.clonedModel) return null;
    const clone = this.clonedModel.clone(true);
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry = child.geometry.clone();
        const cloneMat = (mat: THREE.Material) => {
          const m = mat.clone() as THREE.MeshPhysicalMaterial;
          // Remove renderer-specific env maps; the simulator uses its own lighting
          if ('envMap' in m) m.envMap = null;
          m.needsUpdate = true;
          return m;
        };
        if (Array.isArray(child.material)) {
          child.material = child.material.map(cloneMat);
        } else {
          child.material = cloneMat(child.material as THREE.Material);
        }
        child.castShadow = true;
        child.receiveShadow = false;
      }
    });
    return clone;
  }

  /** Apply a solid color or linear gradient (via canvas texture) to a MeshBasicMaterial. */
  private applyStudioColor(mat: THREE.MeshBasicMaterial, colorHex: string, gradientEnd?: string): void {
    if (gradientEnd) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d')!;
      const grad = ctx.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, colorHex);
      grad.addColorStop(1, gradientEnd);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
      if (mat.map) mat.map.dispose();
      mat.map = new THREE.CanvasTexture(canvas);
      mat.color.set(0xffffff);
    } else {
      if (mat.map) { mat.map.dispose(); mat.map = null; }
      mat.color.set(new THREE.Color(colorHex));
    }
    mat.needsUpdate = true;
  }

  private clearFrameShadow(): void {
    if (this.frameShadowLight) {
      this.scene.remove(this.frameShadowLight);
      if (this.frameShadowLight.target.parent) {
        this.scene.remove(this.frameShadowLight.target);
      }
      this.frameShadowLight.dispose();
      this.frameShadowLight = null;
    }
    const disposeMesh = (mesh: THREE.Mesh | null) => {
      if (!mesh) return;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m: THREE.Material) => m.dispose());
      } else {
        (mesh.material as THREE.Material).dispose();
      }
    };
    disposeMesh(this.frameShadowFloor);    this.frameShadowFloor = null;
    this.frameShadowBaseY = 0;
    disposeMesh(this.frameWallBackdrop);   this.frameWallBackdrop = null;
    disposeMesh(this.frameTableBackdrop);  this.frameTableBackdrop = null;
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

    // Ensure scene.environment is null — cue and surfaces each get their own envMap
    this.scene.environment = null;

    // Apply multi-layer HDRI for shadow lights (no longer sets scene.environment)
    const layers = config.hdriConfig?.layers ?? [];
    try {
      await this.setHdriLayers(layers);
    } catch (err) { console.warn('[ESM] Failed to apply HDRI layers:', err); }

    // Apply HDRI intensity
    this.updateHdriIntensity(config);

    // Setup HDRI light helpers (interactive scene components)
    this.setupHdriLightHelpers(config);

    // HDRI-driven shadow lights (one DirectionalLight per HDRI layer)
    this.setupHdriShadowLights(config);

    // Apply cue-only HDRI (isolated from studio surfaces)
    const cueHdri = config.cueHdri ?? DEFAULT_CUE_HDRI;
    try {
      if (config.cueHdriLayers && config.cueHdriLayers.length > 0) {
        await this.setCueHdriLayers(config.cueHdriLayers);
      } else {
        await this.setCueHdri(cueHdri);
      }
    } catch (err) { console.warn('[ESM] Failed to apply cue HDRI:', err); }

    // ── Load PBR textures for wall and table ──
    const manifest = await loadTextureManifest();

    // Wall: PBR texture with subdivided geometry for displacement
    const wallPack = findTexturePack(manifest, config.wallSurface.texturePreset);
    let wallMaterial: THREE.MeshStandardMaterial;
    if (wallPack) {
      wallMaterial = await loadPBRTexturePack(wallPack);
    } else {
      const wallImages = await preloadFrameImages(config.wallSurface.frames);
      const wallTex = compositeSurfaceFrames(config.wallSurface, 2048, 2048, wallImages);
      wallTex.wrapS = THREE.ClampToEdgeWrapping;
      wallTex.wrapT = THREE.ClampToEdgeWrapping;
      wallTex.repeat.set(1, 1);
      wallMaterial = new THREE.MeshStandardMaterial({
        map: wallTex, roughness: 0.95, metalness: 0, side: THREE.FrontSide,
      });
    }
    // Surfaces use a solid-color env map (tinted by studio light color) instead of
    // scene.environment, providing uniform ambient lighting without HDRI reflections.
    const firstEnabledLayer = (config.hdriConfig?.layers ?? []).find(l => l.enabled !== false);
    const surfaceColor = firstEnabledLayer?.lightColor ?? '#ffffff';
    const surfaceEnv = this.getSurfaceEnvMap(surfaceColor);
    wallMaterial.envMap = surfaceEnv;
    wallMaterial.envMapIntensity = 0.6;
    if (config.wallSurface.roughness != null) {
      wallMaterial.roughness = config.wallSurface.roughness;
    }

    // Subdivided wall geometry for better displacement mapping
    const wallGeo = new THREE.PlaneGeometry(34, 24, 64, 64);
    const wallMeshMat: THREE.Material = config.surfaceLightDisabled
      ? createWhiteImmuneMaterial()
      : wallMaterial;
    if (config.surfaceLightDisabled) wallMaterial.dispose();
    this.backdrop = new THREE.Mesh(wallGeo, wallMeshMat);
    this.backdrop.position.set(0, 10, -5.5);
    this.scene.add(this.backdrop);
    this.backdrop.userData = { type: 'wall' };

    // Table: PBR texture with subdivided geometry
    const tableY = -2;
    const tableDepth = 12;
    const tablePack = findTexturePack(manifest, config.tableSurface.texturePreset);
    let tableMaterial: THREE.MeshStandardMaterial;
    if (tablePack) {
      tableMaterial = await loadPBRTexturePack(tablePack);
    } else {
      const tableImages = await preloadFrameImages(config.tableSurface.frames);
      const tableTex = compositeSurfaceFrames(config.tableSurface, 2048, 2048, tableImages);
      tableTex.wrapS = THREE.ClampToEdgeWrapping;
      tableTex.wrapT = THREE.ClampToEdgeWrapping;
      tableTex.repeat.set(1, 1);
      tableMaterial = new THREE.MeshStandardMaterial({
        map: tableTex, roughness: 0.35, metalness: 0, side: THREE.FrontSide,
      });
    }
    tableMaterial.envMap = surfaceEnv;
    tableMaterial.envMapIntensity = 0.6;
    if (config.tableSurface.roughness != null) {
      tableMaterial.roughness = config.tableSurface.roughness;
    }

    // Subdivided table geometry for displacement
    const tableGeo = new THREE.PlaneGeometry(34, tableDepth, 64, 64);
    const tableMeshMat: THREE.Material = config.surfaceLightDisabled
      ? createWhiteImmuneMaterial()
      : tableMaterial;
    if (config.surfaceLightDisabled) tableMaterial.dispose();
    this.tableSurface = new THREE.Mesh(tableGeo, tableMeshMat);
    this.tableSurface.rotation.x = -Math.PI / 2;
    this.tableSurface.position.y = tableY;
    this.tableSurface.position.z = -5.5 + tableDepth / 2;
    this.scene.add(this.tableSurface);
    this.tableSurface.userData = { type: 'table' };

    // Build frame overlay planes for interactive scene view
    const wallImages2 = await preloadFrameImages(config.wallSurface.frames);
    const tableImages2 = await preloadFrameImages(config.tableSurface.frames);
    this.wallFramePlanes = this.buildFramePlanes(config.wallSurface, this.backdrop!, false, wallImages2);
    this.tableFramePlanes = this.buildFramePlanes(config.tableSurface, this.tableSurface!, true, tableImages2);

    // Single L-shaped shadow receiver spanning wall + table seamlessly
    if (config.shadow.enabled) {
      const wallZ = -5.5;
      const shadowMesh = createLShapedShadowMesh(
        36,                    // width (slightly wider than surfaces)
        24,                    // wall height
        tableDepth + 2,        // floor depth
        tableY,                // corner Y (where wall meets table)
        wallZ,                 // wall Z position
        config.shadow.intensity
      );
      // Offsets baked into vertices — no position adjustment needed
      this.shadowFloor = shadowMesh;
      this.shadowFloorBaseY = shadowMesh.position.y;
      this.scene.add(this.shadowFloor);
      // Restore saved manual transform for shadow floor (if any)
      this.applyShadowPlaneTransform(config);

      // Curved corner fill: provides backing geometry for the shadow mesh's curved section.
      // Material matches the surface mode: MeshStandardMaterial when studio lights affect
      // surfaces (so the curve blends with wall/table), MeshBasicMaterial (pure white, unlit)
      // when surface light is disabled.
      this.studioCornerFill = createCornerFillMesh(34, tableY, wallZ, '#ffffff');
      if (!config.surfaceLightDisabled) {
        // Swap to MeshStandardMaterial so studio lights affect the curve the same as wall/table.
        (this.studioCornerFill.material as THREE.Material).dispose();
        this.studioCornerFill.material = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.35,
          metalness: 0,
          side: THREE.FrontSide,
          envMap: surfaceEnv,
          envMapIntensity: 0.6,
        });
      }
      this.studioCornerFill.userData = { type: 'corner-fill' };
      this.scene.add(this.studioCornerFill);
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
        const tableWidth = 34;
        const tableDepth = 12;
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
        const wallHeight = 24;
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
      const wallHeight = 24;
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
      const tableWidth = 34;
      const tableDepth = 12;
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
  startStudioVideoPreview(config: VideoStudioConfig, preserveCamera = false): void {
    this.stopVideoPreview();
    if (!this.model) return;

    this.studioConfigRef = config;
    const cue = config.cueConfig;

    // Setup cue instances
    this.setupCueInstances(cue);

    // Camera at start position — skip if placement mode is active or caller requested preserve
    if (!preserveCamera && !this._cameraPlacementMode) {
      this.setCameraFromKeyframe(config.cameraStart);
    }
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();

    // 60fps is the reference rate for spin speed (0.02 rad/frame at 60fps = 1.2 rad/s).
    // Delta-time scaling ensures the same angular velocity on any display refresh rate.
    const SPIN_REF_MS = 1000 / 60;
    // Cap preview at 60fps — saves GPU on high-refresh displays and keeps memory bandwidth free.
    const PREVIEW_FRAME_MS = 1000 / 60;
    let prevPreviewTimestamp = -1;

    const animate = (timestamp: number) => {
      if (this.isDisposed || !this.studioConfigRef) return;
      this.animationFrameId = requestAnimationFrame(animate);

      // Throttle to 60fps max
      const sinceLastFrame = prevPreviewTimestamp < 0 ? PREVIEW_FRAME_MS : timestamp - prevPreviewTimestamp;
      if (sinceLastFrame < PREVIEW_FRAME_MS) return;

      const cfg = this.studioConfigRef;
      const deltaMs = prevPreviewTimestamp < 0
        ? SPIN_REF_MS
        : Math.min(timestamp - prevPreviewTimestamp, 100); // cap to prevent jumps after tab switch
      prevPreviewTimestamp = timestamp;
      const timeScale = deltaMs / SPIN_REF_MS;
      const hasSpinY = cfg.cueConfig.spinSpeed > 0;
      const hasSpinX = (cfg.cueConfig.spinSpeedX || 0) > 0;
      if ((hasSpinY || hasSpinX) && !this._spinPaused) {
        this.spinCueInstances(
          hasSpinY ? cfg.cueConfig.spinSpeed * 0.02 * timeScale : 0,
          hasSpinX ? (cfg.cueConfig.spinSpeedX || 0) * 0.02 * timeScale : 0
        );
      }
      if (this._cameraOrbit) this._cameraOrbit.update();
      this.render();
    };
    animate(performance.now());
  }

  /** Update studio preview config without restarting the loop */
  updateStudioPreviewConfig(config: VideoStudioConfig): void {
    this.studioConfigRef = config;
    if (!this.model) return;

    // Apply multi-layer HDRI for shadow lights (live update — deduplicates internally, queues if busy)
    const layers = config.hdriConfig?.layers ?? [];
    this.setHdriLayers(layers).catch(err =>
      console.warn('[ESM] Failed to update HDRI layers:', err)
    );

    // Apply cue-only HDRI (separate from studio surfaces)
    const cueHdri = config.cueHdri ?? DEFAULT_CUE_HDRI;
    if (config.cueHdriLayers && config.cueHdriLayers.length > 0) {
      this.setCueHdriLayers(config.cueHdriLayers).catch(err =>
        console.warn('[ESM] Failed to update cue HDRI layers:', err)
      );
    } else {
      this.setCueHdri(cueHdri).catch(err =>
        console.warn('[ESM] Failed to update cue HDRI:', err)
      );
    }

    // Update cue instances
    this.updateCueInstances(config.cueConfig);

    // Sync frame plane positions/scales from config
    this.updateFramePlaneTransforms(config);

    // Apply shadow settings
    this.updateShadowFromConfig(config);

    // Apply HDRI intensity
    this.updateHdriIntensity(config);

    // Apply surface HDRI separation
    this.updateSurfaceHdri(config);

    // Update HDRI light helpers
    this.updateHdriLightHelpers(config);

    // Sync camera position from config (handles template load + slider edits) — skip during placement mode
    if (!this._cameraPlacementMode) {
      this.setCameraFromKeyframe(config.cameraStart);
    }
  }

  /** Apply shadow config via HDRI-driven shadow lights */
  private updateShadowFromConfig(config: VideoStudioConfig): void {
    this.updateHdriShadowLights(config);
    // Apply shadow plane offset/scale from shadow config (independent of light direction)
    this.applyShadowPlaneTransform(config);
  }

  /**
   * Apply manual shadow plane offset and scale from CueShadowConfig stored in studioConfigSnapshot.
   * Now loads values into the 2D compositing fields — no 3D mesh movement.
   */
  private applyShadowPlaneTransform(_config: VideoStudioConfig): void {
    // No-op: 2D shadow plane transforms removed. Shadow shape is determined by 3D lights only.
  }

  /**
   * Public: no-op kept for backward compatibility.
   */
  setShadowPlaneTransform(
    _offsetX: number,
    _offsetY: number,
    _offsetZ: number,
    _scale: number,
    _rotationY = 0
  ): void {
    // No-op: shadow position is controlled by 3D light angles, not 2D offsets.
  }

  /** Apply HDRI intensity to scene environment and shadow lights */
  private updateHdriIntensity(config: VideoStudioConfig): void {
    const intensity = config.hdriIntensity ?? 1.0;
    // Apply to scene.environmentIntensity (Three.js r155+) — falls back gracefully
    if ('environmentIntensity' in this.scene) {
      (this.scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = intensity;
    }
    // Scale HDRI shadow lights by global intensity
    for (const entry of this.hdriShadowLights) {
      const layerIntensity = entry.light.userData?.baseIntensity ?? entry.light.intensity;
      entry.light.intensity = layerIntensity * intensity;
    }
  }

  /** Apply per-surface roughness from config and tint surface envMap with studio light color */
  private updateSurfaceHdri(config: VideoStudioConfig): void {
    // When surfaceLightDisabled the wall/table use MeshBasicMaterial — skip all env map updates.
    if (config.surfaceLightDisabled) return;

    // Use the first enabled studio light's color for surface tint
    const firstEnabledLayer = (config.hdriConfig?.layers ?? []).find(l => l.enabled !== false);
    const surfaceColor = firstEnabledLayer?.lightColor ?? '#ffffff';
    const surfaceEnv = this.getSurfaceEnvMap(surfaceColor);

    const targets: Array<{ mesh: THREE.Mesh | null; roughness?: number }> = [
      { mesh: this.backdrop, roughness: config.wallSurface.roughness },
      { mesh: this.tableSurface, roughness: config.tableSurface.roughness },
      // Corner fill curve must match surface tint so it blends seamlessly with wall/table.
      { mesh: this.studioCornerFill },
    ];

    for (const { mesh, roughness } of targets) {
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.envMap = surfaceEnv;
      mat.envMapIntensity = 0.6;
      mat.needsUpdate = true;
      if (roughness != null) {
        mat.roughness = roughness;
      }
    }
  }

  /** Record video using the new start/end camera animation system */
  async startStudioRecording(
    config: VideoStudioConfig,
    onProgress?: (progress: number) => void
  ): Promise<Blob> {
    if (!this.model) throw new Error('No model loaded');

    // Resolve output dimensions from quality + ratio (ratio overrides width)
    const dims = getRecordingDimensions(
      config.quality ?? "2k",
      config.videoRatio ?? "16:9"
    );

    // Stop live preview and all background render loops FIRST to free GPU resources
    // and eliminate competing draw calls during recording setup.
    this.stopVideoPreview();

    // Dispose orbit controls before recording so DOM event handlers (pointer/wheel)
    // cannot fire orbit.update() and override camera position mid-recording.
    // After recording, setViewMode("camera") recreates the orbit from the end position.
    if (this._cameraOrbit) {
      this._cameraOrbit.dispose();
      this._cameraOrbit = null;
    }

    return new Promise((resolve, reject) => {
      // Set pixel ratio to 1 — dims already define the exact output resolution.
      // Using devicePixelRatio here would silently render at DPR×resolution
      // (e.g. 5120×2880 on a Retina display) wasting 4× GPU cycles without any
      // quality benefit in the recorded file. resize() restores DPR after recording.
      this.renderer.setPixelRatio(1);
      // Pass false to prevent Three.js from overwriting canvas CSS (width/height px style)
      this.renderer.setSize(dims.width, dims.height, false);
      this.camera.aspect = dims.width / dims.height;
      this.camera.updateProjectionMatrix();

      this.setupStudioFromStudioConfig(config).then(async () => {
        this.setCameraFromKeyframe(config.cameraStart);
        this.camera.fov = 50;
        this.camera.updateProjectionMatrix();

        // ── Recording GPU optimisations ─────────────────────────────────────────
        //
        // 1. Reduce shadow map resolution: 1024×1024 is indistinguishable at
        //    1080p–1440p output and halves shadow VRAM + fill-rate cost.
        //
        // 2. Switch shadow type from VSMShadowMap → PCFSoftShadowMap.
        //    VSM requires two full-canvas Gaussian blur passes (blurSamples=20 each)
        //    every frame per light — extremely expensive.  PCFSoft uses single-pass
        //    hardware PCF with similar perceptual quality and zero extra passes.
        //
        // 3. If the cue is not spinning, shadows are static for the entire recording.
        //    We let the warmup renders build the shadow maps, then freeze auto-update
        //    so the shadow depth pass is skipped on every animation frame.
        //
        // All settings are restored to preview quality in onstop.
        const RECORD_SHADOW_SIZE = 1024;
        const savedShadowType = this.renderer.shadowMap.type;
        this._recordingSavedShadowType = savedShadowType;
        type ShadowWithMap = THREE.LightShadow & { map: THREE.WebGLRenderTarget | null };

        const clearShadowMap = (shadow: THREE.LightShadow) => {
          shadow.mapSize.set(RECORD_SHADOW_SIZE, RECORD_SHADOW_SIZE);
          shadow.map?.dispose();
          (shadow as ShadowWithMap).map = null;
        };

        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        for (const { light } of this.hdriShadowLights) clearShadowMap(light.shadow);
        if (this.frameShadowLight) clearShadowMap(this.frameShadowLight.shadow);

        // Pre-compile all shaders to avoid GPU stalls on the first recorded frames.
        this.renderer.compile(this.scene, this.camera);

        // Warm-up: render 60 frames with 32ms yields every 8 frames so the GPU has
        // enough time to fully upload PBR textures (diffuse/normal/roughness/AO/displacement),
        // generate mipmap chains, and stabilise tone-mapping for the first recorded frame.
        // These renders also populate the shadow depth maps with PCFSoft data.
        for (let i = 0; i < 60; i++) {
          this.renderer.render(this.scene, this.camera);
          if (i % 8 === 7) {
            // Two-frame yield (32ms ≈ 2×16ms) — lets the browser flush pending GPU
            // texture upload commands, DMA transfers, and driver-side shader caching.
            await new Promise<void>(r => setTimeout(r, 32));
          }
        }
        // Final 100ms yield to let the GPU drain its command queue.
        await new Promise<void>(r => setTimeout(r, 100));

        // Freeze shadow maps if the cue is static (no spin) — shadows don't change
        // when only the camera moves, so skipping the shadow depth pass every frame
        // saves one full render pass per shadow light.
        const hasCueSpin = (config.cueConfig.spinSpeed > 0) || ((config.cueConfig.spinSpeedX || 0) > 0);
        if (!hasCueSpin) {
          this.renderer.shadowMap.autoUpdate = false;
        }

        this._startStudioRecordingLoop(config, dims, onProgress, resolve, reject);
      }).catch(reject);
    });
  }

  private _startStudioRecordingLoop(
    config: VideoStudioConfig,
    dims: { readonly width: number; readonly height: number; readonly bitrate: number; readonly fps: number },
    onProgress: ((p: number) => void) | undefined,
    resolve: (blob: Blob) => void,
    reject: (err: Error) => void
  ) {
    this.stopVideoPreview();

    // Reset camera to the recorded start position. The warmup renders in startStudioRecording
    // run with async yields, during which stale orbit event handlers could have moved the camera.
    // This guarantees the canvas shows the correct start frame when mediaRecorder.start() fires.
    this.setCameraFromKeyframe(config.cameraStart);

    // Diagnostic: log actual values used for this recording
    const _diagEnd = applyDirection(config.cameraStart, config.cameraEnd, "xyz");
    const _diagDur = computeVideoDuration(config.cameraStart, config.cameraEnd, config.cameraSpeed, "xyz");
    console.log('[VideoStudio] recording', {
      start: { x: config.cameraStart.x?.toFixed(2), y: config.cameraStart.y?.toFixed(2), z: config.cameraStart.z?.toFixed(2) },
      end: { x: _diagEnd.x?.toFixed(2), y: _diagEnd.y?.toFixed(2), z: _diagEnd.z?.toFixed(2) },
      speed: config.cameraSpeed,
      duration: `${_diagDur.toFixed(1)}s`,
    });

    // Hide all helpers/gizmos so they don't appear in the recorded video
    this.setHelpersVisible(false);

    // ── Scene graph freeze ────────────────────────────────────────────────────
    // Disabling scene.matrixWorldAutoUpdate skips the full scene-graph traversal
    // inside WebGLRenderer.render(). Studio objects are all static; only the
    // camera needs updating each frame — THREE.js handles it automatically via
    // the "camera.parent===null && camera.matrixWorldAutoUpdate===true" path.
    // Spinning single cues are refreshed manually in renderFrame below.
    this.scene.matrixWorldAutoUpdate = false;
    const frozenObjects: THREE.Object3D[] = ([
      this.backdrop,
      this.shadowFloor,
      this.wallShadowPlane,
      this.tableSurface,
      this.studioCornerFill,
      this.frameShadowFloor,
      this.frameWallBackdrop,
      this.frameTableBackdrop,
      ...this.backgroundLayerMeshes,
      ...this.wallFramePlanes,
      ...this.tableFramePlanes,
      ...this.instancedMeshes,
      ...this.hdriShadowLights.map(l => l.light as THREE.Object3D),
      this.frameShadowLight as THREE.Object3D | null,
    ] as (THREE.Object3D | null)[]).filter((o): o is THREE.Object3D => !!o);
    for (const obj of frozenObjects) {
      obj.matrixAutoUpdate = false;
      obj.frustumCulled = false;
    }

    // NOTE: cue instances were already set up (with correct initial spin) during the
    // warmup phase in startStudioRecording → setupStudioFromStudioConfig. Re-creating
    // them here would dispose the warmed GPU buffers and allocate cold new ones,
    // causing a buffer-upload stall on the very first recorded frames.

    // Save pre-recording spin state so we can restore it after recording
    const savedSpinY = config.cueConfig.spinY || 0;
    const savedSpinX = config.cueConfig.spinX || 0;
    const savedSpinZ = config.cueConfig.spinZ || 0;

    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();

    // Camera moves directly from start to end (full xyz interpolation)
    const effectiveEnd = applyDirection(config.cameraStart, config.cameraEnd, "xyz");

    // Compute duration from path + speed
    const duration = computeVideoDuration(config.cameraStart, config.cameraEnd, config.cameraSpeed, "xyz");
    const easingFn = createEasingFunction(config.easing);

    // Compute wall-clock duration in ms before MediaRecorder setup so the onstop closure can use it
    const durationMs = duration * 1000;

    // ── Why encoder warmup is required ─────────────────────────────────────────
    // The hardware video encoder (VideoToolbox on macOS, VP9 on Linux/Windows) starts
    // a cold session every time mediaRecorder.start() is called. Startup takes 1–3 s:
    //   • VPU resource allocation
    //   • SPS/PPS parameter-set generation
    //   • First I-frame encoding (large, expensive)
    //   • Rate-control algorithm calibration
    // If the animation starts at the same moment as the encoder, the VPU competes with
    // the GPU for resources and produces dropped frames, encoding artefacts, and
    // unstable bitrate — visible as "flashing and lagging" in the first 1–3 s.
    //
    // Fix: start the encoder with no timeslice and render PRE_ROLL_MS of the static
    // start frame (tracked by wall-clock performance.now()) so it fully initialises
    // before camera motion begins. In onstop, all chunks are combined, and the first
    // cluster at t >= PRE_ROLL_MS is found via _findClusterOffsetAtTime; everything
    // before it is discarded, timestamps are re-zeroed, and Duration is patched.
    const PRE_ROLL_MS = 2500; // wall-clock pre-roll for encoder warm-up

    // Cap captureStream at 60 fps regardless of quality preset.
    // Chrome has a known bug (chromium #639939) where captureStream at >60 fps on high-refresh
    // displays (e.g. 120 Hz macOS) writes WebM frame timestamps that are 5× too large, making
    // the video appear 5× longer than the wall-clock recording time. 60 fps produces correct
    // timestamps on all platforms. Preview can still run at 120 fps for smooth UX.
    const RECORD_FPS = Math.min(dims.fps, 60);

    const stream = this.renderer.domElement.captureStream(RECORD_FPS);
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: getSupportedMimeType(),
      videoBitsPerSecond: dims.bitrate,
    });
    this.recordedChunks = [];

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };

    type ShadowWithMap = THREE.LightShadow & { map: THREE.WebGLRenderTarget | null };
    const restoreRecordingState = () => {
      // Cancel any in-flight animation RAF before restoring state.
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.setHelpersVisible(true);
      // Restore all recording GPU optimisations so preview quality is unaffected.
      this.renderer.shadowMap.autoUpdate = true;
      this.renderer.shadowMap.type = this._recordingSavedShadowType ?? THREE.VSMShadowMap;
      // Restore scene graph auto-update and per-object properties.
      this.scene.matrixWorldAutoUpdate = true;
      for (const obj of frozenObjects) {
        obj.matrixAutoUpdate = true;
        obj.frustumCulled = true;
      }
      const restoreShadowMap = (shadow: THREE.LightShadow) => {
        shadow.mapSize.set(2048, 2048);
        shadow.map?.dispose();
        (shadow as ShadowWithMap).map = null;
      };
      for (const { light } of this.hdriShadowLights) restoreShadowMap(light.shadow);
      if (this.frameShadowLight) restoreShadowMap(this.frameShadowLight.shadow);
      // Restore pre-recording spin state to prevent rotation drift.
      if (this.currentCueConfig) {
        this.currentCueConfig = {
          ...this.currentCueConfig,
          spinY: savedSpinY,
          spinX: savedSpinX,
          spinZ: savedSpinZ,
        };
      }
      if (this.clonedModel) {
        this.clonedModel.rotation.set(savedSpinX, savedSpinY, savedSpinZ);
      }
      if (this.instancedMeshes.length > 0 && this.currentCueConfig) {
        this.setupCueInstances(this.currentCueConfig);
      }
    };

    this.mediaRecorder.onstop = async () => {
      restoreRecordingState();

      let outBlob: Blob;
      const finalDurationMs = durationMs;

      // Combine all chunks into one buffer
      const allBufs = await Promise.all(this.recordedChunks.map(c => c.arrayBuffer()));
      const totalSize = allBufs.reduce((s, b) => s + b.byteLength, 0);
      const combined = new Uint8Array(totalSize);
      let writeOff = 0;
      for (const buf of allBufs) { combined.set(new Uint8Array(buf), writeOff); writeOff += buf.byteLength; }
      const combinedBuf = combined.buffer;

      console.log('[VideoStudio] onstop: chunks=%d totalSize=%dKB duration=%.1fs',
        this.recordedChunks.length, Math.round(totalSize / 1024), finalDurationMs / 1000);

      // Extract EBML structural header (everything before first cluster)
      const rawHeaderBuf = this._extractWebmHeader(combinedBuf);

      // Find where animation clusters start (first cluster at t >= PRE_ROLL_MS)
      const animClusterOffset = this._findClusterOffsetAtTime(combinedBuf, PRE_ROLL_MS);

      console.log('[VideoStudio] header=%dB animClusterOffset=%d', rawHeaderBuf.byteLength, animClusterOffset);

      if (animClusterOffset > 0) {
        const animBuf = combinedBuf.slice(animClusterOffset);
        const firstTc = this._getFirstClusterTimecode(animBuf);
        const adjustBy = firstTc > 0 ? firstTc : PRE_ROLL_MS;
        console.log('[VideoStudio] firstTc=%dms adjustBy=%dms animBuf=%dKB', firstTc, adjustBy, Math.round(animBuf.byteLength / 1024));
        const adjAnim = this._adjustWebmClusterTimecodes(animBuf, adjustBy);
        const headerBuf = this._patchEbmlDuration(rawHeaderBuf, finalDurationMs);
        outBlob = new Blob([headerBuf, adjAnim], { type: getSupportedMimeType() });
        console.log('[VideoStudio] trimmed blob size=%dKB (header=%dB anim=%dKB)',
          Math.round((headerBuf.byteLength + adjAnim.byteLength) / 1024),
          headerBuf.byteLength, Math.round(adjAnim.byteLength / 1024));
      } else {
        // Fallback: no pre-roll boundary found — use full combined data
        console.warn('[VideoStudio] animClusterOffset not found, using raw chunks as fallback');
        outBlob = new Blob(this.recordedChunks, { type: getSupportedMimeType() });
      }

      // fixWebmDuration: only patches Duration if currently <= 0 in the blob.
      // Our _patchEbmlDuration already wrote finalDurationMs, so this is a safety
      // net for the rare case where the Duration element wasn't found.
      const fixedBlob = await fixWebmDuration(outBlob, finalDurationMs, { logger: false });
      console.log('[VideoStudio] final blob size=%dKB mimeType=%s', Math.round(fixedBlob.size / 1024), getSupportedMimeType());
      resolve(fixedBlob);
    };
    this.mediaRecorder.onerror = () => {
      restoreRecordingState();
      reject(new Error('Recording failed'));
    };

    // Reference period for spin speed normalisation (0.02 rad/frame at 60fps = 1.2 rad/s).
    const SPIN_REF_MS = 1000 / 60;
    // Each video frame spans exactly FRAME_INTERVAL_MS of wall time.
    const FRAME_INTERVAL_MS = 1000 / RECORD_FPS;
    // Constant spin delta per rendered frame — guaranteed consistent speed in the video.
    const spinPerFrame = FRAME_INTERVAL_MS / SPIN_REF_MS;

    // Phase tracking
    let loopStart = -1;
    let frameCount = -1;
    let preRollStart = -1;       // wall-clock time when pre-roll began
    let animationStarted = false; // true once pre-roll finishes
    let recordingStartTime = -1;

    const start = config.cameraStart;
    const end = effectiveEnd;
    const cue = config.cueConfig;
    // Whether the cue spins — used in renderFrame to trigger manual world-matrix update.
    const hasAnySpin = (cue.spinSpeed > 0) || ((cue.spinSpeedX || 0) > 0);

    // Pre-allocate camera keyframe object — mutated in-place each frame to avoid GC.
    const kf = {
      x: start.x, y: start.y, z: start.z,
      rotationX: start.rotationX ?? 0,
      rotationY: start.rotationY ?? 0,
      rotationZ: start.rotationZ ?? 0,
    };
    const startRX = start.rotationX ?? 0, endRX = end.rotationX ?? 0;
    const startRY = start.rotationY ?? 0, endRY = end.rotationY ?? 0;
    const startRZ = start.rotationZ ?? 0, endRZ = end.rotationZ ?? 0;

    const renderFrame = (t: number) => {
      // Mutate pre-allocated object to avoid per-frame heap allocation.
      kf.x = start.x + (end.x - start.x) * t;
      kf.y = start.y + (end.y - start.y) * t;
      kf.z = start.z + (end.z - start.z) * t;
      kf.rotationX = startRX + (endRX - startRX) * t;
      kf.rotationY = startRY + (endRY - startRY) * t;
      kf.rotationZ = startRZ + (endRZ - startRZ) * t;
      // Lightweight camera update for recording: skip gizmo sync, helper update,
      // and updateProjectionMatrix (FOV is constant throughout recording).
      this.camera.position.set(kf.x, kf.y, kf.z);
      this.camera.rotation.set(kf.rotationX, kf.rotationY, kf.rotationZ);
      // scene.matrixWorldAutoUpdate=false → THREE.js only auto-updates the camera
      // (root object, matrixWorldAutoUpdate=true). For a spinning single cue we must
      // manually propagate rotation → local matrix → world matrix before rendering.
      if (hasAnySpin && this.clonedModel && this.instancedMeshes.length === 0) {
        this.clonedModel.updateMatrixWorld(true);
      }
      this.renderer.render(this.scene, this.camera);
    };

    const animate = (timestamp: number) => {
      const now = performance.now();

      // Throttle to exactly RECORD_FPS using integer frame counting.
      // This eliminates the captureStream sampling race: renders and captureStream
      // samples are in lock-step at the same rate, so every sampled frame is fresh
      // and spin advances by exactly spinPerFrame per video frame (constant velocity).
      if (loopStart < 0) loopStart = timestamp;
      const targetFrame = Math.floor((timestamp - loopStart) / FRAME_INTERVAL_MS);
      if (targetFrame <= frameCount) {
        this.animationFrameId = requestAnimationFrame(animate);
        return;
      }
      frameCount = targetFrame;

      // ── Phase 1: Pre-roll (static frame, encoder warm-up) ──────────────────
      // Render static start frame for PRE_ROLL_MS wall-clock time so the encoder
      // completes its cold-start sequence (VPU init, I-frame, rate-control) before
      // camera motion begins. Pre-roll clusters are trimmed in onstop.
      if (!animationStarted) {
        if (preRollStart < 0) preRollStart = now;
        renderFrame(easingFn(0));
        onProgress?.(0);
        if (now - preRollStart < PRE_ROLL_MS) {
          this.animationFrameId = requestAnimationFrame(animate);
          return;
        }
        // Pre-roll done — encoder is warm. Start animation.
        animationStarted = true;
        recordingStartTime = now;
        // Fall through: render first animation frame in this same rAF tick.
      }

      // ── Phase 2: Animation recording ───────────────────────────────────────
      const elapsedMs = now - recordingStartTime;

      if (this.isDisposed || elapsedMs >= durationMs) {
        renderFrame(easingFn(1));
        onProgress?.(100);
        this.animationFrameId = null;
        this.mediaRecorder?.stop();
        return;
      }

      const progress = Math.min(1, elapsedMs / durationMs);
      onProgress?.(Math.round(progress * 100));

      // Advance cue spin by exactly one frame's worth (constant angular velocity).
      const hasSpinY = cue.spinSpeed > 0;
      const hasSpinX = (cue.spinSpeedX || 0) > 0;
      if (hasSpinY || hasSpinX) {
        this.spinCueInstances(
          hasSpinY ? cue.spinSpeed * 0.02 * spinPerFrame : 0,
          hasSpinX ? (cue.spinSpeedX || 0) * 0.02 * spinPerFrame : 0
        );
      }

      renderFrame(easingFn(progress));
      this.animationFrameId = requestAnimationFrame(animate);
    };

    // Start encoding with no timeslice — single/chunked output on stop(), cleanest for post-trim.
    this.mediaRecorder.start();
    this.animationFrameId = requestAnimationFrame(animate);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WebM warmup-trim helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Return the absolute timecode (ms) of the first Cluster element in the buffer,
   * or -1 if no cluster is found. Used to self-calibrate the timestamp offset that
   * must be subtracted from all animation clusters regardless of whether Chrome
   * restarted the WebM timeline from 0 or continued from the pre-roll period.
   */
  private _getFirstClusterTimecode(buffer: ArrayBuffer): number {
    const data = new Uint8Array(buffer);
    for (let i = 0; i < data.length - 20; i++) {
      if (data[i] === 0x1F && data[i + 1] === 0x43 && data[i + 2] === 0xB6 && data[i + 3] === 0x75) {
        for (let j = i + 4; j < Math.min(i + 25, data.length - 5); j++) {
          if (data[j] === 0xE7) {
            const szByte = data[j + 1];
            if (szByte >= 0x81 && szByte <= 0x84) {
              const numBytes = szByte & 0x7F;
              let tc = 0;
              for (let b = 0; b < numBytes; b++) tc = (tc << 8) | data[j + 2 + b];
              return tc;
            }
            return -1;
          }
        }
        return -1;
      }
    }
    return -1;
  }

  /**
   * Return the timecode (ms) of the LAST Cluster element in the buffer, or -1.
   * Used to compute the actual content end time after timecode adjustment so that
   * the Duration header is set to match content exactly (preventing end-freeze gaps).
   */
  private _getLastClusterTimecode(buffer: ArrayBuffer): number {
    const data = new Uint8Array(buffer);
    let lastTc = -1;
    for (let i = 0; i < data.length - 20; i++) {
      if (data[i] === 0x1F && data[i + 1] === 0x43 && data[i + 2] === 0xB6 && data[i + 3] === 0x75) {
        for (let j = i + 4; j < Math.min(i + 25, data.length - 5); j++) {
          if (data[j] === 0xE7) {
            const szByte = data[j + 1];
            if (szByte >= 0x81 && szByte <= 0x84) {
              const numBytes = szByte & 0x7F;
              let tc = 0;
              for (let b = 0; b < numBytes; b++) tc = (tc << 8) | data[j + 2 + b];
              lastTc = tc;
            }
            break;
          }
        }
        i += 3;
      }
    }
    return lastTc;
  }

  /**
   * Scan WebM clusters and return the byte offset of the FIRST cluster whose
   * Timecode element value is >= targetMs. Returns -1 if not found.
   * Used to trim the pre-roll phase from a continuous recording.
   */
  private _findClusterOffsetAtTime(buffer: ArrayBuffer, targetMs: number): number {
    const data = new Uint8Array(buffer);
    for (let i = 0; i < data.length - 20; i++) {
      if (data[i] === 0x1F && data[i + 1] === 0x43 && data[i + 2] === 0xB6 && data[i + 3] === 0x75) {
        for (let j = i + 4; j < Math.min(i + 25, data.length - 5); j++) {
          if (data[j] === 0xE7) {
            const szByte = data[j + 1];
            if (szByte >= 0x81 && szByte <= 0x84) {
              const numBytes = szByte & 0x7F;
              let tc = 0;
              for (let b = 0; b < numBytes; b++) tc = (tc << 8) | data[j + 2 + b];
              if (tc >= targetMs) return i;
            }
            break;
          }
        }
        i += 3;
      }
    }
    return -1;
  }

  /**
   * Return only the WebM container header bytes
   * (EBML + Segment element open tag +
   * SeekHead + Info + Tracks) from the raw bytes of a MediaRecorder chunk, stopping
   * just before the first VERIFIED Cluster element.
   *
   * IMPORTANT: The naive scan for the 4-byte cluster ID (0x1F 0x43 0xB6 0x75) will
   * produce false positives inside the VP9/VP8 codec private data stored in the Tracks
   * element. A false match truncates the header before Tracks is written, leaving the
   * decoder with no codec info → 20 MB file that cannot play.
   *
   * Fix: after finding the 4-byte cluster ID pattern, verify it is a real cluster by
   * checking that the Timecode element (0xE7 + valid VINT size) appears within the
   * first 25 bytes of the alleged cluster — exactly the same verification used by
   * _findClusterOffsetAtTime. Codec private data will not contain this pattern at the
   * right position, so false positives are eliminated.
   */
  private _extractWebmHeader(buffer: ArrayBuffer): ArrayBuffer {
    const data = new Uint8Array(buffer);
    for (let i = 0; i < data.length - 20; i++) {
      if (data[i] === 0x1F && data[i + 1] === 0x43 && data[i + 2] === 0xB6 && data[i + 3] === 0x75) {
        // Verify this is a real cluster: Timecode element (0xE7) must appear within
        // 25 bytes with a valid VINT size byte (0x81–0x84 = 1–4 data bytes).
        for (let j = i + 4; j < Math.min(i + 25, data.length - 3); j++) {
          if (data[j] === 0xE7) {
            const szByte = data[j + 1];
            if (szByte >= 0x81 && szByte <= 0x84) {
              return buffer.slice(0, i); // Real cluster confirmed — header ends here
            }
            break; // 0xE7 found but invalid size — likely false positive, keep scanning
          }
        }
        // No valid Timecode found within 25 bytes → false positive (e.g. codec private
        // data). Continue scanning for the real first cluster.
      }
    }
    return buffer; // no cluster found — return full buffer as fallback
  }

  /**
   * Write the correct Duration into a WebM EBML header buffer.
   *
   * Chrome's MediaRecorder sometimes writes a non-zero Duration into the EBML Info
   * section of the warmup blob (encoding the warmup window length, not the animation
   * duration). The fix-webm-duration library won't overwrite a Duration that is > 0,
   * so we patch the bytes directly before blob reconstruction.
   *
   * EBML Duration element layout:
   *   byte 0: 0x44   \
   *   byte 1: 0x89   / 2-byte element ID
   *   byte 2: 0x88   — size VINT: 8 bytes (double-precision float)
   *   bytes 3–10: IEEE 754 big-endian double — the duration value in ms
   *   (Some Chrome builds emit a 4-byte float: size byte 0x84, bytes 3–6.)
   */
  private _patchEbmlDuration(buffer: ArrayBuffer, durationMs: number): ArrayBuffer {
    const data = new Uint8Array(buffer.slice(0)); // mutable copy
    for (let i = 0; i < data.length - 3; i++) {
      if (data[i] === 0x44 && data[i + 1] === 0x89) {
        const szByte = data[i + 2];
        if (szByte === 0x88) {
          // 8-byte IEEE 754 double
          const view = new DataView(data.buffer, i + 3, 8);
          view.setFloat64(0, durationMs, false /* big-endian */);
          return data.buffer;
        } else if (szByte === 0x84) {
          // 4-byte IEEE 754 float
          const view = new DataView(data.buffer, i + 3, 4);
          view.setFloat32(0, durationMs, false /* big-endian */);
          return data.buffer;
        }
      }
    }
    return buffer; // Duration element not found — return original (fixWebmDuration will add it)
  }

  /**
   * Re-zero WebM cluster timestamps by subtracting subtractMs from every Cluster
   * Timecode element in the given raw bytes. This is needed after trimming the
   * encoder-warmup chunk: the animation clusters were timestamped starting at
   * PRE_ROLL_MS in the original recording timeline and must be shifted to
   * start at 0 ms so that the final video plays from the beginning.
   *
   * Chrome's MediaRecorder always uses the EBML "unknown" size VINT (8 bytes:
   * 0x01 FF FF FF FF FF FF FF) for Cluster elements in live recordings. The
   * Cluster Timecode element (ID 0xE7) therefore appears within the first ~25
   * bytes of every cluster, making it safe to scan for without parsing the full
   * EBML structure.
   */
  private _adjustWebmClusterTimecodes(buffer: ArrayBuffer, subtractMs: number): ArrayBuffer {
    const data = new Uint8Array(buffer.slice(0)); // mutable copy
    for (let i = 0; i < data.length - 20; i++) {
      // Cluster element ID: 0x1F 0x43 0xB6 0x75
      if (data[i] === 0x1F && data[i + 1] === 0x43 && data[i + 2] === 0xB6 && data[i + 3] === 0x75) {
        // Scan the next 25 bytes for the Timecode element (ID = 0xE7).
        for (let j = i + 4; j < Math.min(i + 25, data.length - 5); j++) {
          if (data[j] === 0xE7) {
            // data[j+1] is the VINT-encoded size of the Timecode value.
            // Chrome uses a 1-byte VINT here: 0x81 = 1 data byte, 0x82 = 2, etc.
            const szByte = data[j + 1];
            if (szByte >= 0x81 && szByte <= 0x84) {
              const numBytes = szByte & 0x7F; // strip the leading 1-bit of the VINT
              // Read big-endian timecode value
              let tc = 0;
              for (let b = 0; b < numBytes; b++) tc = (tc << 8) | data[j + 2 + b];
              const newTc = Math.max(0, tc - subtractMs);
              // Write back big-endian
              for (let b = 0; b < numBytes; b++) {
                data[j + 2 + (numBytes - 1 - b)] = (newTc >> (b * 8)) & 0xFF;
              }
            }
            break; // Timecode is always the first element in a cluster — done
          }
        }
        i += 3; // advance past the 4-byte cluster ID (loop body adds 1 more)
      }
    }
    return data.buffer;
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

  /** Returns whether a continuous live preview loop is currently active. */
  isLivePreviewRunning(): boolean {
    return this.animationFrameId !== null;
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
    this.camera.updateMatrixWorld(true);
    if (this.cameraHelper) this.cameraHelper.update();

    // Minimap: render camera view to offscreen target every N frames
    if (this._minimapCanvas && this.isSceneView) {
      this._minimapFrameCount++;
      if (this._minimapFrameCount >= ExtractorSceneManager.MINIMAP_INTERVAL) {
        this._minimapFrameCount = 0;
        this._updateMinimapInternal();
      }
    }

    // Preview: render production camera view to square offscreen target every N frames
    if (this._previewCanvas && this.isSceneView) {
      this._previewFrameCount++;
      if (this._previewFrameCount >= ExtractorSceneManager.PREVIEW_INTERVAL) {
        this._previewFrameCount = 0;
        this._updatePreviewInternal();
      }
    }

    const cam = this.isSceneView && this.godCamera ? this.godCamera : this.camera;
    this.renderer.render(this.scene, cam);
  }

  /** Register a canvas to receive live production-camera preview (square, for shadow simulator) */
  setPreviewCanvas(canvas: HTMLCanvasElement | null, size = 512): void {
    // Dispose any previously allocated render target (no longer used)
    if (this._previewTarget) {
      this._previewTarget.dispose();
      this._previewTarget = null;
      this._previewBuf = null;
    }
    this._previewCanvas = canvas;
    if (canvas) {
      this._previewSize = size;
    }
  }

  /** Internal: render production camera to main WebGL canvas, copy via drawImage to 2D preview canvas.
   *  Uses preserveDrawingBuffer for a GPU-accelerated blit — no CPU readback, no pipeline stall. */
  private _updatePreviewInternal(): void {
    const canvas = this._previewCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = this._previewSize;

    // Hide ALL editor helpers (HDRI lights, camera helper, camera gizmo)
    this.setHelpersVisible(false);

    // Hide TransformControls gizmos (arrows, rings, planes)
    const hiddenObjs: THREE.Object3D[] = [];
    this.scene.traverse((obj) => {
      if (obj.type.startsWith('TransformControls') || (obj as any).isTransformControls) {
        if (obj.visible) { hiddenObjs.push(obj); obj.visible = false; }
      }
    });

    // Square aspect for production camera
    const savedAspect = this.camera.aspect;
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();

    // Render directly to the main WebGL canvas (preserveDrawingBuffer: true)
    this.renderer.render(this.scene, this.camera);

    // Clear before blitting so transparent frames don't bleed old opaque pixels
    ctx.clearRect(0, 0, size, size);
    // GPU-accelerated blit to 2D preview canvas — drawImage scales automatically
    ctx.drawImage(this.renderer.domElement, 0, 0, size, size);

    // Restore
    this.camera.aspect = savedAspect;
    this.camera.updateProjectionMatrix();
    if (this.isSceneView) this.setHelpersVisible(true);
    for (const obj of hiddenObjs) obj.visible = true;
  }

  /** Register a canvas element to receive minimap camera view updates */
  setMinimapCanvas(canvas: HTMLCanvasElement | null): void {
    this._minimapCanvas = canvas;
    if (canvas && !this._minimapTarget) {
      const { MINIMAP_W, MINIMAP_H } = ExtractorSceneManager;
      this._minimapTarget = new THREE.WebGLRenderTarget(MINIMAP_W, MINIMAP_H);
      this._minimapBuf = new Uint8Array(MINIMAP_W * MINIMAP_H * 4);
    }
    if (!canvas) {
      this._minimapTarget?.dispose();
      this._minimapTarget = null;
      this._minimapBuf = null;
    }
  }

  /** Internal: render camera view to WebGLRenderTarget then copy to 2D canvas */
  private _updateMinimapInternal(): void {
    const canvas = this._minimapCanvas;
    const target = this._minimapTarget;
    const buf = this._minimapBuf;
    if (!canvas || !target || !buf) return;

    const { MINIMAP_W, MINIMAP_H } = ExtractorSceneManager;

    // Hide scene-view helpers
    const helperVis = this.cameraHelper?.visible ?? false;
    const gizmoVis = this.cameraGizmo?.visible ?? false;
    if (this.cameraHelper) this.cameraHelper.visible = false;
    if (this.cameraGizmo) this.cameraGizmo.visible = false;

    // Adjust camera aspect for minimap
    const savedAspect = this.camera.aspect;
    this.camera.aspect = MINIMAP_W / MINIMAP_H;
    this.camera.updateProjectionMatrix();

    // Render to offscreen target (no main canvas resize)
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);

    // Read pixels and draw to 2D canvas
    this.renderer.readRenderTargetPixels(target, 0, 0, MINIMAP_W, MINIMAP_H, buf);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const imageData = ctx.createImageData(MINIMAP_W, MINIMAP_H);
      // WebGL readPixels is bottom-up; flip rows for 2D canvas (top-down)
      for (let y = 0; y < MINIMAP_H; y++) {
        const srcRow = (MINIMAP_H - 1 - y) * MINIMAP_W * 4;
        const dstRow = y * MINIMAP_W * 4;
        imageData.data.set(buf.subarray(srcRow, srcRow + MINIMAP_W * 4), dstRow);
      }
      ctx.putImageData(imageData, 0, 0);
    }

    // Restore camera aspect and helpers
    this.camera.aspect = savedAspect;
    this.camera.updateProjectionMatrix();
    if (this.cameraHelper) this.cameraHelper.visible = helperVis;
    if (this.cameraGizmo) this.cameraGizmo.visible = gizmoVis;
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
   * Capture a clean production-camera frame: hides all helpers/gizmos,
   * renders with square aspect (1:1), then restores. Matches the live preview output.
   */
  captureCleanFrame(size: number, format: 'png' | 'jpeg' | 'webp' = 'png', transparent = false): string {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';

    // Hide ALL editor helpers
    this.setHelpersVisible(false);

    // Hide TransformControls
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((obj) => {
      if (obj.type.startsWith('TransformControls') || (obj as any).isTransformControls) {
        if (obj.visible) { hidden.push(obj); obj.visible = false; }
      }
    });

    // Transparent mode: clear background and hide wall/table surfaces
    const prevBg = this.scene.background;
    if (transparent) {
      this.scene.background = null;
      this.setWallsVisible(false);
    }

    // Save state
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevAspect = this.camera.aspect;
    const prevPixelRatio = this.renderer.getPixelRatio();

    // Render at requested size with square aspect
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);

    const dataUrl = this.renderer.domElement.toDataURL(mimeType);

    // Restore
    this.renderer.setPixelRatio(prevPixelRatio);
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    if (transparent) {
      this.scene.background = prevBg;
      this.setWallsVisible(true);
    }
    if (this.isSceneView) this.setHelpersVisible(true);
    for (const obj of hidden) obj.visible = true;

    return dataUrl;
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

    // Hide all helpers/gizmos so they don't appear in the recorded video
    this.setHelpersVisible(false);

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
      this.setHelpersVisible(true);
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

    // ── Wall-clock based timing ──
    // Progress and stop condition are driven by elapsed real time so that every device
    // produces a video of the same duration with the same camera/rotation speed,
    // regardless of GPU rendering throughput.
    const durationMs = config.duration * 1000;
    const recordingStartTime = performance.now();

    const animate = (timestamp: number) => {
      void timestamp; // wall-clock timing is used; rAF timestamp only identifies the tick
      const elapsedMs = performance.now() - recordingStartTime;

      if (this.isDisposed || elapsedMs >= durationMs) {
        this.animationFrameId = null;
        this.mediaRecorder?.stop();
        return;
      }

      // No manual throttle — render every rAF tick so captureStream(fps) always has a
      // fresh canvas frame to sample. captureStream self-limits the encoded output to
      // config.fps; the drift-corrected throttle previously caused a just-below-threshold
      // skip on high-refresh displays that produced irregular frame gaps (stutters).

      const progress = Math.min(1, elapsedMs / durationMs);
      onProgress?.(Math.round(progress * 100));

      // Cue spin based on elapsed wall-clock time for device-independent rotation speed
      const elapsedSec = elapsedMs / 1000;
      this.model!.rotation.y = elapsedSec * config.rotationSpeed;

      // Camera pans right along cue — cameraDollySpeed controls fraction covered per video
      const dollySpeed = config.cameraDollySpeed ?? 0.15;
      const camX = camStartX + (camEndX - camStartX) * Math.min(1, progress * dollySpeed);
      this.camera.position.set(camX, camY, camZ);
      this.camera.lookAt(camX, 0, 0);

      this.renderer.render(this.scene, this.camera);
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
    this.godCamera.position.set(0, 10.5, 22);
    this.godCamera.lookAt(0, 8.5, 0);

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

    if (mode === "camera") {
      // Camera view is now a static snapshot in the UI; disable any active orbit so
      // config-sync resets won't move the camera while the snapshot is displayed.
      if (this._cameraOrbit) {
        this._cameraOrbit.dispose();
        this._cameraOrbit = null;
      }
      this._cameraPlacementMode = true;
    } else {
      if (this._cameraOrbit) {
        this._cameraOrbit.dispose();
        this._cameraOrbit = null;
      }
      this._cameraPlacementMode = false;
    }
  }

  getViewMode(): "scene" | "camera" {
    return this.isSceneView ? "scene" : "camera";
  }

  getGodCamera(): THREE.PerspectiveCamera | null {
    return this.godCamera;
  }

  /** Return the world-space center of all simulator cue groups (for camera focus). */
  getSimulatorGroupsCenter(): THREE.Vector3 | null {
    if (this.simulatorCueGroups.length === 0) return null;
    const box = new THREE.Box3();
    for (const group of this.simulatorCueGroups) {
      box.expandByObject(group);
    }
    if (box.isEmpty()) return null;
    return box.getCenter(new THREE.Vector3());
  }

  /** Position studio camera from a CameraKeyframe — uses absolute world coordinates, preserves rotation */
  setCameraFromKeyframe(keyframe: CameraKeyframe): void {
    this.camera.position.set(keyframe.x, keyframe.y, keyframe.z);
    if (keyframe.rotationX !== undefined && keyframe.rotationY !== undefined && keyframe.rotationZ !== undefined) {
      this.camera.rotation.set(keyframe.rotationX, keyframe.rotationY, keyframe.rotationZ);
    }
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

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
        this.cameraTargetPos.y -= dy * sensitivity;
        break;
      case "z":
        this.cameraTargetPos.z -= dy * sensitivity;
        break;
      default:
        this.cameraTargetPos.x += dx * sensitivity;
        this.cameraTargetPos.y -= dy * sensitivity;
        break;
    }

    return { x: this.cameraTargetPos.x, y: this.cameraTargetPos.y, z: this.cameraTargetPos.z };
  }

  /** Clamp camera so it stays within studio bounds — currently unused, camera moves freely */
  // private clampCameraToStudioBounds(): void { ... }

  /** Convert current camera position to a CameraKeyframe (for "Set Start/End" buttons) */
  getCameraKeyframeFromPosition(): CameraKeyframe {
    const pos = this.camera.position;
    const rot = this.camera.rotation;
    return {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      rotationX: rot.x,
      rotationY: rot.y,
      rotationZ: rot.z,
    };
  }

  /** Enable/disable camera placement mode — while active, config syncs won't reset the camera position */
  setCameraPlacementMode(active: boolean): void {
    this._cameraPlacementMode = active;
  }

  /** Attach OrbitControls to the recording camera so the user can drag it into position */
  enableCameraOrbitMode(canvas: HTMLCanvasElement): void {
    // Cancel any pending placement mode expiry from a previous confirmation
    if (this._placementModeExpiryTimer) {
      clearTimeout(this._placementModeExpiryTimer);
      this._placementModeExpiryTimer = null;
    }
    this._cameraPlacementMode = true;
    if (this._cameraOrbit) {
      this._cameraOrbit.dispose();
      this._cameraOrbit = null;
    }

    // Save camera state: OrbitControls constructor calls update() with target=(0,0,0)
    // which executes camera.lookAt(0,0,0) and rotates the camera — we must restore it.
    const savedQuaternion = this.camera.quaternion.clone();
    const savedPosition = this.camera.position.clone();

    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const orbitTarget = this.camera.position.clone().addScaledVector(dir, 5);

    const orbit = new OrbitControls(this.camera, canvas);

    // Restore camera exactly as it was (constructor's lookAt(0,0,0) corrupted it)
    this.camera.position.copy(savedPosition);
    this.camera.quaternion.copy(savedQuaternion);
    this.camera.updateMatrixWorld(true);

    orbit.target.copy(orbitTarget);
    orbit.screenSpacePanning = true;
    orbit.enableDamping = false;
    orbit.update();
    this._cameraOrbit = orbit;
  }

  /** Whether camera orbit controls are currently active */
  hasCameraOrbitMode(): boolean {
    return this._cameraOrbit !== null;
  }

  /** Remove camera orbit controls */
  disableCameraOrbitMode(): void {
    if (this._cameraOrbit) {
      this._cameraOrbit.dispose();
      this._cameraOrbit = null;
    }
    this._cameraPlacementMode = false;
  }

  /** Schedule _cameraPlacementMode = false after a delay that outlasts the 100ms config-sync debounce */
  resetCameraPlacementModeAfterDelay(): void {
    if (this._placementModeExpiryTimer) clearTimeout(this._placementModeExpiryTimer);
    this._placementModeExpiryTimer = setTimeout(() => {
      this._cameraPlacementMode = false;
      this._placementModeExpiryTimer = null;
    }, 300);
  }

  /** Expose the recording/studio camera so external orbit controls can manipulate it */
  getRecordingCamera(): THREE.PerspectiveCamera {
    return this.camera;
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
    this.camera.updateMatrixWorld(true);
    this.cameraTargetPos.copy(this.camera.position);
    if (this.cameraHelper) this.cameraHelper.update();
  }

  /** Update smooth camera interpolation — call each frame */
  updateCameraSmooth(): void {
    if (!this.cameraSmoothEnabled) return;
    this.camera.position.lerp(this.cameraTargetPos, 0.15);

    this.camera.updateProjectionMatrix();
    if (this.cameraHelper) this.cameraHelper.update();
    this.syncCameraGizmo();
  }

  getCameraGizmo(): THREE.Group | null { return this.cameraGizmo; }

  getScene(): THREE.Scene { return this.scene; }

  getShadowPlaneBaseY(): number | null {
    if (!this.shadowFloor) return null;
    return this.shadowFloorBaseY;
  }

  getSelectableObjects(): THREE.Object3D[] {
    const objects: THREE.Object3D[] = [];
    if (this.cameraGizmo) objects.push(this.cameraGizmo);
    if (this.backdrop) objects.push(this.backdrop);
    if (this.tableSurface) objects.push(this.tableSurface);
    // shadowFloor is intentionally excluded — it is not selectable/interactive
    objects.push(...this.wallFramePlanes);
    objects.push(...this.tableFramePlanes);
    // HDRI light helpers
    for (const entry of this.hdriLightHelpers) {
      objects.push(entry.helper);
    }
    if (this.simulatorMode) {
      // Simulator: individual group clones (model is hidden)
      objects.push(...this.simulatorCueGroups);
    } else {
      if (this.model) objects.push(this.model);
      for (const im of this.instancedMeshes) objects.push(im);
    }
    return objects;
  }

  resize(width: number, height: number) {
    // Restore device pixel ratio for preview quality (recording sets it to 1)
    this.renderer.setPixelRatio(Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2
    ));
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

  /** Override studio camera aspect independently (e.g. for correct video-ratio preview framing). */
  setStudioCameraAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }


  // ---------------------------------------------------------------------------
  // Multi-cue InstancedMesh support
  // ---------------------------------------------------------------------------

  setupCueInstances(config: CueConfig): void {
    if (this.simulatorMode) return; // Simulator uses individual groups, not InstancedMesh
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
        this.clonedModel.rotation.set(config.spinX || 0, config.spinY || 0, config.spinZ || 0);
      }
      this.clonedModel.userData = { type: 'cue' };
      if (instances.length === 1) this._updateCueCenterForShadow(instances);
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
        dummy.rotation.set(
          inst.rotationX ?? (config.spinX || 0),
          inst.rotationY ?? (config.spinY || 0),
          inst.rotationZ ?? (config.spinZ || 0),
        );
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
    this._updateCueCenterForShadow(instances);
  }

  updateCueInstances(config: CueConfig): void {
    if (this.simulatorMode) return; // Simulator uses individual groups managed by setupSimulatorCueGroups
    this.currentCueConfig = config;

    if (!this.clonedModel) return;

    const instances = config.instances;

    if (instances.length <= 1 && this.instancedMeshes.length === 0) {
      // Single cue using regular model
      if (instances.length === 1) {
        const inst = instances[0];
        this.clonedModel.position.set(inst.positionX, inst.positionY, inst.positionZ);
        this.clonedModel.scale.setScalar(inst.scale);
        this.clonedModel.rotation.set(config.spinX || 0, config.spinY, config.spinZ || 0);
        this._updateCueCenterForShadow(instances);
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
        dummy.rotation.set(
          inst.rotationX ?? (config.spinX || 0),
          inst.rotationY ?? (config.spinY || 0),
          inst.rotationZ ?? (config.spinZ || 0),
        );
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
    }
    this._updateCueCenterForShadow(instances);
  }

  spinCueInstances(spinDeltaY: number, spinDeltaX: number = 0): void {
    if (!this.currentCueConfig) return;

    const instances = this.currentCueConfig.instances;
    // Mutate spin values in-place — avoid object spread allocation every frame.
    const currentY = (this.currentCueConfig.spinY || 0) + spinDeltaY;
    const currentX = (this.currentCueConfig.spinX || 0) + spinDeltaX;
    const currentZ = this.currentCueConfig.spinZ || 0;
    this.currentCueConfig.spinY = currentY;
    this.currentCueConfig.spinX = currentX;

    if (instances.length <= 1 && this.instancedMeshes.length === 0) {
      if (this.clonedModel) {
        this.clonedModel.rotation.set(currentX, currentY, currentZ);
      }
      return;
    }

    // Reuse pre-allocated dummy — avoid `new THREE.Object3D()` allocation every frame.
    const dummy = this._spinDummy;
    for (const im of this.instancedMeshes) {
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        dummy.position.set(inst.positionX, inst.positionY, inst.positionZ);
        dummy.scale.setScalar(inst.scale);
        dummy.rotation.set(currentX, currentY, currentZ);
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
    // In simulator mode, visibility is managed by setupSimulatorCueGroups — never restore it here
    if (this.clonedModel && !this.simulatorMode) {
      this.clonedModel.visible = true;
    }
  }

  // ─── Simulator mode: per-cue independent groups ───────────────────────────

  /** Call once on the Simulator's dedicated ESM to enable per-cue group mode. */
  enableSimulatorMode(): void {
    this.simulatorMode = true;
  }

  private clearSimulatorCueGroups(): void {
    for (const group of this.simulatorCueGroups) {
      this.scene.remove(group);
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          (child.material as THREE.Material).dispose?.();
        }
      });
    }
    this.simulatorCueGroups = [];
    // Dispose all per-instance surface texture overrides
    for (const tex of this.cueGroupSurfaceTextures.values()) {
      tex.dispose();
    }
    this.cueGroupSurfaceTextures.clear();
  }

  /** Build one independent THREE.Group per CueInstance. Each group is a deep-clone
   *  of the loaded model so it can be independently selected/transformed. */
  private buildSimulatorCueGroup(inst: CueInstance, config: CueConfig): THREE.Group {
    const source = this.clonedModel;
    if (!source) return new THREE.Group();
    const group = source.clone(true);
    // THREE.clone(true) shares material instances — clone them so each group has
    // independent materials and applySurfaceToSimulatorCueGroup doesn't bleed across groups.
    // Also re-apply bumper emissive shader mask because .clone() drops onBeforeCompile,
    // which would otherwise make the logo appear on all cylinder faces, not just the bottom.
    // For the top cap face disc (solid-color material, no original .map), explicitly apply
    // the logo with correct flipY=false; all other materials carry their logo via the clone chain.
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (Array.isArray(child.material)) {
        child.material = child.material.map((m: THREE.Material) => {
          const cloned = m.clone();
          const physMat = cloned as THREE.MeshPhysicalMaterial;
          if (physMat.emissiveMap && isRubberMaterial(physMat.name, child.name)) {
            applyBumperEmissiveShaderMask(physMat);
          }
          // Re-apply top cap face logo as emissive so it's always visible
          // regardless of envMap/lighting. Safe to call unconditionally —
          // emissive doesn't affect the existing diffuse map.
          if (isTopCapFaceMaterial(physMat.name)) {
            applyLogoToExistingMaterial(physMat, "topCapFace");
          }
          return cloned;
        });
      } else if (child.material) {
        const cloned = child.material.clone();
        const physMat = cloned as THREE.MeshPhysicalMaterial;
        if (physMat.emissiveMap && isRubberMaterial(physMat.name, child.name)) {
          applyBumperEmissiveShaderMask(physMat);
        }
        if (isTopCapFaceMaterial(physMat.name)) {
          applyLogoToExistingMaterial(physMat, "topCapFace");
        }
        child.material = cloned;
      }
    });
    group.position.set(inst.positionX, inst.positionY, inst.positionZ);
    group.scale.setScalar(inst.scale);
    group.rotation.set(
      inst.rotationX ?? (config.spinX || 0),
      inst.rotationY ?? (config.spinY || 0),
      inst.rotationZ ?? (config.spinZ || 0),
    );
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = false;
      }
    });
    return group;
  }

  setupSimulatorCueGroups(config: CueConfig): void {
    if (!this.simulatorMode) return;
    this.clearSimulatorCueGroups();
    this.clearInstancedMeshes();
    if (!this.clonedModel) return;

    // Build groups BEFORE hiding clonedModel — clone(true) copies the visible flag,
    // so if we hid the source first every cloned group would also be invisible.
    const instances = config.instances;
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const group = this.buildSimulatorCueGroup(inst, config);
      group.visible = true; // Ensure visible even if clonedModel is transitioning
      // Only set userData on the GROUP root — resolveHit walks .parent up to find it.
      // Setting it on children would cause TransformControls to attach to a child mesh instead.
      group.userData = { type: 'cue', cueIndex: i };
      this.simulatorCueGroups.push(group);
      this.scene.add(group);
    }

    // Hide the source model AFTER groups are built
    this.clonedModel.visible = false;

    this.currentCueConfig = config;
    // Re-apply current envMap to all new groups
    this.reapplyCurrentCueEnvMap();
    // Aim shadow lights at cue centroid
    this._updateCueCenterForShadow(instances);
  }

  /** Re-apply the currently active HDRI envMap to all simulator cue groups after rebuild.
   *  Uses scene.environment (set by HDRI load) as the envMap source. */
  private reapplyCurrentCueEnvMap(): void {
    const envMap = this.cueEnvRT?.texture ?? this.scene.environment;
    if (!envMap) return;
    const intensity = this.cueEnvIntensity;
    const applyEnv = (mat: THREE.Material) => {
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.envMap = envMap;
        mat.envMapIntensity = intensity;
        mat.needsUpdate = true;
      }
    };
    for (const group of this.simulatorCueGroups) {
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (Array.isArray(child.material)) {
          child.material.forEach(applyEnv);
        } else {
          applyEnv(child.material);
        }
      });
    }
  }

  updateSimulatorCueGroup(idx: number, posX: number, posY: number, posZ: number,
    rotX: number, rotY: number, rotZ: number, scale: number): void {
    const group = this.simulatorCueGroups[idx];
    if (!group) return;
    group.position.set(posX, posY, posZ);
    group.rotation.set(rotX, rotY, rotZ);
    group.scale.setScalar(scale);
    // Re-aim shadow lights at updated cue centroid
    const instances = this.simulatorCueGroups.map(g => ({ positionX: g.position.x, positionZ: g.position.z }));
    this._updateCueCenterForShadow(instances);
  }

  /**
   * Load a surface image from `surfaceUrl` and apply it as the diffuse map to the
   * body meshes of the simulator cue group at `idx`.  The previous override texture
   * (if any) is disposed before the new one is stored.
   */
  async applySurfaceToSimulatorCueGroup(idx: number, surfaceUrl: string): Promise<void> {
    const group = this.simulatorCueGroups[idx];
    if (!group) return;

    // Load the surface image at full quality (same URL as stored in DB)
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = surfaceUrl;
    });

    // Match SceneManager's adaptive texture size for full quality
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const deviceMemoryGB = (navigator as unknown as Record<string, number>).deviceMemory;
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);
    const texSize = (!isMobile && (deviceMemoryGB === undefined || deviceMemoryGB > 4)) ? 4096 : 2048;

    const canvas = document.createElement("canvas");
    canvas.width = texSize;
    canvas.height = texSize;
    canvas.getContext("2d")!.drawImage(img, 0, 0, texSize, texSize);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = maxAnisotropy;
    tex.needsUpdate = true;

    // Dispose previous override for this slot
    const prev = this.cueGroupSurfaceTextures.get(idx);
    if (prev) prev.dispose();
    this.cueGroupSurfaceTextures.set(idx, tex);

    // Apply to body materials only — skip rubber (bumper), top cap (joint cover),
    // and cylinder leather (wrap) so logos/bumps don't bleed onto those meshes
    const shouldSkip = (matName: string, meshName: string) =>
      isRubberMaterial(matName, meshName) ||
      isTopCapMaterial(matName, meshName) ||
      isCylinderLeatherMaterial(matName, meshName);

    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const mat = child.material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => {
          if (m instanceof THREE.MeshStandardMaterial && !shouldSkip(m.name, child.name)) {
            m.map = tex;
            m.needsUpdate = true;
          }
        });
      } else if (mat instanceof THREE.MeshStandardMaterial && !shouldSkip(mat.name, child.name)) {
        mat.map = tex;
        mat.needsUpdate = true;
      }
    });

    this.render();
  }

  /** Restore the original surface (from clonedModel) for the cue group at `idx`. */
  resetSimulatorCueGroupSurface(idx: number): void {
    const group = this.simulatorCueGroups[idx];
    const source = this.clonedModel;
    if (!group || !source) return;

    // Build a map of mesh name → original material map texture from the source model
    const origTextures = new Map<string, THREE.Texture | null>();
    source.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = Array.isArray(child.material) ? child.material[0] : child.material;
        origTextures.set(child.name, (mat as THREE.MeshStandardMaterial)?.map ?? null);
      }
    });

    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const origTex = origTextures.get(child.name) ?? null;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (m instanceof THREE.MeshStandardMaterial) {
          m.map = origTex;
          m.needsUpdate = true;
        }
      });
    });

    // Dispose + remove override entry
    const prev = this.cueGroupSurfaceTextures.get(idx);
    if (prev) prev.dispose();
    this.cueGroupSurfaceTextures.delete(idx);

    this.render();
  }

  dispose() {
    this.isDisposed = true;
    this.disableCameraOrbitMode();
    if (this._placementModeExpiryTimer) {
      clearTimeout(this._placementModeExpiryTimer);
      this._placementModeExpiryTimer = null;
    }
    this.stopLivePreview();
    this.stopRecording();
    this.clearStudioElements();
    this.clearInstancedMeshes();
    this.clearSimulatorCueGroups();

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

    // Clean up minimap
    this._minimapTarget?.dispose();
    this._minimapTarget = null;
    this._minimapCanvas = null;
    this._minimapBuf = null;

    // Clean up preview
    this._previewTarget?.dispose();
    this._previewTarget = null;
    this._previewCanvas = null;
    this._previewBuf = null;

    if (this.clonedModel) {
      this.scene.remove(this.clonedModel);
      this.disposeModel(this.clonedModel);
    }

    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
    }

    if (this.surfaceEnvRT) {
      this.surfaceEnvRT.dispose();
      this.surfaceEnvRT = null;
    }

    if (this.cueEnvRT) {
      this.cueEnvRT.dispose();
      this.cueEnvRT = null;
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

    this.clearFrameShadow();

    this.pmremGenerator.dispose();
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
