import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCameraPathSampler, getCameraPathPoints, getCameraSpanPoints } from './camera-path';
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
import type { VideoStudioConfig, CameraKeyframe, CameraPathConfig, CueConfig, CueInstance, BackgroundFrame, SurfaceConfig, CueHdriConfig, CornerFillConfig, LogoBackdropConfig } from '@/types/video-studio';
import { computeVideoDuration, createEasingFunction, applyDirection, isCameraFixed, VIDEO_QUALITY_PRESETS, GRADIENT_PRESETS, DEFAULT_CUE_HDRI, DEFAULT_CORNER_FILL, DEFAULT_FRAME_IMAGE_SCALE, clampFrameImageScale, frameImageTileSize, frameTileGrid, DEFAULT_LOGO_BACKDROP, DEFAULT_SCENE_BACKGROUND, WALL_WIDTH, WALL_HEIGHT, getRecordingDimensions } from '@/types/video-studio';
import type { DeterministicFrameSink } from '@/types/video-studio';
import { compositeSurfaceFrames, preloadFrameImages } from './background-compositor';
import { applyBumperEmissiveShaderMask, applyLogoToExistingMaterial } from './leather-material';
import { LogoBackdrop, resolveLogoBackdropUrl } from './logo-backdrop';

/**
 * How strongly the logo plate is drawn in scene view.
 *
 * Scene view is the authoring viewport: the plate is shown so its size and position can
 * be judged, but held back so it never hides the geometry being edited. The minimap and
 * the recorded video draw it at full strength.
 */
const SCENE_VIEW_BACKDROP_DIM = 0.45;
import { isRubberMaterial, isTopCapMaterial, isTopCapFaceMaterial, isCylinderLeatherMaterial } from './leather-config';
import { createWhiteImmuneMaterial, applySurfaceTint } from './studio-helpers';
import { StudioRoomEnvironment } from './studio-room-environment';
import { normalizeEnvironmentConfig } from '@/types/studio-environment';

/**
 * Material used by background frame planes. Unlit (Basic) when studio lights are
 * set to not influence surfaces, lit (Standard) when they are. Both expose the
 * `map` and `opacity` fields the frame-plane update paths rely on.
 */
/**
 * How far neighbouring tiles overlap, in canvas pixels.
 *
 * Two separate artefacts show up at a tile boundary and both need this:
 *
 *  1. Tile size is almost never a whole number of canvas pixels, so consecutive
 *     `drawImage` calls land on fractional boundaries. The rasteriser antialiases each
 *     tile's outer edge against what is already there, which leaves a one-pixel lighter
 *     line — the white hairlines between tiles.
 *  2. Even with perfect alignment, a photo's own edges rarely match, so the join reads
 *     as a straight line the eye immediately picks out of an organic texture.
 *
 * Overlapping by a few pixels removes (1) outright — there is no gap left to show
 * through — and gives (2) a band to cross-fade across.
 */
const TILE_OVERLAP_PX = 3;

/**
 * Quality floor for a surface texture that carries a background image, in pixels on its
 * longest side.
 *
 * The wall (and the cove continuing it) is the largest thing in any shot — a close camera
 * fills the whole frame with it — so it is the one texture that must never be economised.
 * Both the wall's frame planes and the cove's composite floor their canvas here, which
 * also decouples resolution from the shrink slider: making a tile smaller changes how the
 * texture *reads*, never how much detail it holds.
 */
const SURFACE_MIN_TEX = 4096;

/**
 * Ceiling for a single-tile surface texture.
 *
 * A tile is uploaded at the source's own resolution so the camera can push in without the
 * backdrop going soft. 8192 on the longest side is ~240 MB with mipmaps for a 3:2 photo,
 * which is affordable for the one texture that fills most of the frame, and is the common
 * GPU limit anyway.
 */
const SURFACE_MAX_TEX = 8192;

/**
 * Draw one image as a seamless repeating grid into a canvas.
 *
 * Each tile is drawn `TILE_OVERLAP_PX` larger than its slot and feathered on the two
 * edges that meet an already-drawn neighbour (left and top), so the overlap band
 * cross-fades instead of butting up against a hard line. Tiles are composited onto an
 * offscreen canvas first: feathering needs per-tile alpha, and applying that directly to
 * the destination would also fade whatever is underneath.
 *
 * `originX`/`originY` may be negative — the grid deliberately overhangs the surface so no
 * strip is left uncovered, and the caller clips the result.
 */
function drawSeamlessTileGrid(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  originX: number,
  originY: number,
  tileW: number,
  tileH: number,
  cols: number,
  rows: number
): void {
  const gridW = Math.ceil(cols * tileW) + TILE_OVERLAP_PX * 2;
  const gridH = Math.ceil(rows * tileH) + TILE_OVERLAP_PX * 2;
  if (gridW <= 0 || gridH <= 0) return;

  const layer = document.createElement('canvas');
  layer.width = gridW;
  layer.height = gridH;
  const lctx = layer.getContext('2d');
  if (!lctx) {
    // No offscreen context — fall back to a plain overlapping grid. The hairlines are
    // gone (the tiles overlap), only the cross-fade is missing.
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        ctx.drawImage(
          img,
          originX + col * tileW - TILE_OVERLAP_PX,
          originY + row * tileH - TILE_OVERLAP_PX,
          tileW + TILE_OVERLAP_PX * 2,
          tileH + TILE_OVERLAP_PX * 2
        );
      }
    }
    return;
  }
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = 'high';

  // Feather width: the overlap band, but never more than a fraction of the tile itself
  // (a tiny tile must not be mostly gradient).
  const feather = Math.max(
    1,
    Math.min(TILE_OVERLAP_PX * 2, Math.floor(Math.min(tileW, tileH) / 4))
  );

  // One tile, pre-rendered at its drawn size with its leading edges feathered. Every
  // tile is identical, so this is built once and stamped.
  const stampW = Math.ceil(tileW) + TILE_OVERLAP_PX * 2;
  const stampH = Math.ceil(tileH) + TILE_OVERLAP_PX * 2;
  const stamp = document.createElement('canvas');
  stamp.width = stampW;
  stamp.height = stampH;
  const sctx = stamp.getContext('2d');
  if (!sctx) return;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(img, 0, 0, stampW, stampH);

  // Fade the left and top edges to transparent. Only two edges are feathered: a tile is
  // drawn over its left/top neighbours, so those are the joins it has to blend into.
  // Feathering all four would double-fade every seam and darken it instead.
  sctx.globalCompositeOperation = 'destination-in';
  const gx = sctx.createLinearGradient(0, 0, feather, 0);
  gx.addColorStop(0, 'rgba(0,0,0,0)');
  gx.addColorStop(1, 'rgba(0,0,0,1)');
  // Horizontal ramp first, multiplied into the existing alpha across the whole tile.
  sctx.fillStyle = gx;
  sctx.fillRect(0, 0, stampW, stampH);
  // Then the vertical fade, applied only over the top band. `destination-out` subtracts
  // alpha, so this ramp runs opaque->transparent downwards: it removes the most alpha at
  // y = 0 and none by y = feather. Doing it this way (rather than a second
  // `destination-in` over the whole tile) leaves the rest of the tile untouched, so the
  // two ramps combine in the corner instead of the second one erasing the first.
  sctx.globalCompositeOperation = 'destination-out';
  const gyOut = sctx.createLinearGradient(0, 0, 0, feather);
  gyOut.addColorStop(0, 'rgba(0,0,0,1)');
  gyOut.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = gyOut;
  sctx.fillRect(0, 0, stampW, feather);
  sctx.globalCompositeOperation = 'source-over';

  // Two passes. First lay every tile down unfeathered: this guarantees full opaque
  // coverage, so even where a feathered edge is partly transparent there is always image
  // underneath and never a gap for the background to show through as a hairline.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      lctx.drawImage(
        img,
        TILE_OVERLAP_PX + col * tileW,
        TILE_OVERLAP_PX + row * tileH,
        Math.ceil(tileW),
        Math.ceil(tileH)
      );
    }
  }
  // Then stamp the feathered tile over the top. Its faded left/top edges cross-fade into
  // the neighbour already painted there, which is what dissolves the straight boundary
  // line the eye picks out of an organic texture.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      lctx.drawImage(
        stamp,
        TILE_OVERLAP_PX + col * tileW - TILE_OVERLAP_PX,
        TILE_OVERLAP_PX + row * tileH - TILE_OVERLAP_PX
      );
    }
  }

  ctx.drawImage(layer, originX - TILE_OVERLAP_PX, originY - TILE_OVERLAP_PX);
}

type FramePlaneMaterial = THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;

/**
 * Native-size layout for one frame's image on a surface.
 *
 * `tile` is the size of a single copy of the image in wall units, derived from its pixel
 * dimensions at a fixed pixels-per-unit. `cols`/`rows` is how many copies are drawn
 * ("contain" is always 1x1). `planeWidth`/`planeHeight` is the rectangle the copies are
 * drawn into — the tile itself when contained, the whole surface when covering.
 */
interface FrameTileLayout {
  tile: { width: number; height: number };
  cols: number;
  rows: number;
  planeWidth: number;
  planeHeight: number;
}

// Available HDRI options (same as editor-client)
export const HDRI_OPTIONS_FALLBACK = [
  { id: "__studio_white__", label: "Studio White" },
  { id: "bloem_train_track_clear_2k.hdr", label: "Bloem Train Track Clear 2k" },
  { id: "church_museum_2k.hdr", label: "Church Museum 2k" },
  { id: "church_stairway_2k.hdr", label: "Church Stairway 2k" },
  { id: "ferndale_studio_07_2k.hdr", label: "Ferndale Studio 07 2k" },
];

/** Cached HDRI texture with URL key */
interface CachedHdri {
  url: string;
  texture: THREE.DataTexture;
}

/**
 * Thrown when stopRecording() interrupts a take.
 *
 * A distinct type so callers can tell "the user pressed stop" apart from a real
 * failure — the UI should not raise an error dialog for a deliberate cancel.
 */
export class RecordingCanceledError extends Error {
  constructor() {
    super('Recording canceled');
    this.name = 'RecordingCanceledError';
  }
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
  /**
   * Monotonic token for `setupStudioFromStudioConfig`.
   *
   * That method is async and awaits the texture manifest, PBR packs and every frame
   * image. The studio's rebuild effect is debounced but not serialised, so a second
   * rebuild can start while the first is still awaiting. Without a token the first call
   * resumes after the second has already run `clearStudioElements()`, then adds its wall
   * and cove to the scene and overwrites the fields — leaving the earlier meshes
   * orphaned in the scene (never removed, never disposed). Two wall planes and two coves
   * on the identical arc z-fight, and the stacked `depthWrite: false` frame planes blend
   * down to black. Each call captures this value and abandons its work as soon as it no
   * longer matches.
   */
  private studioSetupGeneration = 0;
  /** Seconds fed to the logo plate's flicker clock. Advances with preview/recording time. */
  private _logoElapsed = 0;

  // HDRI-driven shadow lights (one DirectionalLight per HDRI layer)
  private hdriShadowLights: Array<{
    layerId: string;
    light: THREE.DirectionalLight;
    /** Base light position (on HDRI dome, no cue offset applied). Used to translate the
     *  shadow camera with the cue so the frustum always covers the cue's shadow area. */
    basePosition: THREE.Vector3;
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
  /** Video Studio V2 — real 3D room / HDRI environment. Null while V1 (flat wall+table) is active. */
  private roomEnvironment: StudioRoomEnvironment | null = null;
  /**
   * Giant camera-locked logo plate drawn behind the cue. Created lazily the first time a
   * studio config asks for one, so nothing is allocated for the image extractor.
   */
  private logoBackdrop: LogoBackdrop | null = null;
  /** Colour of the void around the V1 wall/table set. Mirrors config.sceneBackground. */
  private _sceneBackgroundColor: string = DEFAULT_SCENE_BACKGROUND.color;
  /**
   * Frame aspect the logo plate is currently laid out for.
   *
   * The plate fits itself to the frame, and the studio renders into several differently
   * shaped targets (the editor canvas, the ratio-accurate minimap, the recording buffer),
   * so this is saved and restored around each of them.
   */
  private viewportAspectForBackdrop = 16 / 9;
  /**
   * The product's own "Logo khắc laser" id, which the plate follows when its own logoId
   * is "auto". Set by the studio from the loaded product config.
   */
  private productLogoId: string | null = null;
  /** True while a transparent (alpha) capture is in progress — suppresses the background. */
  private _transparentBackground = false;
  /** Reason the last V2 environment load failed, surfaced in the studio UI. */
  private _roomEnvironmentError: string | null = null;

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
  /** Dimmed overlay line tracing the whole shape curve in scene view. */
  private cameraPathLine: THREE.Line | null = null;
  /** Bright overlay line covering only the recorded start→end span. */
  private cameraSpanLine: THREE.Line | null = null;
  /** Draggable sphere per waypoint, index-tagged via userData. */
  private cameraWaypointGizmos: THREE.Mesh[] = [];
  /** When true the whole curve is selected and drags move every waypoint together. */
  private _cameraPathSelectAll = false;

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

  // Kept from scene setup so the corner fill can be repainted on a frame drag without
  // rebuilding the whole set: the decoded wall images, and the bare wall material the cove
  // falls back to when no frame paints over it.
  private wallFrameImages: Map<string, HTMLImageElement> = new Map();
  private wallBaseMaterial: THREE.Material | null = null;
  /** True while the cove is a clone of the bare wall material rather than a wall composite.
   *  Decides whether a live tint update applies to it (see updateSurfaceHdri). */
  private coveShowsBareWall = true;

  // Smooth camera interpolation
  private cameraTargetPos = new THREE.Vector3();
  private cameraSmoothEnabled = false;

  // Reusable Object3D for instanced mesh matrix updates — avoids per-frame GC allocations.
  private _spinDummy = new THREE.Object3D();

  // Animation state
  private animationFrameId: number | null = null;
  /**
   * Set by stopRecording(), cleared when a take begins.
   *
   * The deterministic loop is a plain async for-loop with no
   * requestAnimationFrame to cancel, so a stop request can only be observed by
   * the loop itself checking this between frames.
   */
  private _recordingCanceled = false;
  private _spinPaused = false;
  private _isHelperDragging = false;
  /** When true, updateStudioPreviewConfig skips setCameraFromKeyframe so camera orbit controls can take effect */
  private _cameraPlacementMode = false;
  /** Fingerprint of the last cameraStart that was applied via setCameraFromKeyframe in updateStudioPreviewConfig */
  private _lastAppliedCameraStartKey = "";
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
    this.scene.background = new THREE.Color(this._sceneBackgroundColor);

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
      // Tight frustum (±12) matches the shadow scene scale and gives ~85 texels/world-unit
      // at 2048px. Wider frustum (e.g. ±20) reduces to ~51 texels/unit, which causes VSM's
      // Gaussian blur to produce the scalloped/wavy artifact visible at grazing light angles.
      light.shadow.camera.left = -12;
      light.shadow.camera.right = 12;
      light.shadow.camera.top = 12;
      light.shadow.camera.bottom = -12;
      light.shadow.bias = -0.0005;
      light.shadow.radius = config.shadowBlur;
      this.scene.add(light);
      this.scene.add(light.target);
      this.hdriShadowLights.push({ layerId: 'legacy', light, basePosition: pos.clone() });
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
      const coveMat = this.studioCornerFill.material as THREE.MeshStandardMaterial;
      // The cove owns its wall-composite canvas texture; a clone of the wall material
      // shares the wall's map, which the wall disposal above already handled.
      if (coveMat.map && coveMat.map !== (this.wallBaseMaterial as THREE.MeshStandardMaterial | null)?.map) {
        coveMat.map.dispose();
      }
      coveMat.dispose();
      this.studioCornerFill.geometry.dispose();
      this.studioCornerFill = null;
    }
    // Cached wall inputs belong to the set being torn down.
    this.wallFrameImages = new Map();
    this.wallBaseMaterial = null;
    for (const mesh of this.backgroundLayerMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.backgroundLayerMeshes = [];
    this.sweepOrphanedStudioMeshes();
  }

  /**
   * Remove any studio mesh still in the scene that the manager no longer tracks.
   *
   * The tracked-field teardown above is the normal path. This is the backstop for a mesh
   * that was added by a setup pass which then lost its field reference — the wall, for
   * instance, is added before the table's texture pack is awaited, so a rebuild that
   * overtakes that await leaves the earlier wall in the scene with `this.backdrop`
   * already null. An untracked duplicate is invisible to every later teardown, so it
   * accumulates: two wall planes at the same z z-fight, and the stacked
   * `depthWrite: false` frame planes over them blend down to black.
   *
   * Every studio mesh is tagged in `userData.type` at creation, which is what makes the
   * sweep safe: nothing else in the scene carries these tags.
   */
  private sweepOrphanedStudioMeshes(): void {
    const STUDIO_TYPES = new Set([
      'wall', 'table', 'corner-fill', 'wallFrame', 'tableFrame',
    ]);
    const tracked = new Set<THREE.Object3D>(
      [
        this.backdrop, this.tableSurface, this.studioCornerFill,
        ...this.wallFramePlanes, ...this.tableFramePlanes,
      ].filter((o): o is THREE.Mesh => !!o)
    );
    const orphans: THREE.Mesh[] = [];
    for (const child of this.scene.children) {
      const type = (child.userData as { type?: string } | undefined)?.type;
      if (type && STUDIO_TYPES.has(type) && !tracked.has(child)) {
        orphans.push(child as THREE.Mesh);
      }
    }
    for (const mesh of orphans) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat.map) mat.map.dispose();
      mat.dispose();
    }
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
      // Tight frustum (±12) gives ~85 texels/world-unit at 2048px.
      // ±20 reduces to ~51 texels/unit → VSM Gaussian blur creates scalloped artifact.
      light.shadow.camera.left = -12;
      light.shadow.camera.right = 12;
      light.shadow.camera.top = 12;
      light.shadow.camera.bottom = -12;
      light.shadow.bias = -0.0001;
      light.shadow.normalBias = 0.02;
      light.shadow.radius = Math.max(layer.shadowBlur ?? shadow.blur ?? 3, 4);
      light.shadow.blurSamples = 20;
      light.shadow.intensity = layer.shadowIntensity ?? 1.0;

      this.scene.add(light);
      this.scene.add(light.target);
      this.hdriShadowLights.push({ layerId: layer.id, light, basePosition: pos.clone() });
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
      entry.basePosition.copy(pos);
      // Re-apply cue offset so the shadow camera stays centred on the cue
      const cx = this._cueCenterX + this._shadowOffsetX;
      const cz = this._cueCenterZ + this._shadowOffsetZ;
      entry.light.position.set(pos.x + cx, pos.y, pos.z + cz);
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

  /** Shift all HDRI shadow light positions and targets by the cue offset so the shadow
   *  camera frustum always covers the cue and its shadow area on the backdrop. */
  private _applyShadowLightOffset(offsetX: number, offsetZ: number): void {
    for (const entry of this.hdriShadowLights) {
      const cx = this._cueCenterX + offsetX;
      const cz = this._cueCenterZ + offsetZ;
      // Translate the shadow camera (light.position) alongside the target so the
      // ±12 frustum stays centred on the cue regardless of where it is in the scene.
      entry.light.position.set(
        entry.basePosition.x + cx,
        entry.basePosition.y,
        entry.basePosition.z + cz
      );
      entry.light.target.position.set(cx, 0, cz);
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
    // V2: the "walls" are the room/skybox, so transparent capture hides those instead.
    this.roomEnvironment?.setVisible(visible);
    if (this.backdrop) this.backdrop.visible = visible;
    if (this.tableSurface) this.tableSurface.visible = visible;
    if (this.studioCornerFill) {
      // When restoring visibility, re-apply the normal corner-fill rule.
      if (!visible) {
        this.studioCornerFill.visible = false;
      } else if (this.studioConfigRef) {
        this.syncCornerFillVisibility(this.studioConfigRef);
      } else {
        this.studioCornerFill.visible = true;
      }
    }
    for (const p of this.wallFramePlanes) p.visible = visible;
    for (const p of this.tableFramePlanes) p.visible = visible;
    // The wall-anchored logo plate is part of the set, so it follows the wall it is
    // painted on — a transparent capture that keeps it would fill the frame it is meant
    // to leave empty.
    this.logoBackdrop?.setWorldVisible(visible);
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
    if (this.cameraPathLine) this.cameraPathLine.visible = visible;
    if (this.cameraSpanLine) this.cameraSpanLine.visible = visible;
    for (const g of this.cameraWaypointGizmos) g.visible = visible;
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
    entry.basePosition.copy(pos);
    // Re-apply current cue offset so the frustum stays over the cue
    const cx = this._cueCenterX + this._shadowOffsetX;
    const cz = this._cueCenterZ + this._shadowOffsetZ;
    entry.light.position.set(pos.x + cx, pos.y, pos.z + cz);
    if (intensity !== undefined) {
      // Same multiplier used in setupHdriShadowLights / updateHdriShadowLights
      entry.light.intensity = intensity * 1.2;
    }
    // Ensure the shadow camera matrix is refreshed before the next render
    entry.light.target.updateMatrixWorld();
    entry.light.shadow.needsUpdate = true;
  }

  /**
   * Immediately update the shadow camera position to follow the cue at (x, z).
   * Call on every cue drag event to avoid the 100ms debounce lag that would
   * otherwise leave the shadow frustum anchored at the old cue position.
   */
  directUpdateCueShadowPosition(x: number, z: number): void {
    this._cueCenterX = x;
    this._cueCenterZ = z;
    this._applyShadowLightOffset(this._shadowOffsetX, this._shadowOffsetZ);
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

  /** Invalidate cue HDRI dedup caches so the next setCueHdri / setCueHdriLayers call
   *  re-applies the envMap even if the config hasn't changed.  Call this after
   *  simulator groups are rebuilt so the groups receive their envMap. */
  invalidateCueHdriCache(): void {
    this.lastCueHdriKey = '';
    this.lastCueHdriLayersKey = '';
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
        // For a single layer, pass its intensity through envMapIntensity so users can
        // dim/brighten the HDRI lighting. For multi-layer the intensities are already
        // baked into the blended texture, so we apply at full strength (1.0).
        const envIntensity = activeLayers.length === 1 ? (activeLayers[0].intensity ?? 1) : 1.0;
        this.applyCueEnvMap(rt.texture, envIntensity);
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
        // Material.clone() drops onBeforeCompile, so restore the laser shaders.
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
          const mat = material as THREE.MeshPhysicalMaterial;
          if (!mat.emissiveMap) return;
          if (isRubberMaterial(mat.name, child.name)) {
            applyBumperEmissiveShaderMask(mat);
          } else if (isTopCapFaceMaterial(mat.name) || isTopCapMaterial(mat.name, child.name)) {
            applyLogoToExistingMaterial(mat, "topCapFace", (mat.userData.__logoId as import("@/types/product").CueLogoId | undefined) ?? "uni");
          }
        });
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
    this._transparentBackground = transparent;
    this.scene.background = transparent ? null : new THREE.Color(this._sceneBackgroundColor);
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

  // ════════════════════════════════════════════════════════════════
  //  VIDEO STUDIO V2 — real 3D room / HDRI environment
  // ════════════════════════════════════════════════════════════════

  /**
   * Build the V2 environment: a 360 degree HDRI or a real GLB room, replacing the V1
   * wall + table planes.
   *
   * Lighting differs from V1 in one important way. V1 deliberately keeps
   * `scene.environment` null and hands each surface its own solid-colour env map, so the
   * fake set stays flat and neutral. A real room needs the opposite: the panorama must
   * light everything so the cue picks up the room's colour and its reflections agree with
   * the visible background. That is exactly what makes the cue read as being *in* the
   * space rather than composited over a photo.
   */
  private async setupRoomEnvironment(config: VideoStudioConfig): Promise<void> {
    this._roomEnvironmentError = null;
    const envConfig = normalizeEnvironmentConfig(config.environment);

    if (!this.roomEnvironment) {
      this.roomEnvironment = new StudioRoomEnvironment(
        this.scene,
        this.renderer,
        this.pmremGenerator
      );
    }

    const result = await this.roomEnvironment.build(envConfig);
    if (!result.ok) {
      console.warn('[ESM] V2 environment build failed:', result.error);
      this._roomEnvironmentError = result.error ?? 'unknown error';
    }

    // The V1 cameras are built for a 34-unit set, so their far planes (100 production,
    // 200 god) sit *inside* a V2 environment: the skybox radius alone defaults to 100 and
    // a GLB room can be larger still. Anything past the far plane is clipped and renders
    // as a black void, which looks like a hole punched in the room. Push both far planes
    // out past the environment's true extent.
    this.extendCameraFarForEnvironment(this.roomEnvironment.getFarPlaneRequirement(envConfig));

    // Directional lights still come from the HDRI layers so the cue keeps a defined
    // key light and casts a real shadow onto the shadow catcher. Without this the cue
    // would be lit by ambient IBL only, which reads as flat and casts nothing.
    this.setupHdriShadowLights(config);
    this.setupHdriLightHelpers(config);

    // The cue keeps its dedicated product-tuned HDRI unless the user opts into being lit
    // by the room. Product highlights are usually better with the purpose-built cue HDRI,
    // so this defaults to off.
    if (envConfig.lightCueFromEnvironment) {
      this.applyCueEnvMap(this.scene.environment, envConfig.intensity);
      this.invalidateCueHdriCache();
    } else {
      try {
        if (config.cueHdriLayers && config.cueHdriLayers.length > 0) {
          await this.setCueHdriLayers(config.cueHdriLayers);
        } else {
          await this.setCueHdri(config.cueHdri ?? DEFAULT_CUE_HDRI);
        }
      } catch (err) {
        console.warn('[ESM] Failed to apply cue HDRI in V2:', err);
      }
    }
  }

  /**
   * Grow both cameras' far planes so the whole environment stays inside the view frustum.
   *
   * Only ever increases the far plane — the V1 defaults are the floor — and keeps a margin
   * so the dome's far rim is not sitting exactly on the clip boundary.
   */
  private extendCameraFarForEnvironment(requiredFar: number): void {
    const target = requiredFar * 1.5;
    if (this.camera.far < target) {
      this.camera.far = target;
      this.camera.updateProjectionMatrix();
    }
    if (this.godCamera && this.godCamera.far < target) {
      this.godCamera.far = target;
      this.godCamera.updateProjectionMatrix();
    }
  }

  /** Apply the cheap V2 environment updates (rotation, intensity, shadow catcher) live. */
  updateRoomEnvironment(config: VideoStudioConfig): void {
    if (!config.environment || !this.roomEnvironment) return;
    const envConfig = normalizeEnvironmentConfig(config.environment);
    this.roomEnvironment.applyLightUpdates(envConfig);
    // Growing the floor radius pushes the dome's rim further out, so the far plane has to
    // follow or the newly-distant geometry is clipped straight back into a black void.
    this.extendCameraFarForEnvironment(this.roomEnvironment.getFarPlaneRequirement(envConfig));
  }

  /** Reason the last V2 environment load failed, or null if it succeeded. */
  getRoomEnvironmentError(): string | null {
    return this._roomEnvironmentError;
  }

  /** True when a V2 environment is currently built. */
  hasRoomEnvironment(): boolean {
    return !!this.roomEnvironment?.isActive();
  }

  /** The V2 shadow-catcher mesh, if any (used for raycast placement of the cue). */
  getRoomShadowCatcher(): THREE.Mesh | null {
    return this.roomEnvironment?.getShadowCatcher() ?? null;
  }

  /** The loaded V2 room model, if any. */
  getRoomModel(): THREE.Group | null {
    return this.roomEnvironment?.getRoom() ?? null;
  }

  /** Show/hide V2 environment scenery (used by transparent capture). */
  setRoomEnvironmentVisible(visible: boolean): void {
    this.roomEnvironment?.setVisible(visible);
  }

  /** Tear down the V2 environment and restore the scene's original background. */
  disposeRoomEnvironment(): void {
    if (!this.roomEnvironment) return;
    this.roomEnvironment.dispose();
    this.roomEnvironment = null;
  }

  /** Setup studio environment from the new VideoStudioConfig (compositor-based backgrounds) */
  async setupStudioFromStudioConfig(config: VideoStudioConfig): Promise<void> {
    const generation = ++this.studioSetupGeneration;
    /** True once a newer setup has taken over — this call must add nothing more. */
    const superseded = () => this.studioSetupGeneration !== generation;

    this.clearStudioElements();

    // Ensure scene.environment is null — cue and surfaces each get their own envMap
    this.scene.environment = null;

    // The void around the set and the camera-locked logo plate are both applied here as
    // well as in updateStudioPreviewConfig, so a freshly built scene is already correct
    // instead of showing one frame of the previous look before the debounced sync lands.
    this.setSceneBackgroundColor(config.sceneBackground?.color ?? DEFAULT_SCENE_BACKGROUND.color);
    this.setLogoBackdrop(config.logoBackdrop, resolveLogoBackdropUrl(config.logoBackdrop, this.productLogoId));

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

    // ══ Video Studio V2 ══
    // When an environment config is present the studio is a *real* 3D space: an
    // equirectangular HDRI (optionally ground-projected) or a loaded GLB room.
    // In that mode the V1 fake set — wall plane, table plane, L-shaped shadow mesh and
    // corner fill — is skipped entirely; the environment provides background, lighting
    // and (for GLB) actual geometry the cue can be occluded by.
    if (config.environment) {
      await this.setupRoomEnvironment(config);
      if (superseded()) return;
      this.setupCueInstances(config.cueConfig);
      return;
    }

    // ── Load PBR textures for wall and table ──
    const manifest = await loadTextureManifest();
    if (superseded()) return;

    // Wall: PBR texture with subdivided geometry for displacement
    const wallPack = findTexturePack(manifest, config.wallSurface.texturePreset);
    let wallMaterial: THREE.MeshStandardMaterial;
    if (wallPack) {
      wallMaterial = await loadPBRTexturePack(wallPack);
    } else {
      const wallImages = await preloadFrameImages(config.wallSurface.frames);
      // Fallback path (no PBR pack matched the preset). Sized at the same quality floor
      // as the frame planes so this branch is not the one that softens the backdrop.
      const wallTex = compositeSurfaceFrames(
        config.wallSurface, SURFACE_MIN_TEX, SURFACE_MIN_TEX, wallImages
      );
      wallTex.wrapS = THREE.ClampToEdgeWrapping;
      wallTex.wrapT = THREE.ClampToEdgeWrapping;
      wallTex.repeat.set(1, 1);
      wallMaterial = new THREE.MeshStandardMaterial({
        map: wallTex, roughness: 0.95, metalness: 0, side: THREE.FrontSide,
      });
    }
    if (superseded()) {
      // A newer setup already cleared the scene. This material was built for a wall that
      // will never be added, so drop it here rather than leaking it.
      wallMaterial.dispose();
      return;
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
    // Base tint multiplies the pack's colour map, so the texture keeps its grain.
    applySurfaceTint(wallMaterial, config.wallSurface.baseTint);

    // Subdivided wall geometry for better displacement mapping
    const wallGeo = new THREE.PlaneGeometry(WALL_WIDTH, WALL_HEIGHT, 64, 64);
    const wallMeshMat: THREE.Material = config.surfaceLightDisabled
      ? createWhiteImmuneMaterial(config.wallSurface.baseTint)
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
      const tableTex = compositeSurfaceFrames(
        config.tableSurface, SURFACE_MIN_TEX, SURFACE_MIN_TEX, tableImages
      );
      tableTex.wrapS = THREE.ClampToEdgeWrapping;
      tableTex.wrapT = THREE.ClampToEdgeWrapping;
      tableTex.repeat.set(1, 1);
      tableMaterial = new THREE.MeshStandardMaterial({
        map: tableTex, roughness: 0.35, metalness: 0, side: THREE.FrontSide,
      });
    }
    if (superseded()) {
      tableMaterial.dispose();
      return;
    }
    tableMaterial.envMap = surfaceEnv;
    tableMaterial.envMapIntensity = 0.6;
    if (config.tableSurface.roughness != null) {
      tableMaterial.roughness = config.tableSurface.roughness;
    }
    applySurfaceTint(tableMaterial, config.tableSurface.baseTint);

    // Subdivided table geometry for displacement
    const tableGeo = new THREE.PlaneGeometry(WALL_WIDTH, tableDepth, 64, 64);
    const tableMeshMat: THREE.Material = config.surfaceLightDisabled
      ? createWhiteImmuneMaterial(config.tableSurface.baseTint)
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
    // Last await before the frame planes, shadow mesh and cove are added — after this
    // point the build is synchronous and cannot be overtaken.
    if (superseded()) return;
    // Frame planes follow the same lighting rule as the surfaces they sit on:
    // studio lights shade the background image unless surface influence is disabled.
    const framesLit = !config.surfaceLightDisabled;
    // Cached for refreshCornerFillMaterial — see the fields' declaration.
    this.wallFrameImages = wallImages2;
    this.wallBaseMaterial = wallMeshMat;
    this.wallFramePlanes = this.buildFramePlanes(
      config.wallSurface, this.backdrop!, false, wallImages2, framesLit, surfaceEnv
    );
    this.tableFramePlanes = this.buildFramePlanes(
      config.tableSurface, this.tableSurface!, true, tableImages2, framesLit, surfaceEnv
    );

    // Single L-shaped shadow receiver spanning wall + table seamlessly
    const cornerFill = { ...DEFAULT_CORNER_FILL, ...config.cornerFill };
    // radius 0 tells the shadow mesh to build a sharp 90 degree corner. Shadows still land
    // on both faces; they simply break at the junction instead of sweeping around a cove.
    const cornerRadius = cornerFill.enabled ? cornerFill.radius : 0;
    const wallZ = -5.5;
    if (config.shadow.enabled) {
      const shadowMesh = createLShapedShadowMesh(
        36,                    // width (slightly wider than surfaces)
        24,                    // wall height
        tableDepth + 2,        // floor depth
        tableY,                // corner Y (where wall meets table)
        wallZ,                 // wall Z position
        config.shadow.intensity,
        cornerRadius
      );
      // Offsets baked into vertices — no position adjustment needed
      this.shadowFloor = shadowMesh;
      this.shadowFloorBaseY = shadowMesh.position.y;
      this.scene.add(this.shadowFloor);
      // Restore saved manual transform for shadow floor (if any)
      this.applyShadowPlaneTransform(config);
    }

    // Curved corner fill: backing geometry for the shadow mesh's curved section, and a
    // visible part of the set in its own right. Because it is visible set dressing and not
    // only a shadow backing, it is built whether or not shadows are on — otherwise turning
    // shadows off would square off the wall/table junction as a side effect.
    if (cornerFill.enabled) {
      this.studioCornerFill = createCornerFillMesh(
        WALL_WIDTH, tableY, wallZ, cornerFill.color, cornerRadius,
        WALL_HEIGHT,  // wall plane height — matches the backdrop's PlaneGeometry
        tableY        // wall plane bottom edge (backdrop y=10, height 24 -> bottom at -2)
      );
      (this.studioCornerFill.material as THREE.Material).dispose();
      this.studioCornerFill.material = this.buildCornerFillMaterial(
        cornerFill, config, wallMeshMat, surfaceEnv, wallImages2
      );
      this.studioCornerFill.userData = { type: 'corner-fill' };
      this.scene.add(this.studioCornerFill);
    }

    this.syncCornerFillVisibility(config);

    // Setup cue instances
    this.setupCueInstances(config.cueConfig);
  }

  /**
   * Decide whether the corner fill should be drawn.
   *
   * The cove now paints itself from a render of the wall's *whole* visible surface
   * (see buildCornerFillMaterial), so it continues any backdrop — flat colour, gradient
   * or photo, full-bleed or not — instead of interrupting it. That leaves only one reason
   * to hide it: the fillet is disabled.
   *
   * It deliberately no longer hides for a table image. The cove is the wall's continuation
   * and reads correctly against a photographic table exactly as the wall itself does.
   */
  private syncCornerFillVisibility(config: VideoStudioConfig): void {
    if (!this.studioCornerFill) return;
    const cornerFill = { ...DEFAULT_CORNER_FILL, ...config.cornerFill };
    this.studioCornerFill.visible = cornerFill.enabled;
  }

  /**
   * Repaint the corner fill from the wall's current frame layout.
   *
   * The cove's texture is a render of the whole wall, so it goes stale the moment a frame
   * moves, resizes, rotates or changes opacity — all of which are applied live by
   * `updateFramePlaneTransforms` and deliberately never trigger a scene rebuild. This is the
   * cheap counterpart: it redraws one canvas and swaps the material, leaving geometry,
   * textures and lights untouched.
   *
   * It is a no-op when the cove does not exist, so callers do not need to guard.
   */
  refreshCornerFillMaterial(config: VideoStudioConfig): void {
    if (!this.studioCornerFill || !this.wallBaseMaterial) return;

    const cornerFill = { ...DEFAULT_CORNER_FILL, ...config.cornerFill };
    const firstEnabledLayer = (config.hdriConfig?.layers ?? []).find(l => l.enabled !== false);
    const surfaceEnv = config.surfaceLightDisabled
      ? null
      : this.getSurfaceEnvMap(firstEnabledLayer?.lightColor ?? '#ffffff');

    const next = this.buildCornerFillMaterial(
      cornerFill, config, this.wallBaseMaterial, surfaceEnv, this.wallFrameImages
    );

    const prev = this.studioCornerFill.material as THREE.Material;
    this.studioCornerFill.material = next;
    // The old material owns a canvas texture of its own (unless it was a clone of the wall
    // material, whose map is shared and must survive). Only dispose what this mesh made.
    if (prev !== this.wallBaseMaterial) {
      const prevMap = (prev as THREE.MeshStandardMaterial).map;
      if (prevMap && prevMap !== (this.wallBaseMaterial as THREE.MeshStandardMaterial).map) {
        prevMap.dispose();
      }
      prev.dispose();
    }
  }

  /**
   * Draw the wall's visible surface into a canvas laid out in *wall-plane UV space*.
   *
   * The canvas covers the full 34x24 backdrop: x = 0 is the wall's left edge, y = 0 its
   * top edge. Every enabled frame is composited into it at its own position, size, rotation
   * and opacity, using the exact same drawing rules as `createFramePlaneMaterial` — an
   * image is letterboxed (`object-fit: contain`) inside its frame over the frame's
   * background layer — so what lands in the canvas is pixel-for-pixel what the frame planes
   * show on the wall.
   *
   * Returns null when nothing is drawn (no enabled frames), which tells the caller to fall
   * back to the bare wall material.
   */
  private renderWallCompositeCanvas(
    surface: SurfaceConfig,
    loadedImages: Map<string, HTMLImageElement>,
    wallWidth: number,
    wallHeight: number,
    baseTint?: string | null
  ): HTMLCanvasElement | null {
    const enabledFrames = surface.frames.filter(f => f.enabled);
    if (enabledFrames.length === 0) return null;

    // Resolution is driven by the wall's aspect so nothing is stretched, and by the largest
    // source image so a high-res photo is not pre-downsampled before the cove samples it.
    const gpuMaxTex = this.renderer.capabilities.maxTextureSize ?? 4096;
    // Matches the frame planes' cap. The cove is a continuation of the wall and is
    // sampled at a grazing angle, so capping it lower than the wall is what would make
    // the curve read as a blurrier strip than the surface it joins.
    const HARD_MAX_TEX = Math.min(gpuMaxTex, 8192);
    // A tiled frame draws its (shrunken) image several times across this canvas, so the
    // canvas needs one tile's worth of pixels times the tile count — the same reasoning as
    // createFramePlaneMaterial, floored at the same quality minimum so shrinking the tile
    // never costs resolution.
    let srcMaxSide = 0;
    for (const f of enabledFrames) {
      if (!f.imageUrl) continue;
      const img = loadedImages.get(f.imageUrl);
      if (!img) continue;
      const layout = this.computeFrameTileLayout(f, img, wallWidth, wallHeight);
      const scale = clampFrameImageScale(f.imageScale ?? DEFAULT_FRAME_IMAGE_SCALE);
      const spanTiles = layout ? Math.max(layout.cols, layout.rows) : 1;
      const needed = Math.max(img.naturalWidth, img.naturalHeight) * scale * spanTiles;
      srcMaxSide = Math.max(srcMaxSide, Math.ceil(needed), SURFACE_MIN_TEX);
    }
    const MAX_TEX = Math.min(Math.max(2048, srcMaxSide), HARD_MAX_TEX);
    const wallAR = wallWidth / wallHeight;
    const canvasW = wallAR >= 1 ? MAX_TEX : Math.round(MAX_TEX * wallAR);
    const canvasH = wallAR < 1 ? MAX_TEX : Math.round(MAX_TEX / wallAR);

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Pixels per wall unit — the same on both axes because the canvas matches the wall AR.
    const pxPerU = canvasW / wallWidth;
    const pxPerV = canvasH / wallHeight;

    // Base layer: the wall's own tint, so a frame that does not cover the whole wall blends
    // into the same colour the wall plane shows beside it instead of into transparency.
    // (The pack's texture grain is not reproduced here — around a 0.8-unit cove the tint is
    // what reads, and sampling the PBR maps per-pixel on every drag would not pay for itself.)
    if (baseTint && baseTint !== '#ffffff') {
      ctx.fillStyle = baseTint;
      ctx.fillRect(0, 0, canvasW, canvasH);
    }

    let drewAnything = false;

    for (const frame of enabledFrames) {
      // An image frame's rectangle comes from the native tile layout, exactly as the wall
      // plane's geometry does — the cove's picture has to be the same picture, so the two
      // must derive their size from the same call. Colour/gradient frames keep using
      // frame.width / frame.height.
      const frameImg = frame.imageUrl ? loadedImages.get(frame.imageUrl) : undefined;
      const layout = this.computeFrameTileLayout(frame, frameImg, wallWidth, wallHeight);

      // Frame rect in wall units, then in canvas pixels. frame.x / frame.y are the CENTRE
      // in 0..1 wall space with y = 0 at the top, matching the canvas' own y direction.
      const fwPx = (layout ? layout.planeWidth : frame.width * wallWidth) * pxPerU;
      const fhPx = (layout ? layout.planeHeight : frame.height * wallHeight) * pxPerV;
      // A covering frame's plane is the whole wall, so it is centred regardless of
      // frame.x / frame.y — matching buildFramePlanes.
      const covers = !!layout;
      const cxPx = covers ? canvasW / 2 : frame.x * canvasW;
      const cyPx = covers ? canvasH / 2 : frame.y * canvasH;

      ctx.save();
      ctx.translate(cxPx, cyPx);
      if (frame.rotation && !covers) ctx.rotate((frame.rotation * Math.PI) / 180);

      const outer = frame.opacity ?? 1;

      // ── Same native-scale tiling as createFramePlaneMaterial's drawImageTiled ──
      // The cove's picture must be pixel-for-pixel what the wall plane shows, so any
      // divergence here reopens the seam this mesh exists to hide. Note this canvas is
      // centred on the frame (ctx is translated to its centre), so tiles are laid out
      // around the origin rather than from a corner.
      const drawTiled = (img: HTMLImageElement, alpha: number) => {
        ctx.globalAlpha = alpha;
        if (!layout) {
          const scale = Math.min(fwPx / img.naturalWidth, fhPx / img.naturalHeight);
          const dw = img.naturalWidth * scale;
          const dh = img.naturalHeight * scale;
          ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
          ctx.globalAlpha = 1;
          return;
        }

        const tileWpx = layout.tile.width * pxPerU;
        const tileHpx = layout.tile.height * pxPerV;
        const { cols, rows } = layout;
        const originX = -(cols * tileWpx) / 2;
        const originY = -(rows * tileHpx) / 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(-fwPx / 2, -fhPx / 2, fwPx, fhPx);
        ctx.clip();
        drawSeamlessTileGrid(ctx, img, originX, originY, tileWpx, tileHpx, cols, rows);
        ctx.restore();
        ctx.globalAlpha = 1;
      };

      const fillRect = (style: string | CanvasGradient, alpha: number) => {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = style;
        ctx.fillRect(-fwPx / 2, -fhPx / 2, fwPx, fhPx);
        ctx.globalAlpha = 1;
      };

      const linearGradient = (colors: string[], angleDeg: number): CanvasGradient => {
        const angleRad = (angleDeg * Math.PI) / 180;
        const len = Math.sqrt(fwPx * fwPx + fhPx * fhPx) / 2;
        const grad = ctx.createLinearGradient(
          -Math.cos(angleRad) * len, -Math.sin(angleRad) * len,
          Math.cos(angleRad) * len, Math.sin(angleRad) * len
        );
        colors.forEach((c, i) => grad.addColorStop(i / Math.max(colors.length - 1, 1), c));
        return grad;
      };

      if (frame.type) {
        // ── Legacy format ──
        if (frame.type === 'color' && frame.color) {
          fillRect(frame.color, outer);
          drewAnything = true;
        } else if (frame.type === 'gradient' && frame.gradient) {
          const preset = GRADIENT_PRESETS.find(p => p.id === frame.gradient!.presetId);
          if (preset) {
            fillRect(linearGradient(preset.colors, frame.gradient.angle ?? preset.angle), outer);
            drewAnything = true;
          }
        } else if (frame.type === 'image' && frame.imageUrl) {
          const img = loadedImages.get(frame.imageUrl);
          if (img) { drawTiled(img, outer); drewAnything = true; }
        }
      } else {
        // ── Current format: background layer, then image layer on top ──
        // A fully opaque "cover" image reaches every edge of the frame, so the background
        // layer beneath it can only ever show as a dark rim where the two disagree by a
        // pixel — the black band that used to cut across the cove. Skip painting it.
        const imageHidesBackground = !!layout && (frame.imageOpacity ?? 1) >= 1;
        if (frame.backgroundEnabled !== false && !imageHidesBackground) {
          const bgAlpha = outer * (frame.backgroundOpacity ?? 1);
          if (frame.backgroundType === 'gradient' && frame.backgroundGradient) {
            const g = frame.backgroundGradient;
            fillRect(linearGradient(g.colors, g.angle), bgAlpha);
          } else {
            fillRect(frame.backgroundColor ?? '#1a1a1a', bgAlpha);
          }
          drewAnything = true;
        }
        if (frame.imageUrl) {
          const img = loadedImages.get(frame.imageUrl);
          if (img) { drawTiled(img, outer * (frame.imageOpacity ?? 1)); drewAnything = true; }
        }
      }

      ctx.restore();
    }

    return drewAnything ? canvas : null;
  }

  /**
   * Build the material for the curved corner fill so it reads as a continuation of the
   * wall rather than a separate strip.
   *
   * The cove has no styling of its own — it always mirrors the wall's *visible* surface.
   * Earlier versions cloned one "covering" frame's material, which only worked when a
   * single frame happened to span the whole wall: the default frame is 0.4 x 0.35, so an
   * image backdrop almost never qualified and the cove silently fell back to the bare wall
   * texture, showing the seam this mesh exists to hide.
   *
   * Instead the whole wall — every enabled frame, in order, over the wall material — is
   * composited into one canvas laid out in wall UV space, and that canvas is used as the
   * cove's map. The cove's UVs already continue the wall plane's UV space (see
   * `createCornerFillMesh`), so sampling it lands on exactly the strip of wall the cove
   * sits below, and any backdrop — flat colour, gradient, photo, full-bleed or not —
   * flows around the curve.
   *
   * The wall material underneath is painted in first so a partial frame blends into the
   * real wall at its edges exactly as it does on the wall plane itself.
   *
   * `cornerFill.color` is used only as a last-resort tint when the wall is the flat unlit
   * white surface and no frame resolves.
   */
  private buildCornerFillMaterial(
    cornerFill: CornerFillConfig,
    config: VideoStudioConfig,
    wallMeshMat: THREE.Material,
    surfaceEnv: THREE.Texture | null,
    wallImages: Map<string, HTMLImageElement>
  ): THREE.Material {
    /**
     * Fast path, matching the wall's own: a single frame that is a plain opaque tiled
     * image gets that tile at full source resolution, GPU-wrapped.
     *
     * The cove's UVs are a straight-down projection into the wall plane's UV space (see
     * `createCornerFillMesh`), so the wall's repeat/offset applies here unchanged — which
     * is precisely what keeps the curve identical to the surface above it. Taking the
     * baked-canvas path here while the wall takes the fast path would make the cove the
     * blurry strip instead.
     */
    const coveFrames = config.wallSurface.frames.filter(f => f.enabled);
    if (
      coveFrames.length === 1 &&
      coveFrames[0].imageUrl &&
      !coveFrames[0].type &&
      (coveFrames[0].imageOpacity ?? 1) >= 1 &&
      (coveFrames[0].opacity ?? 1) >= 1
    ) {
      const frame = coveFrames[0];
      const img = wallImages.get(frame.imageUrl!);
      const layout = img
        ? this.computeFrameTileLayout(frame, img, WALL_WIDTH, WALL_HEIGHT)
        : null;
      if (img && layout) {
        const tex = this.createTiledSourceTexture(img, layout, WALL_WIDTH, WALL_HEIGHT);
        if (tex) {
          this.coveShowsBareWall = false;
          if (config.surfaceLightDisabled) {
            const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
            mat.toneMapped = false;
            return mat;
          }
          const mat = new THREE.MeshStandardMaterial({
            map: tex,
            roughness: config.wallSurface.roughness ?? 0.95,
            metalness: 0,
            side: THREE.FrontSide,
          });
          if (surfaceEnv) {
            mat.envMap = surfaceEnv;
            mat.envMapIntensity = 0.6;
          }
          return mat;
        }
      }
    }

    const composite = this.renderWallCompositeCanvas(
      config.wallSurface, wallImages, WALL_WIDTH, WALL_HEIGHT, config.wallSurface.baseTint
    );
    this.coveShowsBareWall = !composite;

    if (composite) {
      const tex = new THREE.CanvasTexture(composite);
      tex.colorSpace = THREE.SRGBColorSpace;
      // The cove samples a thin horizontal band of this texture at a grazing angle, so
      // mipmaps + anisotropy are what keep it from aliasing into a shimmering line.
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;

      // Frame planes are unlit when surfaceLightDisabled, lit otherwise — the cove has to
      // take the same path or the identical pixels render as two different shades.
      if (config.surfaceLightDisabled) {
        const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
        // Unlit frame planes bypass tone mapping so colours display as authored.
        mat.toneMapped = false;
        return mat;
      }

      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: config.wallSurface.roughness ?? 0.95,
        metalness: 0,
        side: THREE.FrontSide,
      });
      if (surfaceEnv) {
        mat.envMap = surfaceEnv;
        mat.envMapIntensity = 0.6;
      }
      return mat;
    }

    // No frames at all — mirror the bare wall material.
    const clone = wallMeshMat.clone();
    clone.side = THREE.FrontSide;

    if (clone instanceof THREE.MeshStandardMaterial) {
      // Displacement would push the cove off its arc and reopen the seam it exists to close.
      clone.displacementMap = null;
      clone.displacementScale = 0;
      if (!config.surfaceLightDisabled) {
        clone.envMap = surfaceEnv;
        clone.envMapIntensity = 0.6;
      }
      clone.needsUpdate = true;
    } else if (clone instanceof THREE.MeshBasicMaterial) {
      // surfaceLightDisabled path: the wall is a flat white-immune material. Honour an
      // explicit cornerFill tint if one was set, otherwise stay identical to the wall.
      if (cornerFill.color && cornerFill.color !== '#ffffff') {
        clone.color = new THREE.Color(cornerFill.color);
      }
      clone.needsUpdate = true;
    }

    return clone;
  }

  /**
   * Work out how one tile of a frame's image should be laid out on a surface.
   *
   * The image is always drawn at its native scale — `frameImageTileSize` converts its
   * pixel dimensions into wall units at a fixed pixels-per-unit — so the photo is never
   * stretched to fit a rectangle and never resampled to a size it was not authored at.
   *
   * `contain` places exactly one such tile in the middle of the surface. `cover` repeats
   * it from the centre outwards until the surface is covered, so a material photo reads
   * as the wall itself. The tile count is always odd (1, 3, 5, …) which keeps a tile
   * centred and makes the clipped overflow symmetric at both edges.
   *
   * Returns null when the frame has no usable image, which tells the caller to fall back
   * to the frame's own width/height (the pre-native-size behaviour, still used by frames
   * that are pure colour or gradient).
   */
  private computeFrameTileLayout(
    frame: BackgroundFrame,
    img: HTMLImageElement | undefined,
    surfaceWidth: number,
    surfaceHeight: number
  ): FrameTileLayout | null {
    if (!img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;

    const tile = frameImageTileSize(
      img.naturalWidth,
      img.naturalHeight,
      frame.imageScale ?? DEFAULT_FRAME_IMAGE_SCALE
    );
    if (!(tile.width > 0) || !(tile.height > 0)) return null;

    // Always repeat-to-fill. The grid overhangs the surface on every side (see
    // frameTileGrid) so there is never an uncovered strip; the overhang is clipped.
    const { cols, rows } = frameTileGrid(tile.width, tile.height, surfaceWidth, surfaceHeight);
    // The plane itself is the size of the surface — that is what "hide the overflow" means.
    return { tile, cols, rows, planeWidth: surfaceWidth, planeHeight: surfaceHeight };
  }

  /**
   * Upload one tile of a frame's image at the source's own resolution, wrapped so the GPU
   * repeats it across the plane.
   *
   * `repeat` is the plane divided by the tile, in wall units — a fractional repeat is
   * expected and correct: the tile grid deliberately overhangs the surface so no strip is
   * left uncovered, and wrapping simply continues the pattern past the edge. `offset`
   * centres the pattern so the middle of the plane holds the middle of a tile, matching
   * where the canvas path drew it.
   *
   * The tile is capped to the GPU's max texture size and to a sane ceiling; a source
   * larger than that is downscaled once, on upload, which is still far more detail than
   * the baked-canvas path could hold.
   */
  private createTiledSourceTexture(
    img: HTMLImageElement,
    layout: FrameTileLayout,
    planeW: number,
    planeH: number
  ): THREE.Texture | null {
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;
    if (!(layout.tile.width > 0) || !(layout.tile.height > 0)) return null;

    const gpuMax = this.renderer.capabilities.maxTextureSize ?? 4096;
    const cap = Math.min(gpuMax, SURFACE_MAX_TEX);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);

    let source: HTMLImageElement | HTMLCanvasElement = img;
    if (longest > cap) {
      // One clean downscale to the cap. Done here rather than letting the driver do it so
      // the resample is high quality and mipmaps are built from the good result.
      const k = cap / longest;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const cctx = c.getContext('2d');
      if (!cctx) return null;
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(img, 0, 0, c.width, c.height);
      source = c;
    }

    const tex = new THREE.Texture(source);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(planeW / layout.tile.width, planeH / layout.tile.height);
    // Centre the pattern: shift back by half of whatever fraction of a tile the plane
    // does not divide evenly into.
    tex.offset.set(
      (1 - tex.repeat.x) / 2,
      (1 - tex.repeat.y) / 2
    );
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Create material for a frame plane based on its content.
   *
   * When `lit` is true the plane uses a MeshStandardMaterial so studio lights and
   * the surface env map affect the background image exactly like they affect the
   * bare wall/table. When false (the "disable light influence on surfaces" toggle)
   * it falls back to an unlit MeshBasicMaterial, so lights only shape the cue.
   */
  private createFramePlaneMaterial(
    frame: BackgroundFrame,
    loadedImages?: Map<string, HTMLImageElement>,
    planeW = 1,
    planeH = 1,
    lit = false,
    surfaceEnv?: THREE.Texture | null,
    surfaceRoughness?: number,
    tileLayout?: FrameTileLayout | null
  ): THREE.MeshBasicMaterial | THREE.MeshStandardMaterial {
    const opts: THREE.MeshBasicMaterialParameters = {
      transparent: true,
      opacity: frame.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    };

    // Compute canvas dimensions that match the plane's aspect ratio.
    // Matching the aspect ratio ensures textures are never stretched on non-square planes.
    //
    // The max side is driven by the source image's native resolution so a high-res
    // photo (e.g. 5472x3648) is not pre-downsampled to a small canvas before it ever
    // reaches the GPU. It is clamped to the GPU's max texture size (typically 8192-16384)
    // so we never exceed what WebGL can allocate.
    const gpuMaxTex = this.renderer.capabilities.maxTextureSize ?? 4096;
    const HARD_MAX_TEX = Math.min(gpuMaxTex, 8192);
    const BASE_MAX_TEX = 1024;

    // Largest source-image dimension across whatever this frame draws
    let srcMaxSide = 0;
    if (frame.imageUrl && loadedImages) {
      const srcImg = loadedImages.get(frame.imageUrl);
      if (srcImg) srcMaxSide = Math.max(srcImg.naturalWidth, srcImg.naturalHeight);
    }

    const planeAR = planeW / Math.max(planeH, 0.001);
    /**
     * Canvas resolution for the frame.
     *
     * Two demands, and the answer is the larger of them:
     *
     *  - Keep the source's own pixels. A tiled frame draws the (shrunk) image
     *    `cols` x `rows` times, so it needs `srcMaxSide * imageScale * spanTiles` to hold
     *    every tile at full detail.
     *  - Never drop below the backdrop's quality floor. The first demand alone *falls*
     *    as the tile is shrunk (a small tile needs few pixels per copy), which would make
     *    the wall softer precisely at the small scales that look right. `SURFACE_MIN_TEX`
     *    stops that: the backdrop is the largest thing in frame and is what the camera
     *    fills its shot with, so it always gets a full-quality texture.
     */
    const desiredMaxSide = (() => {
      if (srcMaxSide <= 0) return BASE_MAX_TEX;
      const nativeNeed = tileLayout
        ? Math.ceil(
            srcMaxSide *
              clampFrameImageScale(frame.imageScale ?? DEFAULT_FRAME_IMAGE_SCALE) *
              Math.max(tileLayout.cols, tileLayout.rows)
          )
        : srcMaxSide;
      // Only floor a frame that actually carries an image — a plain colour/gradient
      // rectangle gains nothing from a 4K canvas.
      const floor = frame.imageUrl ? SURFACE_MIN_TEX : BASE_MAX_TEX;
      return Math.max(BASE_MAX_TEX, floor, nativeNeed);
    })();
    const MAX_TEX = Math.min(desiredMaxSide, HARD_MAX_TEX);

    const canvasW = planeAR >= 1 ? MAX_TEX : Math.max(1, Math.round(MAX_TEX * planeAR));
    const canvasH = planeAR < 1 ? MAX_TEX : Math.max(1, Math.round(MAX_TEX / planeAR));

    /**
     * Draw the image at its native scale, tiled per the frame's layout.
     *
     * The canvas represents `planeW` x `planeH` wall units, so one tile takes up
     * `tile.width / planeW` of it — that ratio is what preserves the native pixel
     * mapping. Tiles are laid out from the centre so a single tile ("contain") lands
     * centred and a repeated grid ("cover") is symmetric, then clipped to the canvas so
     * the overflow at the edges is hidden.
     *
     * With no layout (no usable image) it falls back to fitting the image inside the
     * canvas, which is what a legacy `type: "image"` frame expects.
     */
    const drawImageTiled = (
      ctx: CanvasRenderingContext2D,
      img: HTMLImageElement,
      cW: number,
      cH: number,
      alpha: number
    ) => {
      ctx.globalAlpha = alpha;
      if (!tileLayout) {
        const scale = Math.min(cW / img.naturalWidth, cH / img.naturalHeight);
        const drawW = img.naturalWidth * scale;
        const drawH = img.naturalHeight * scale;
        ctx.drawImage(img, (cW - drawW) / 2, (cH - drawH) / 2, drawW, drawH);
        ctx.globalAlpha = 1;
        return;
      }

      const tileWpx = (tileLayout.tile.width / planeW) * cW;
      const tileHpx = (tileLayout.tile.height / planeH) * cH;
      const { cols, rows } = tileLayout;
      // Centre the grid on the canvas; it overhangs and is clipped.
      const originX = cW / 2 - (cols * tileWpx) / 2;
      const originY = cH / 2 - (rows * tileHpx) / 2;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cW, cH);
      ctx.clip();
      drawSeamlessTileGrid(ctx, img, originX, originY, tileWpx, tileHpx, cols, rows);
      ctx.restore();
      ctx.globalAlpha = 1;
    };

    const renderToCanvas = (): THREE.CanvasTexture => {
      const canvas = document.createElement("canvas");
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext("2d")!;
      // High-quality resampling when the source image is scaled into the canvas
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      if (frame.type) {
        // Legacy format
        if (frame.type === "color" && frame.color) {
          ctx.fillStyle = frame.color;
          ctx.fillRect(0, 0, canvasW, canvasH);
        } else if (frame.type === "gradient" && frame.gradient) {
          const preset = GRADIENT_PRESETS.find((p) => p.id === frame.gradient!.presetId);
          if (preset) {
            const angleDeg = frame.gradient.angle ?? preset.angle;
            const angleRad = (angleDeg * Math.PI) / 180;
            const len = Math.sqrt(canvasW * canvasW + canvasH * canvasH) / 2;
            const grad = ctx.createLinearGradient(
              canvasW / 2 - Math.cos(angleRad) * len, canvasH / 2 - Math.sin(angleRad) * len,
              canvasW / 2 + Math.cos(angleRad) * len, canvasH / 2 + Math.sin(angleRad) * len
            );
            preset.colors.forEach((c, i) => grad.addColorStop(i / (preset.colors.length - 1), c));
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, canvasW, canvasH);
          }
        } else if (frame.type === "image" && frame.imageUrl && loadedImages) {
          const img = loadedImages.get(frame.imageUrl);
          if (img) {
            drawImageTiled(ctx, img, canvasW, canvasH, 1);
          }
        }
      } else {
        // New format: background layer + image layer
        // Mirrors renderWallCompositeCanvas: an opaque "cover" image covers the frame
        // completely, so painting the background beneath it only risks a dark rim.
        const imageHidesBackground = !!tileLayout && (frame.imageOpacity ?? 1) >= 1;
        if (frame.backgroundEnabled !== false && !imageHidesBackground) {
          ctx.globalAlpha = frame.backgroundOpacity ?? 1;
          if (frame.backgroundType === "gradient" && frame.backgroundGradient) {
            const g = frame.backgroundGradient;
            const angleRad = (g.angle * Math.PI) / 180;
            const len = Math.sqrt(canvasW * canvasW + canvasH * canvasH) / 2;
            const grad = ctx.createLinearGradient(
              canvasW / 2 - Math.cos(angleRad) * len, canvasH / 2 - Math.sin(angleRad) * len,
              canvasW / 2 + Math.cos(angleRad) * len, canvasH / 2 + Math.sin(angleRad) * len
            );
            g.colors.forEach((c, i) => grad.addColorStop(i / Math.max(g.colors.length - 1, 1), c));
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, canvasW, canvasH);
          } else {
            ctx.fillStyle = frame.backgroundColor ?? "#1a1a1a";
            ctx.fillRect(0, 0, canvasW, canvasH);
          }
          ctx.globalAlpha = 1;
        }
        if (frame.imageUrl && loadedImages) {
          const img = loadedImages.get(frame.imageUrl);
          if (img) {
            drawImageTiled(ctx, img, canvasW, canvasH, frame.imageOpacity ?? 1);
          }
        }
      }

      const tex = new THREE.CanvasTexture(canvas);
      // Mark as sRGB so THREE.js correctly converts to linear on sampling
      tex.colorSpace = THREE.SRGBColorSpace;
      // Trilinear mipmapping + max anisotropy keeps fine grain (e.g. wall texture
      // speckle) crisp when the plane is viewed at an angle or minified, instead of
      // degrading to the blurry/aliased look of an unfiltered high-res texture.
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;
      return tex;
    };

    /**
     * Fast path: one tile at the source's own resolution, repeated by the GPU.
     *
     * Baking the whole tiled grid into one canvas caps texture density at
     * `FRAME_PIXELS_PER_UNIT` (~60 px per wall unit) no matter how large the source is,
     * because the canvas only ever covers the plane once. A camera that fills its shot
     * with a few wall units needs 250-500 px/unit, so the backdrop went soft exactly when
     * the shot was tight — while the cue, whose own textures are not laid out this way,
     * stayed sharp. That contrast is the giveaway.
     *
     * Uploading a single tile and setting `wrapS/wrapT = RepeatWrapping` with
     * `repeat = surface / tile` gives the same picture with the tile at FULL source
     * resolution: density becomes `sourcePx / tileUnits`, which is 5-10x higher at the
     * scales that look right and improves further as the tile shrinks. The GPU's own
     * wrapping also makes the tile joins exact, so no seam treatment is needed.
     *
     * Only taken when the frame is a plain opaque image — anything that needs the canvas
     * compositor (a visible background layer, partial opacity, a legacy `type` frame)
     * falls through to `renderToCanvas`.
     */
    // A tiled opaque image reaches every pixel of the plane, so the frame's background
    // layer is invisible underneath it either way and does not need the compositor. What
    // does need it is partial opacity or a legacy `type` frame.
    const canUseRepeatWrap =
      !!tileLayout &&
      !!frame.imageUrl &&
      !frame.type &&
      (frame.imageOpacity ?? 1) >= 1 &&
      !!loadedImages?.get(frame.imageUrl);

    if (canUseRepeatWrap && tileLayout) {
      const img = loadedImages!.get(frame.imageUrl!)!;
      const tex = this.createTiledSourceTexture(img, tileLayout, planeW, planeH);
      if (tex) {
        if (lit) {
          const litMat = new THREE.MeshStandardMaterial({
            map: tex,
            transparent: true,
            opacity: frame.opacity,
            side: THREE.DoubleSide,
            depthWrite: false,
            roughness: surfaceRoughness ?? 0.95,
            metalness: 0,
          });
          if (surfaceEnv) {
            litMat.envMap = surfaceEnv;
            litMat.envMapIntensity = 0.6;
          }
          return litMat;
        }
        const basic = new THREE.MeshBasicMaterial({ ...opts, map: tex });
        basic.toneMapped = false;
        return basic;
      }
    }

    const map = renderToCanvas();

    if (lit) {
      // Lit path: studio lights and the surface env map shade the background image
      // just like the bare wall/table surface.
      const litMat = new THREE.MeshStandardMaterial({
        map,
        transparent: true,
        opacity: frame.opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        roughness: surfaceRoughness ?? 0.95,
        metalness: 0,
      });
      if (surfaceEnv) {
        litMat.envMap = surfaceEnv;
        litMat.envMapIntensity = 0.6;
      }
      // Tone mapping stays ENABLED here: a lit surface must go through the same
      // tone-mapping curve as the rest of the scene, otherwise its response to
      // light intensity would not match the wall it sits on.
      return litMat;
    }

    const mat = new THREE.MeshBasicMaterial({ ...opts, map });
    // Disable tone mapping so frames display original colors regardless of renderer settings
    mat.toneMapped = false;
    return mat;
  }

  /** Build frame plane meshes for a surface and add to scene */
  private buildFramePlanes(
    surface: SurfaceConfig,
    parentMesh: THREE.Mesh,
    isTable: boolean,
    loadedImages?: Map<string, HTMLImageElement>,
    lit = false,
    surfaceEnv?: THREE.Texture | null
  ): THREE.Mesh[] {
    const planes: THREE.Mesh[] = [];
    const enabledFrames = surface.frames.filter(f => f.enabled);

    for (let i = 0; i < enabledFrames.length; i++) {
      const frame = enabledFrames[i];

      const frameImg = frame.imageUrl ? loadedImages?.get(frame.imageUrl) : undefined;

      if (isTable) {
        const tableWidth = WALL_WIDTH;
        const tableDepth = 12;
        // An image frame is laid out at the image's native scale; only colour/gradient
        // frames still take their size from frame.width / frame.height.
        const layout = this.computeFrameTileLayout(frame, frameImg, tableWidth, tableDepth);
        const pw = layout ? layout.planeWidth : frame.width * tableWidth;
        const pd = layout ? layout.planeHeight : frame.height * tableDepth;
        const material = this.createFramePlaneMaterial(
          frame, loadedImages, pw, pd, lit, surfaceEnv, surface.roughness ?? 0.35, layout
        );
        const geo = new THREE.PlaneGeometry(pw, pd);
        const mesh = new THREE.Mesh(geo, material);
        // A lit frame stands in for the table surface, so it must catch shadows too
        mesh.receiveShadow = lit;

        const covers = !!layout;
        const tablePos = parentMesh.position;
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(
          tablePos.x + (covers ? 0 : (frame.x - 0.5) * tableWidth),
          tablePos.y + 0.01 * (i + 1),
          tablePos.z + (covers ? 0 : (frame.y - 0.5) * tableDepth)
        );
        mesh.rotation.z = covers ? 0 : (frame.rotation * Math.PI) / 180;
        mesh.userData = { type: 'tableFrame', frameId: frame.id, frameIndex: i };
        this.scene.add(mesh);
        planes.push(mesh);
      } else {
        const wallWidth = WALL_WIDTH;
        const wallHeight = WALL_HEIGHT;
        const layout = this.computeFrameTileLayout(frame, frameImg, wallWidth, wallHeight);
        const pw = layout ? layout.planeWidth : frame.width * wallWidth;
        const ph = layout ? layout.planeHeight : frame.height * wallHeight;
        const material = this.createFramePlaneMaterial(
          frame, loadedImages, pw, ph, lit, surfaceEnv, surface.roughness ?? 0.95, layout
        );
        const geo = new THREE.PlaneGeometry(pw, ph);
        const mesh = new THREE.Mesh(geo, material);
        // A lit frame stands in for the wall surface, so it must catch shadows too
        mesh.receiveShadow = lit;

        // A covering frame IS the surface, so it sits centred on it — its x/y would only
        // slide the full-wall plane off the wall's edge. Everything else honours x/y.
        const covers = !!layout;
        const wallPos = parentMesh.position;
        mesh.position.set(
          wallPos.x + (covers ? 0 : (frame.x - 0.5) * wallWidth),
          wallPos.y + (covers ? 0 : (0.5 - frame.y) * wallHeight),
          wallPos.z + 0.01 * (i + 1)
        );
        mesh.rotation.z = covers ? 0 : (frame.rotation * Math.PI) / 180;
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
      const mat = mesh.material as FramePlaneMaterial;
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
      const wallWidth = WALL_WIDTH;
      const wallHeight = WALL_HEIGHT;
      const wallFrames = config.wallSurface.frames.filter(f => f.enabled);

      for (const mesh of this.wallFramePlanes) {
        const frame = wallFrames.find(f => f.id === mesh.userData.frameId);
        if (!frame) continue;
        // A plane built to span the whole surface is a covering frame — keep it centred
        // and unrotated, exactly as buildFramePlanes placed it.
        const covers =
          !!frame.imageUrl &&
          (mesh.geometry as THREE.PlaneGeometry).parameters.width >= wallWidth;
        mesh.position.set(
          wallPos.x + (covers ? 0 : (frame.x - 0.5) * wallWidth),
          wallPos.y + (covers ? 0 : (0.5 - frame.y) * wallHeight),
          wallPos.z + 0.01 * (mesh.userData.frameIndex + 1)
        );
        mesh.rotation.z = covers ? 0 : (frame.rotation * Math.PI) / 180;
        // An image frame's plane is built at the image's native size; rescaling it from
        // frame.width / frame.height would squash the photo and break the pixel mapping
        // the native layout exists to guarantee. Only colour/gradient frames scale.
        if (frame.imageUrl) {
          mesh.scale.set(1, 1, 1);
        } else {
          const pw = frame.width * wallWidth;
          const ph = frame.height * wallHeight;
          mesh.scale.set(pw / (mesh.geometry as THREE.PlaneGeometry).parameters.width,
                         ph / (mesh.geometry as THREE.PlaneGeometry).parameters.height, 1);
        }
        (mesh.material as FramePlaneMaterial).opacity = frame.opacity;
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
        const covers =
          !!frame.imageUrl &&
          (mesh.geometry as THREE.PlaneGeometry).parameters.width >= tableWidth;
        mesh.position.set(
          tablePos.x + (covers ? 0 : (frame.x - 0.5) * tableWidth),
          tablePos.y + 0.01 * (mesh.userData.frameIndex + 1),
          tablePos.z + (covers ? 0 : (frame.y - 0.5) * tableDepth)
        );
        mesh.rotation.set(-Math.PI / 2, 0, covers ? 0 : (frame.rotation * Math.PI) / 180);
        if (frame.imageUrl) {
          mesh.scale.set(1, 1, 1);
        } else {
          const pw = frame.width * tableWidth;
          const pd = frame.height * tableDepth;
          mesh.scale.set(pw / (mesh.geometry as THREE.PlaneGeometry).parameters.width,
                         pd / (mesh.geometry as THREE.PlaneGeometry).parameters.height, 1);
        }
        (mesh.material as FramePlaneMaterial).opacity = frame.opacity;
      }
    }

    // Always sync corner fill visibility from latest config
    this.syncCornerFillVisibility(config);
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
      this._lastAppliedCameraStartKey = `${config.cameraStart.x},${config.cameraStart.y},${config.cameraStart.z},${config.cameraStart.rotationX ?? 0},${config.cameraStart.rotationY ?? 0},${config.cameraStart.rotationZ ?? 0}`;
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
      // Drive the neon flicker off the preview's own elapsed time.
      this._logoElapsed += deltaMs / 1000;
      this.logoBackdrop?.setElapsed(this._logoElapsed);
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

    // Colour of the void outside the wall/table planes
    this.setSceneBackgroundColor(config.sceneBackground?.color ?? DEFAULT_SCENE_BACKGROUND.color);

    // Giant camera-locked logo plate behind the cue
    this.setLogoBackdrop(config.logoBackdrop, resolveLogoBackdropUrl(config.logoBackdrop, this.productLogoId));

    // Update cue instances
    this.updateCueInstances(config.cueConfig);

    // Sync frame plane positions/scales from config
    this.updateFramePlaneTransforms(config);

    this.syncCornerFillVisibility(config);

    // Apply shadow settings
    this.updateShadowFromConfig(config);

    // Apply HDRI intensity
    this.updateHdriIntensity(config);

    // Apply surface HDRI separation
    this.updateSurfaceHdri(config);

    // The cove paints itself from the wall, so a surface tint change has to repaint it too.
    // This runs AFTER updateSurfaceHdri so that when the cove clones the bare wall material
    // it copies the tint just applied, not the previous frame's.
    this.refreshCornerFillMaterial(config);

    // Update HDRI light helpers
    this.updateHdriLightHelpers(config);

    // Sync camera position from config ONLY if cameraStart actually changed.
    // Skipping on unrelated config changes (e.g. cue position) prevents the camera
    // from jumping back to the stored keyframe while the user has moved it via gizmo.
    // _cameraPlacementMode is intentionally NOT checked here — it was previously blocking
    // template camera loading when the user was in "camera" view mode.
    // With a curve path the opening frame comes from the path's own span, so the preview
    // matches what will be recorded even if cameraStart drifted.
    const previewStart = this.resolveStartKeyframe(config);
    const camKey = `${previewStart.x},${previewStart.y},${previewStart.z},${previewStart.rotationX ?? 0},${previewStart.rotationY ?? 0},${previewStart.rotationZ ?? 0}`;
    if (camKey !== this._lastAppliedCameraStartKey) {
      this._lastAppliedCameraStartKey = camKey;
      this.setCameraFromKeyframe(previewStart);
    }

    // Keep the scene-view path overlay in step with the config (preset switches, waypoint
    // edits, curve-type changes all land here via the debounced config sync).
    this.updateCameraPathVisuals(config);
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
    // When surfaceLightDisabled the wall/table use MeshBasicMaterial — skip all env map
    // updates, but the base tint still has to land or the colour picker would do nothing
    // in that mode. There is no texture to multiply, so the tint IS the material colour.
    if (config.surfaceLightDisabled) {
      const unlit: Array<[THREE.Mesh | null, string | null | undefined]> = [
        [this.backdrop, config.wallSurface.baseTint],
        [this.tableSurface, config.tableSurface.baseTint],
        [this.coveShowsBareWall ? this.studioCornerFill : null, config.wallSurface.baseTint],
      ];
      for (const [mesh, tint] of unlit) {
        if (!mesh) continue;
        const mat = mesh.material;
        if (mat instanceof THREE.MeshBasicMaterial) mat.color.set(tint || '#ffffff');
      }
      return;
    }

    // Use the first enabled studio light's color for surface tint
    const firstEnabledLayer = (config.hdriConfig?.layers ?? []).find(l => l.enabled !== false);
    const surfaceColor = firstEnabledLayer?.lightColor ?? '#ffffff';
    const surfaceEnv = this.getSurfaceEnvMap(surfaceColor);

    const targets: Array<{ mesh: THREE.Mesh | null; roughness?: number; tint?: string | null }> = [
      { mesh: this.backdrop, roughness: config.wallSurface.roughness, tint: config.wallSurface.baseTint },
      { mesh: this.tableSurface, roughness: config.tableSurface.roughness, tint: config.tableSurface.baseTint },
      // The corner fill always mirrors the wall, so it takes the wall's roughness and tint —
      // a cove with a different sheen or hue reads as a separate strip.
      //
      // Only when the cove is showing the bare wall, though: once a frame paints over the
      // wall the cove's map is the wall composite, which already has the tint baked into the
      // pixels it copied. Tinting that a second time would double it.
      {
        mesh: this.coveShowsBareWall ? this.studioCornerFill : null,
        roughness: config.wallSurface.roughness,
        tint: config.wallSurface.baseTint,
      },
    ];

    for (const { mesh, roughness, tint } of targets) {
      if (!mesh) continue;
      // The corner fill can be a MeshBasicMaterial (unlit wall / unlit frame), which has
      // no envMap and must not be touched here.
      if (!(mesh.material instanceof THREE.MeshStandardMaterial)) continue;
      const mat = mesh.material;
      mat.envMap = surfaceEnv;
      mat.envMapIntensity = 0.6;
      applySurfaceTint(mat, tint);
      if (roughness != null) {
        mat.roughness = roughness;
      }
    }
  }

  /** Record video using the new start/end camera animation system */
  /**
   * Records a take deterministically: every frame is rendered, handed to `sink`,
   * and only then is the next one drawn. There is no wall clock anywhere in the
   * pipeline, so no frame can be dropped however slow a render turns out to be.
   *
   * `sink` is required — it is what turns the frames into a file. The worker
   * passes one backed by ffmpeg; the browser passes createWebCodecsFrameSink().
   */
  async startStudioRecording(
    config: VideoStudioConfig,
    onProgress: ((progress: number) => void) | undefined,
    sink: DeterministicFrameSink,
    /**
     * Renders at `supersample`x the output size and lets the sink shrink each
     * frame back down.
     *
     * MSAA is capped by the driver — Chrome on Apple silicon offers only
     * MAX_SAMPLES = 4 through ANGLE/Metal, where the pod's NVIDIA stack offers
     * more — and that cap is visible as smeared leather grain and wood figure.
     * Rendering large sidesteps the cap entirely: every output pixel is the
     * average of `supersample`^2 rendered samples.
     *
     * Costs `supersample`^2 the fill rate, so 2 is 4x the pixels per frame.
     */
    supersample = 1
  ): Promise<Blob> {
    if (!this.model) throw new Error('No model loaded');
    this._recordingCanceled = false;

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
      this.renderer.setSize(dims.width * supersample, dims.height * supersample, false);
      // Aspect comes from the output, not the render size — supersampling scales
      // both axes equally, so the framing must not move.
      this.camera.aspect = dims.width / dims.height;
      // Re-fit the logo plate to the recording frame. The editor canvas is a different
      // shape from the output, so without this the plate would be laid out for the
      // preview's aspect and come out stretched (or cropped) in the file.
      this.applyBackdropAspect(dims.width / dims.height);
      this.camera.updateProjectionMatrix();

      this.setupStudioFromStudioConfig(config).then(async () => {
        this.setCameraFromKeyframe(this.resolveStartKeyframe(config));
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

        this._runDeterministicRecording(config, dims, sink, onProgress)
          .then(resolve)
          .catch(reject);
      }).catch(reject);
    });
  }


  /**
   * Deterministic, frame-by-frame recording — the only recording path.
   *
   * It replaced a real-time loop that drove the animation from the wall clock
   * and let captureStream sample the canvas whenever it liked. That had two
   * failure modes, both removed here:
   *
   *  1. A render that overran 1000/fps ms lost every frame it stepped past —
   *     captureStream offers no backpressure, so the camera jumped and the file
   *     stuttered even though the GPU was never the limit.
   *  2. MediaRecorder encoded in software while the page was still rendering.
   *     Asked for 20 Mbps it delivered roughly 8, silently trading quality to
   *     keep up with real time.
   *
   * Here time is an INDEX, not a clock. Frame N is rendered, handed to the sink,
   * and only when the sink resolves does frame N+1 begin. A frame may take a
   * second; the output is unaffected, because nothing is sampling. Encoding is
   * never racing the render — ffmpeg runs afterwards on the pod, and WebCodecs
   * encodes under backpressure in the browser — so the requested quality is the
   * quality that lands.
   *
   * The trade is wall-clock time: every frame must actually be rendered, so this
   * is slower than real time by roughly (render_ms * fps / 1000). Callers on a
   * metered pod must size their job timeout accordingly.
   */
  private async _runDeterministicRecording(
    config: VideoStudioConfig,
    dims: { readonly width: number; readonly height: number; readonly bitrate: number; readonly fps: number },
    sink: DeterministicFrameSink,
    onProgress?: (progress: number) => void
  ): Promise<Blob> {
    this.stopVideoPreview();

    // Same start-of-take reset as the real-time path: the warmup renders yield to
    // the event loop, and a stale orbit handler could have moved the camera since.
    this.setCameraFromKeyframe(this.resolveStartKeyframe(config));
    this.setHelpersVisible(false);

    // ── Scene graph freeze (identical to the real-time path) ──────────────────
    // Studio geometry is static; only the camera moves. Skipping the scene-graph
    // traversal in WebGLRenderer.render() is worth more here than in real time,
    // because here every single frame is rendered rather than sampled.
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

    const savedSpinY = config.cueConfig.spinY || 0;
    const savedSpinX = config.cueConfig.spinX || 0;
    const savedSpinZ = config.cueConfig.spinZ || 0;

    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();

    const effectiveEnd = applyDirection(config.cameraStart, config.cameraEnd, "xyz");
    const duration = computeVideoDuration(
      config.cameraStart,
      config.cameraEnd,
      config.cameraSpeed,
      "xyz",
      isCameraFixed(config.cameraStart, config.cameraEnd, config.cameraPath)
        ? config.fixedCameraDuration
        : undefined,
      config.cameraPath
    );
    const easingFn = createEasingFunction(config.easing);

    const fps = dims.fps;
    // Exact frame count. There is no encoder warmup to trim and no wall clock to
    // over- or under-run: the file is exactly this many frames long, so the
    // duration in the container is exactly `duration` seconds.
    const totalFrames = Math.max(1, Math.round(duration * fps));

    // Spin per frame, matching the real-time path so a config recorded either
    // way spins at the same angular velocity.
    const SPIN_REF_MS = 1000 / 60;
    const spinPerFrame = (1000 / fps) / SPIN_REF_MS;

    const cue = config.cueConfig;
    const hasSpinY = cue.spinSpeed > 0;
    const hasSpinX = (cue.spinSpeedX || 0) > 0;
    const hasAnySpin = hasSpinY || hasSpinX;

    const start = config.cameraStart;
    const kf = {
      x: start.x, y: start.y, z: start.z,
      rotationX: start.rotationX ?? 0,
      rotationY: start.rotationY ?? 0,
      rotationZ: start.rotationZ ?? 0,
    };
    const pathSampler = createCameraPathSampler(
      start,
      effectiveEnd,
      config.cameraPath,
      this.getCuePathLookTarget()
    );

    console.log('[VideoStudio] deterministic recording ' + JSON.stringify({
      frames: totalFrames,
      fps,
      duration: `${duration.toFixed(1)}s`,
      size: `${dims.width}x${dims.height}`,
    }));

    const canvas = this.renderer.domElement;
    /** Cleared until finish() returns, so the finally block knows to abort. */
    let completed = false;
    let slowestFrameMs = 0;
    // Per-stage totals. A frame costs render + readback + handoff, and only
    // measuring the sum leaves you guessing which one to attack.
    let renderGpuMs = 0;
    let readbackMs = 0;
    let sinkMs = 0;
    const startedAt = performance.now();

    try {
      for (let frame = 0; frame < totalFrames; frame++) {
        if (this.isDisposed) throw new Error('Recording disposed');
        // stopRecording() sets this. Checked per frame so "Dừng" takes effect
        // within one frame rather than at the end of the take — the deterministic
        // loop has no requestAnimationFrame for stopRecording to cancel.
        if (this._recordingCanceled) throw new RecordingCanceledError();

        const frameT0 = performance.now();

        // Spin is advanced BEFORE the render, once per frame, exactly like the
        // real-time loop — so frame N shows N steps of rotation in both paths.
        if (hasAnySpin) {
          this.spinCueInstances(
            hasSpinY ? cue.spinSpeed * 0.02 * spinPerFrame : 0,
            hasSpinX ? (cue.spinSpeedX || 0) * 0.02 * spinPerFrame : 0
          );
        }

        // Progress is the frame's position in the sequence. Dividing by
        // (totalFrames - 1) makes the last frame land exactly on easing(1), so a
        // camera path ends precisely where the operator placed its end keyframe.
        const t = totalFrames > 1 ? frame / (totalFrames - 1) : 1;
        pathSampler.sample(easingFn(t), kf);
        this.camera.position.set(kf.x, kf.y, kf.z);
        this.camera.rotation.set(kf.rotationX, kf.rotationY, kf.rotationZ);
        if (hasAnySpin && this.clonedModel && this.instancedMeshes.length === 0) {
          this.clonedModel.updateMatrixWorld(true);
        }
        this.logoBackdrop?.setElapsed(frame / fps);
        this.renderWithBackdrop(this.camera);
        const afterRender = performance.now();
        renderGpuMs += afterRender - frameT0;

        // Hand the frame over. A sink in this process (the browser's WebCodecs
        // encoder) takes the canvas as-is; the worker's has to go through PNG
        // because its frames cross into Node as JSON, where binary cannot go.
        //
        // The PNG branch is the expensive one: compression at 2K is
        // single-threaded main-thread work that costs more than drawing the
        // frame did, which is what the per-stage timings below make visible.
        //
        // Either way this await is THE backpressure point — until the sink has
        // frame N, frame N+1 is not rendered, which is precisely why no frame
        // can be lost.
        let afterReadback: number;
        if (sink.writeCanvasFrame) {
          afterReadback = performance.now();
          readbackMs += afterReadback - afterRender;
          await sink.writeCanvasFrame(frame, canvas);
        } else {
          const blob = await new Promise<Blob>((resolveBlob, rejectBlob) => {
            canvas.toBlob(
              (b) => (b ? resolveBlob(b) : rejectBlob(new Error(`toBlob returned null at frame ${frame}`))),
              'image/png'
            );
          });
          afterReadback = performance.now();
          readbackMs += afterReadback - afterRender;
          await sink.writeFrame(frame, blob);
        }
        sinkMs += performance.now() - afterReadback;

        const frameMs = performance.now() - frameT0;
        if (frameMs > slowestFrameMs) slowestFrameMs = frameMs;

        onProgress?.(Math.round(((frame + 1) / totalFrames) * 100));
      }

      const renderMs = performance.now() - startedAt;
      // JSON.stringify, not a bare object: Puppeteer forwards console arguments
      // as strings, so an object logged directly reaches the pod log as
      // "[object Object]" and every measurement in it is lost.
      console.log('[VideoStudio] frames complete ' + JSON.stringify({
        frames: totalFrames,
        renderSec: Number((renderMs / 1000).toFixed(1)),
        avgFrameMs: Number((renderMs / totalFrames).toFixed(1)),
        slowestFrameMs: Number(slowestFrameMs.toFixed(1)),
        // Splits the per-frame cost into the two things that can dominate it:
        // drawing the frame on the GPU, versus getting it off the canvas and
        // across to Node. They call for completely different fixes.
        avgRenderMs: Number((renderGpuMs / totalFrames).toFixed(1)),
        avgReadbackMs: Number((readbackMs / totalFrames).toFixed(1)),
        avgSinkMs: Number((sinkMs / totalFrames).toFixed(1)),
      }));

      const muxed = await sink.finish(totalFrames, fps);
      if (!muxed) {
        throw new Error('Frame sink returned no video: nothing muxed the frames');
      }
      completed = true;
      return muxed;
    } finally {
      // A take that ended any other way — cancelled, disposed, or thrown out of
      // — never reached finish(), so the sink is still holding its resources.
      // For the WebCodecs sink those are GPU buffers that outlive garbage
      // collection, and a few abandoned takes exhaust the pool.
      if (!completed) sink.abort?.();
      // Restore everything the freeze above changed, so a later preview or a
      // second take is unaffected. Mirrors restoreRecordingState in the
      // real-time path.
      this.setHelpersVisible(true);
      this.scene.matrixWorldAutoUpdate = true;
      for (const obj of frozenObjects) {
        obj.matrixAutoUpdate = true;
      }
      this.renderer.shadowMap.autoUpdate = true;
      if (this._recordingSavedShadowType !== null) {
        this.renderer.shadowMap.type = this._recordingSavedShadowType;
      }
      config.cueConfig.spinY = savedSpinY;
      config.cueConfig.spinX = savedSpinX;
      config.cueConfig.spinZ = savedSpinZ;
    }
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
   * Colour of the empty space surrounding the V1 wall/table set.
   *
   * V1 only builds two planes; everything the camera sees past their edges is the scene
   * background, which is why painting the wall and the table black still left a lighter
   * border around them. This is the knob for that border.
   */
  setSceneBackgroundColor(color: string): void {
    if (color === this._sceneBackgroundColor) return;
    this._sceneBackgroundColor = color;
    // A transparent capture is mid-flight and owns the background until it finishes;
    // setTransparentBackground(false) will pick the new colour up on the way out.
    if (this._transparentBackground) return;
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.set(color);
    } else {
      this.scene.background = new THREE.Color(color);
    }
  }

  /**
   * Configure the giant camera-locked logo plate behind the cue.
   *
   * `url` must already be resolved (the caller knows the product's own logoId and the
   * CUE_LOGO_OPTIONS catalog); pass null to draw nothing.
   */
  setLogoBackdrop(config: LogoBackdropConfig | undefined | null, url: string | null): void {
    if (this.isDisposed) return;
    if (!config?.enabled) {
      // Keep the instance alive: toggling the plate off and on again is a common edit,
      // and re-decoding the logo texture each time would stutter the preview.
      this.logoBackdrop?.setConfig({ ...(config ?? DEFAULT_LOGO_BACKDROP), enabled: false }, url);
      // Turning the plate off has to take its MESH out of the scene, not merely mark the
      // plate inactive. In wall mode the mesh is ordinary set geometry that the main pass
      // draws on its own, so leaving it parented kept the logo on screen after the toggle
      // was cleared — the "off" switch appeared to do nothing.
      this.syncLogoBackdropMesh();
      return;
    }
    if (!this.logoBackdrop) {
      this.logoBackdrop = new LogoBackdrop();
      // Bound once at creation: `this.camera` is built in the constructor and never
      // reassigned, so the plate's frame reference stays valid for the whole session.
      this.logoBackdrop.setFrameCamera(this.camera);
      // The plate only becomes `active` once its image has decoded, which is always after
      // the synchronous mesh check below has already run and concluded there was nothing to
      // add. Re-running it on load is what makes a saved template show its logo immediately
      // instead of waiting for the next unrelated edit.
      this.logoBackdrop.onReady = () => {
        this.syncLogoBackdropMesh();
        this.render();
      };
    }
    this.logoBackdrop.setViewportAspect(this.viewportAspectForBackdrop);
    // Frame-relative placement is measured against the PRODUCTION camera, never the
    // scene-view god camera: the plate has to be composed against the shot that will be
    // recorded, not against whatever angle the editor is inspecting from.
    this.logoBackdrop.setFrameCamera(this.camera);
    this.logoBackdrop.setConfig(config, url);
    this.syncLogoBackdropMesh();
  }

  /**
   * Keep the wall-anchored plate attached to the studio scene.
   *
   * In wall mode the plate is ordinary set geometry, so it has to live in the scene the
   * main pass renders — that is what makes the cue occlude it and gives it the set's
   * perspective. In screen mode it belongs to the overlay scene instead, so it must be
   * removed from here or it would be drawn twice.
   */
  private syncLogoBackdropMesh(): void {
    const backdrop = this.logoBackdrop;
    if (!backdrop) return;
    const mesh = backdrop.worldMesh;
    const wantsWorld = backdrop.active && backdrop.anchor === "wall";
    if (wantsWorld) {
      if (mesh.parent !== this.scene) {
        mesh.removeFromParent();
        this.scene.add(mesh);
      }
      mesh.userData = { type: 'logoBackdrop' };
    } else if (mesh.parent === this.scene) {
      this.scene.remove(mesh);
    }
  }

  /**
   * Tell the studio which logo is engraved on the cue, so a plate set to "auto" draws
   * the same mark. Safe to call before any plate exists.
   */
  setProductLogoId(logoId: string | null): void {
    this.productLogoId = logoId;
  }

  /** Re-fit the logo plate to a differently shaped render target. */
  private applyBackdropAspect(aspect: number): void {
    if (!isFinite(aspect) || aspect <= 0) return;
    this.viewportAspectForBackdrop = aspect;
    this.logoBackdrop?.setViewportAspect(aspect);
  }

  /**
   * Tell the logo plate what shape the frame is, from the studio's selected video ratio.
   *
   * Called when the ratio changes and before recording starts, so the plate that appears
   * in the preview is the plate that ends up in the file.
   */
  setLogoBackdropAspect(aspect: number): void {
    this.applyBackdropAspect(aspect);
  }

  /**
   * Render the scene with the logo plate composited behind it.
   *
   * The plate is drawn into the same buffer BEFORE the main scene, with the main scene's
   * automatic clear suppressed for that one call — that is what puts the cue in front of
   * the plate while keeping the plate locked to the frame. With no active plate this is
   * exactly `renderer.render(scene, camera)`.
   *
   * Skipped during a transparent capture: an alpha PNG must keep its empty pixels empty,
   * and a full-frame backdrop would fill every one of them.
   */
  private renderWithBackdrop(camera: THREE.Camera, opacityScale = 1): void {
    const backdrop = this.logoBackdrop;

    // A frame-relative plate is re-placed from the production camera's current pose before
    // anything draws, so it holds its spot in the shot as the camera travels.
    backdrop?.syncToFrame();

    if (!backdrop?.active || this._transparentBackground) {
      // An inactive plate must be HIDDEN, not merely skipped. In wall mode its mesh is
      // ordinary set geometry that this render call draws on its own, so a plate that was
      // switched off (or whose texture is gone) would otherwise stay on screen.
      // A transparent capture hides it for the same reason: an alpha PNG has to keep its
      // empty pixels empty.
      backdrop?.setWorldVisible(false);
      this.renderer.render(this.scene, camera);
      return;
    }
    backdrop.setWorldVisible(true);

    // The blur runs into offscreen render targets, so it has to happen before any pass
    // binds a target of its own.
    const ready = backdrop.prepare(this.renderer);

    if (backdrop.anchor === "wall") {
      // The plate is real set geometry sitting in front of the back wall: it is already
      // in this.scene, so the ordinary render draws it, the cue occludes it, and it takes
      // the set's perspective. Nothing else to do.
      this.renderer.render(this.scene, camera);
      return;
    }

    if (!ready) {
      this.renderer.render(this.scene, camera);
      return;
    }

    // ── Screen-anchored: draw the scene, then the plate as an overlay ON TOP. ──
    //
    // The plate used to be drawn FIRST, as a backdrop behind the scene. That works only
    // when there is empty space behind the subject to see it through — and V1's set has a
    // 34x24 opaque wall filling the whole frame, so the wall painted straight over the
    // plate and a screen-locked logo appeared to do nothing at all.
    //
    // Drawn last it is what the name promises: locked to the frame, always visible, holding
    // its position while the camera moves. Its own pass uses a fixed orthographic camera,
    // so nothing about the studio camera's motion reaches it.
    const savedAutoClear = this.renderer.autoClear;

    this.renderer.render(this.scene, camera);

    // The overlay must not be depth-rejected by the scene it sits on top of, and must not
    // leave depth of its own behind for the next frame's geometry to test against.
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    backdrop.render(this.renderer, opacityScale);

    this.renderer.autoClear = savedAutoClear;
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
    // A wall-anchored plate is set geometry and renders identically in every view.
    // A SCREEN-anchored plate, though, is locked to the production frame — in scene view
    // the god camera roams while the plate stays glued to the viewport, so it is dimmed
    // there to keep the geometry being edited visible underneath it. The minimap and the
    // recording always draw it at full strength.
    const dim =
      this.isSceneView && this.logoBackdrop?.anchor === "screen"
        ? SCENE_VIEW_BACKDROP_DIM
        : 1;
    this.renderWithBackdrop(cam, dim);
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
    // Offscreen render target no longer needed — we use drawImage() from main canvas
    if (this._minimapTarget) {
      this._minimapTarget.dispose();
      this._minimapTarget = null;
      this._minimapBuf = null;
    }
  }

  /** Internal: render production camera to main WebGL canvas, copy via drawImage to minimap canvas.
   *  Same pipeline as _updatePreviewInternal — includes tone mapping + sRGB encoding so colours match. */
  private _updateMinimapInternal(): void {
    const canvas = this._minimapCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Drive the minimap aspect from the canvas element itself so the preview always
    // matches the selected video ratio (the caller sizes the canvas from the ratio).
    const MINIMAP_W = canvas.width || ExtractorSceneManager.MINIMAP_W;
    const MINIMAP_H = canvas.height || ExtractorSceneManager.MINIMAP_H;

    // Hide ALL editor helpers so they don't appear in the minimap
    this.setHelpersVisible(false);

    // Hide TransformControls gizmos
    const hiddenObjs: THREE.Object3D[] = [];
    this.scene.traverse((obj) => {
      if (obj.type.startsWith('TransformControls') || (obj as any).isTransformControls) {
        if (obj.visible) { hiddenObjs.push(obj); obj.visible = false; }
      }
    });

    // Adjust camera aspect to match minimap dimensions
    const savedAspect = this.camera.aspect;
    this.camera.aspect = MINIMAP_W / MINIMAP_H;
    this.camera.updateProjectionMatrix();

    // The WebGL canvas is sized for the scene view, so its aspect generally differs
    // from the minimap's. Render into the largest centred sub-rect of the canvas that
    // matches the minimap aspect, then copy exactly that rect. This keeps the camera
    // frame 1:1 with what records — rendering full-canvas at a mismatched aspect would
    // widen the visible field, and cropping afterwards would zoom it in.
    const src = this.renderer.domElement;
    const targetAspect = MINIMAP_W / Math.max(MINIMAP_H, 1);

    // setViewport() works in CSS pixels (it multiplies by pixelRatio internally), while
    // src.width/height are backing-store pixels (already multiplied). Compute the rect in
    // CSS pixels, then scale to backing-store pixels for the drawImage copy. Mixing the
    // two unit spaces is what pushed the render off-centre.
    const rendererSize = this.renderer.getSize(new THREE.Vector2());
    const cssW = rendererSize.x;
    const cssH = rendererSize.y;

    let vw = cssW;
    let vh = vw / targetAspect;
    if (vh > cssH) {
      vh = cssH;
      vw = vh * targetAspect;
    }
    const vx = (cssW - vw) / 2;
    // WebGL viewport origin is bottom-left vs. the canvas's top-left, but the rect is
    // centred vertically so the same offset is correct in both conventions.
    const vy = (cssH - vh) / 2;

    const savedViewport = new THREE.Vector4();
    this.renderer.getViewport(savedViewport);
    this.renderer.setViewport(vx, vy, vw, vh);

    // Render directly to main WebGL canvas (preserveDrawingBuffer: true)
    // This ensures tone mapping + sRGB encoding match the main view exactly.
    // The minimap IS the production camera, so it must show the logo plate — and at the
    // minimap's own aspect, not the editor canvas's, or the plate would be stretched
    // relative to what actually records.
    const savedBackdropAspect = this.viewportAspectForBackdrop;
    this.applyBackdropAspect(targetAspect);
    this.renderWithBackdrop(this.camera);
    this.applyBackdropAspect(savedBackdropAspect);

    this.renderer.setViewport(savedViewport);

    // GPU-accelerated blit of just the rendered sub-rect — no CPU readback, correct colours.
    // Convert the CSS-pixel rect to backing-store pixels to index into the source canvas.
    const pr = cssW > 0 ? src.width / cssW : 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      src,
      vx * pr, vy * pr, vw * pr, vh * pr,
      0, 0, canvas.width, canvas.height
    );

    // Restore camera aspect and helpers
    this.camera.aspect = savedAspect;
    this.camera.updateProjectionMatrix();
    if (this.isSceneView) this.setHelpersVisible(true);
    for (const obj of hiddenObjs) obj.visible = true;
  }

  /**
   * Capture current view as data URL with transparency
   */
  captureFrame(format: 'png' | 'jpeg' | 'webp' = 'png'): string {
    // This is the still shown in the studio's camera view, so it must include the
    // camera-locked logo plate — otherwise the one view meant to preview the shot is
    // the only place the plate is missing.
    this.renderWithBackdrop(this.camera);
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

  /**
   * Requests that an in-flight recording stop.
   *
   * Returns immediately: the loop notices the flag before its next frame and
   * rejects with RecordingCanceledError, so callers that already treat a
   * cancelled take as "no output" keep working unchanged.
   */
  stopRecording() {
    this._recordingCanceled = true;
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
    if (this.cameraPathLine) this.cameraPathLine.visible = this.isSceneView;
    if (this.cameraSpanLine) this.cameraSpanLine.visible = this.isSceneView;
    for (const g of this.cameraWaypointGizmos) g.visible = this.isSceneView;

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

  /** Reset the camera-key cache so the next updateStudioPreviewConfig always applies the camera. */
  invalidateCameraStartKey(): void {
    this._lastAppliedCameraStartKey = "";
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

  // ---------------------------------------------------------------------------
  // Camera path overlay — path line + draggable waypoint gizmos (scene view only)
  // ---------------------------------------------------------------------------

  /**
   * Invoked immediately before waypoint gizmo meshes are disposed, so the caller can
   * detach TransformControls. Without this, deleting a waypoint while its gizmo is
   * selected leaves the transform gizmo attached to a disposed, unparented mesh —
   * which throws "object must be part of the scene graph" on the next interaction.
   */
  private _onCameraWaypointGizmosInvalidated: (() => void) | null = null;

  setCameraWaypointGizmoInvalidatedHandler(handler: (() => void) | null): void {
    this._onCameraWaypointGizmosInvalidated = handler;
  }

  /** Remove and dispose every camera-path overlay object. */
  private clearCameraPathVisuals(): void {
    if (this.cameraWaypointGizmos.length > 0) {
      this._onCameraWaypointGizmosInvalidated?.();
    }
    for (const line of [this.cameraPathLine, this.cameraSpanLine]) {
      if (!line) continue;
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.cameraPathLine = null;
    this.cameraSpanLine = null;
    for (const g of this.cameraWaypointGizmos) {
      this.scene.remove(g);
      g.geometry.dispose();
      (g.material as THREE.Material).dispose();
    }
    this.cameraWaypointGizmos = [];
  }

  /** Create or update one overlay line, reusing its buffer when the vertex count matches. */
  private _syncOverlayLine(
    existing: THREE.Line | null,
    points: THREE.Vector3[],
    color: number,
    opacity: number,
    renderOrder: number
  ): THREE.Line | null {
    if (points.length === 0) {
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        (existing.material as THREE.Material).dispose();
      }
      return null;
    }
    const attr = existing?.geometry.getAttribute("position");
    if (existing && attr && attr.count === points.length) {
      for (let i = 0; i < points.length; i++) {
        attr.setXYZ(i, points[i].x, points[i].y, points[i].z);
      }
      attr.needsUpdate = true;
      existing.geometry.computeBoundingSphere();
      (existing.material as THREE.LineBasicMaterial).color.setHex(color);
      (existing.material as THREE.LineBasicMaterial).opacity = opacity;
      return existing;
    }
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
      (existing.material as THREE.Material).dispose();
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
    const line = new THREE.Line(geo, mat);
    // Overlays must never be depth-occluded by the cue or the backdrop, or the path
    // disappears behind the model exactly when the user needs to see it.
    line.renderOrder = renderOrder;
    line.visible = this.isSceneView;
    this.scene.add(line);
    return line;
  }

  /**
   * Rebuild the scene-view camera-path overlay from the current config.
   *
   * Draws two lines: the full shape curve, dimmed, plus the recorded start→end span in
   * bright orange on top — so the user can see at a glance which stretch of the shape ends
   * up in the video. Waypoint spheres are colour-coded: green for start, red for end,
   * amber for points inside the span, and dark grey for points outside it.
   *
   * Gizmos carry `userData.type = "cameraWaypoint"` plus their index, which is what lets the
   * existing TransformControls selection machinery pick them up with no special-casing.
   */
  updateCameraPathVisuals(config: VideoStudioConfig): void {
    const path = config.cameraPath;
    if (!path || !path.enabled || path.waypoints.length < 2) {
      this.clearCameraPathVisuals();
      return;
    }

    // Full shape, dimmed. In "select all" mode it turns green to signal that dragging
    // moves the entire curve rather than a single point.
    const selectAll = this._cameraPathSelectAll;
    this.cameraPathLine = this._syncOverlayLine(
      this.cameraPathLine,
      getCameraPathPoints(path, 200),
      selectAll ? 0x22cc66 : 0xff6600,
      selectAll ? 0.95 : 0.28,
      999
    );

    // Recorded span, bright. Hidden in select-all mode so the green full curve reads clean.
    this.cameraSpanLine = this._syncOverlayLine(
      this.cameraSpanLine,
      selectAll ? [] : getCameraSpanPoints(path, 160),
      0xff6600,
      1,
      1001
    );

    // Rebuild waypoint gizmos when the count changes; otherwise reposition + recolour.
    const waypoints = path.waypoints;
    if (this.cameraWaypointGizmos.length !== waypoints.length) {
      if (this.cameraWaypointGizmos.length > 0) {
        this._onCameraWaypointGizmosInvalidated?.();
      }
      for (const g of this.cameraWaypointGizmos) {
        this.scene.remove(g);
        g.geometry.dispose();
        (g.material as THREE.Material).dispose();
      }
      this.cameraWaypointGizmos = waypoints.map((_, index) => {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.28, 16, 12),
          new THREE.MeshBasicMaterial({ depthTest: false })
        );
        mesh.renderOrder = 1002;
        mesh.userData = { type: "cameraWaypoint", waypointIndex: index };
        mesh.visible = this.isSceneView;
        this.scene.add(mesh);
        return mesh;
      });
    }

    const spanIndices = this._cameraPathSpanIndices(path);
    for (let i = 0; i < waypoints.length; i++) {
      const gizmo = this.cameraWaypointGizmos[i];
      if (!gizmo) continue;
      gizmo.position.set(waypoints[i].x, waypoints[i].y, waypoints[i].z);
      // Scene view keeps matrixAutoUpdate on, but recording freezes the graph — set the
      // matrix explicitly so a drag is reflected even on the frame it happens.
      gizmo.updateMatrixWorld(true);
      const mat = gizmo.material as THREE.MeshBasicMaterial;
      if (selectAll) {
        mat.color.setHex(0x22cc66);
        mat.opacity = 1;
      } else if (i === path.startIndex) {
        mat.color.setHex(0x22cc66); // start — green
        mat.opacity = 1;
      } else if (i === path.endIndex) {
        mat.color.setHex(0xff3355); // end — red
        mat.opacity = 1;
      } else if (spanIndices.has(i)) {
        mat.color.setHex(0xffaa33); // inside the recorded span — amber
        mat.opacity = 1;
      } else {
        mat.color.setHex(0x666666); // outside the span — dimmed grey
        mat.opacity = 0.55;
      }
      mat.transparent = mat.opacity < 1;
      // Start and end read as the important handles, so draw them larger.
      const emphasis = i === path.startIndex || i === path.endIndex ? 1.45 : 1;
      gizmo.scale.setScalar(emphasis);
    }
  }

  /** Indices covered by the recorded span, including wrap-around on a closed loop. */
  private _cameraPathSpanIndices(path: CameraPathConfig): Set<number> {
    const n = path.waypoints.length;
    const out = new Set<number>();
    if (n === 0) return out;
    const a = Math.max(0, Math.min(n - 1, path.startIndex));
    const b = Math.max(0, Math.min(n - 1, path.endIndex));
    if (a === b) { out.add(a); return out; }
    if (a < b) {
      for (let i = a; i <= b; i++) out.add(i);
    } else if (path.closed) {
      for (let i = a; i < n; i++) out.add(i);
      for (let i = 0; i <= b; i++) out.add(i);
    } else {
      for (let i = b; i <= a; i++) out.add(i);
    }
    return out;
  }

  /**
   * Toggle "select all" mode. While on, the whole curve highlights green and the caller
   * drags every waypoint together instead of one at a time.
   */
  setCameraPathSelectAll(active: boolean): void {
    this._cameraPathSelectAll = active;
  }

  isCameraPathSelectAll(): boolean {
    return this._cameraPathSelectAll;
  }

  /** Live world position of a waypoint gizmo — read back after a TransformControls drag. */
  getCameraWaypointPosition(index: number): { x: number; y: number; z: number } | null {
    const gizmo = this.cameraWaypointGizmos[index];
    if (!gizmo) return null;
    return { x: gizmo.position.x, y: gizmo.position.y, z: gizmo.position.z };
  }

  /** Waypoint gizmos, so scene-view controls can register them as selectable. */
  getCameraWaypointGizmos(): THREE.Mesh[] {
    return this.cameraWaypointGizmos;
  }

  /**
   * Redraw the overlay lines from the gizmos' live positions — called during a drag, before
   * the React config has round-tripped, so the curve follows the pointer.
   */
  refreshCameraPathLineFromGizmos(config: VideoStudioConfig): void {
    const path = config.cameraPath;
    if (!path || this.cameraWaypointGizmos.length !== path.waypoints.length) return;
    const live: CameraPathConfig = {
      ...path,
      waypoints: this.cameraWaypointGizmos.map((g, i) => ({
        ...path.waypoints[i],
        x: g.position.x,
        y: g.position.y,
        z: g.position.z,
      })),
    };
    const selectAll = this._cameraPathSelectAll;
    this.cameraPathLine = this._syncOverlayLine(
      this.cameraPathLine,
      getCameraPathPoints(live, 200),
      selectAll ? 0x22cc66 : 0xff6600,
      selectAll ? 0.95 : 0.28,
      999
    );
    this.cameraSpanLine = this._syncOverlayLine(
      this.cameraSpanLine,
      selectAll ? [] : getCameraSpanPoints(live, 160),
      0xff6600,
      1,
      1001
    );
  }

  /**
   * Snap every waypoint gizmo onto the given positions.
   *
   * Used by the whole-curve rotate, where all points move at once and there is no single
   * dragged handle to derive a delta from.
   */
  applyCameraWaypointPositions(waypoints: readonly { x: number; y: number; z: number }[]): void {
    for (let i = 0; i < this.cameraWaypointGizmos.length; i++) {
      const wp = waypoints[i];
      const g = this.cameraWaypointGizmos[i];
      if (!wp || !g) continue;
      g.position.set(wp.x, wp.y, wp.z);
      g.updateMatrixWorld(true);
    }
  }

  /**
   * "Select all" drag: the user drags one handle, and every other gizmo follows by the same
   * delta so the curve's shape is preserved and only its placement changes.
   *
   * `draggedIndex` is the handle under the pointer; its position is authoritative, and the
   * siblings are re-derived from the config snapshot each frame rather than accumulated, so
   * repeated calls during one drag can't drift.
   */
  syncCameraWaypointGroupDrag(config: VideoStudioConfig, draggedIndex: number): void {
    const path = config.cameraPath;
    const dragged = this.cameraWaypointGizmos[draggedIndex];
    const anchor = path?.waypoints[draggedIndex];
    if (!path || !dragged || !anchor) return;
    const dx = dragged.position.x - anchor.x;
    const dy = dragged.position.y - anchor.y;
    const dz = dragged.position.z - anchor.z;
    for (let i = 0; i < this.cameraWaypointGizmos.length; i++) {
      if (i === draggedIndex) continue;
      const wp = path.waypoints[i];
      const g = this.cameraWaypointGizmos[i];
      if (!wp || !g) continue;
      g.position.set(wp.x + dx, wp.y + dy, wp.z + dz);
      g.updateMatrixWorld(true);
    }
  }

  /**
   * The keyframe the camera must sit at for frame 0.
   *
   * With a curve path this is derived from the path itself (its span's first point), not
   * from `config.cameraStart` — so a template whose stored cameraStart drifted out of sync
   * still opens on the correct frame. Falls back to cameraStart when there is no path.
   */
  private resolveStartKeyframe(config: VideoStudioConfig): CameraKeyframe {
    const sampler = createCameraPathSampler(
      config.cameraStart,
      config.cameraEnd,
      config.cameraPath,
      this.getCuePathLookTarget()
    );
    const kf: CameraKeyframe = { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0 };
    sampler.sample(0, kf);
    return kf;
  }

  /**
   * World point the camera aims at when a custom path uses lookMode "target".
   *
   * Uses the main cue instance (the one flagged isMain, else the first), which is what the
   * user is framing. Returns undefined when no cue config is loaded yet, in which case the
   * sampler falls back to the world origin.
   */
  private getCuePathLookTarget(): THREE.Vector3 | undefined {
    const instances = this.currentCueConfig?.instances;
    if (!instances || instances.length === 0) return undefined;
    const main = instances.find(i => i.isMain) ?? instances[0];
    return new THREE.Vector3(main.positionX, main.positionY, main.positionZ);
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
    objects.push(...this.cameraWaypointGizmos);
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
            applyLogoToExistingMaterial(physMat, "topCapFace", (physMat.userData.__logoId as import("@/types/product").CueLogoId | undefined) ?? "uni");
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
          applyLogoToExistingMaterial(physMat, "topCapFace", (physMat.userData.__logoId as import("@/types/product").CueLogoId | undefined) ?? "uni");
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
  reapplyCurrentCueEnvMap(): void {
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
    // Full teardown of the V2 environment, including its HDRI / room caches.
    // clearStudioElements() only removes its scene objects so rebuilds stay fast.
    this.disposeRoomEnvironment();
    this.logoBackdrop?.dispose();
    this.logoBackdrop = null;
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
    this.clearCameraPathVisuals();
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
