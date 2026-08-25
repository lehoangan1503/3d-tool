/**
 * Video Studio V2 — real 3D environment builder.
 *
 * V1 fakes the set with two textured planes (wall + table). This module builds the
 * V2 alternative: a genuine 360° surround, either an equirectangular HDRI (optionally
 * ground-projected so the floor has real parallax) or an actual GLB room model.
 *
 * Everything here is self-contained and additive — it owns only the objects it
 * creates and removes exactly those on dispose, so it can be dropped into the
 * existing studio scene without disturbing the cue, lights, camera or recorder.
 */

import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { GroundedSkybox } from "three/examples/jsm/objects/GroundedSkybox.js";
import type { StudioEnvironmentConfig } from "@/types/studio-environment";

/**
 * Environment used to light a GLB room. Room models ship without lighting, so a neutral
 * studio probe stands in; the room's own geometry provides the visible backdrop.
 */
const GLB_ROOM_LIGHTING_HDRI = "/hdri/ferndale_studio_07_2k.hdr";

/** Objects the builder owns, so teardown is exact. */
interface RoomEnvironmentHandles {
  /** GroundedSkybox mesh (HDRI mode with ground projection). */
  skybox: GroundedSkybox | null;
  /** Loaded GLB room root (glb mode). */
  room: THREE.Group | null;
  /** Invisible shadow-receiving plane. */
  shadowCatcher: THREE.Mesh | null;
  /** PMREM render target for the environment. */
  envRT: THREE.WebGLRenderTarget | null;
  /** Raw equirect texture kept for background use. */
  backgroundTexture: THREE.Texture | null;
  /** UV-mapped copy of the panorama used by the skybox mesh (see buildHdriEnvironment). */
  skyboxTexture: THREE.Texture | null;
}

/** Result of a build, reported back so the caller can log / show errors. */
export interface RoomEnvironmentBuildResult {
  ok: boolean;
  error?: string;
  /** Bounding-box size of the loaded room, useful for auto-fitting the camera. */
  roomSize?: THREE.Vector3;
}

/**
 * Owns the V2 environment for one studio scene.
 *
 * Lifecycle: `build(config)` is idempotent — it tears down whatever it previously
 * created before constructing the new environment, so it is safe to call on every
 * config change. `dispose()` returns the scene to exactly its pre-build state.
 */
export class StudioRoomEnvironment {
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private pmrem: THREE.PMREMGenerator;
  /** PMREM is created here and owned here unless injected. */
  private ownsPmrem: boolean;

  private handles: RoomEnvironmentHandles = {
    skybox: null,
    room: null,
    shadowCatcher: null,
    envRT: null,
    backgroundTexture: null,
    skyboxTexture: null,
  };

  /** Cache of decoded equirect textures keyed by URL — HDRIs are expensive to decode. */
  private textureCache = new Map<string, THREE.DataTexture>();
  /** Cache of parsed GLB rooms keyed by URL. */
  private roomCache = new Map<string, THREE.Group>();

  /** Scene state captured on first build so dispose() can restore it. */
  private savedBackground: THREE.Color | THREE.Texture | null = null;
  private savedEnvironment: THREE.Texture | null = null;
  private savedStateCaptured = false;

  private ktx2Loader: KTX2Loader | null = null;
  private disposed = false;

  /** Auto-fit derived for the currently loaded room; reused by live scale updates. */
  private roomAutoFit: { scale: number; center: THREE.Vector3; floorY: number } | null = null;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    pmrem?: THREE.PMREMGenerator
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.pmrem = pmrem ?? new THREE.PMREMGenerator(renderer);
    this.ownsPmrem = !pmrem;
    this.pmrem.compileEquirectangularShader();
  }

  /**
   * Build (or rebuild) the environment described by `config`.
   *
   * Never throws: a failed asset load leaves the scene in a clean, usable state and
   * reports the reason, so a bad user-supplied file cannot break the studio.
   */
  async build(config: StudioEnvironmentConfig): Promise<RoomEnvironmentBuildResult> {
    if (this.disposed) return { ok: false, error: "environment disposed" };

    this.captureSceneState();
    this.teardownObjects();

    try {
      if (config.mode === "glb") {
        const result = await this.buildGlbRoom(config);
        this.buildShadowCatcher(config);
        return result;
      }
      const result = await this.buildHdriEnvironment(config);
      this.buildShadowCatcher(config);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[StudioRoomEnvironment] build failed:", err);
      // Leave a neutral scene rather than a half-built one.
      this.teardownObjects();
      return { ok: false, error };
    }
  }

  // ───────────────────────────── HDRI mode ─────────────────────────────

  /**
   * HDRI mode: the panorama lights the scene via PMREM and (optionally) shows as the
   * visible backdrop.
   *
   * With `groundProjection.enabled` the lower hemisphere is projected onto a finite
   * ground disc via GroundedSkybox instead of being drawn as an infinitely distant
   * dome. That is what gives the floor real parallax as the camera translates — the
   * single biggest reason a cue on a plain equirect background still looks pasted on.
   */
  private async buildHdriEnvironment(
    config: StudioEnvironmentConfig
  ): Promise<RoomEnvironmentBuildResult> {
    const texture = await this.loadEquirect(config.assetUrl);
    texture.mapping = THREE.EquirectangularReflectionMapping;

    // PMREM gives correct roughness-aware reflections on the cue's metal/clear-coat.
    const rt = this.pmrem.fromEquirectangular(texture);
    this.handles.envRT = rt;
    this.handles.backgroundTexture = texture;

    this.scene.environment = rt.texture;
    // environmentIntensity scales IBL without touching per-material envMapIntensity.
    this.scene.environmentIntensity = config.intensity;
    // Rotating the environment aims the room's light and reflections behind the cue.
    this.scene.environmentRotation = new THREE.Euler(
      0,
      THREE.MathUtils.degToRad(config.rotationY),
      0
    );

    if (!config.showBackground) {
      this.scene.background = null;
      return { ok: true };
    }

    if (config.groundProjection.enabled) {
      // GroundedSkybox throws on a non-positive height or radius, so clamp rather than
      // letting a slider at its minimum take down the whole studio.
      const height = Math.max(0.1, config.groundProjection.height);
      const radius = Math.max(1, config.groundProjection.radius);

      // The skybox is a MESH, so it samples the panorama through ordinary UV mapping —
      // not the EquirectangularReflectionMapping that scene.environment requires. It also
      // needs flipY: RGBELoader returns a DataTexture, which defaults flipY to false, and
      // HDR scanlines are stored top-row-first. Left as-is the room renders upside down
      // (ceiling on the floor). Hence a separate texture instance for the mesh, since one
      // texture cannot carry both mappings at once.
      const skyTexture = this.cloneDataTexture(texture);
      skyTexture.mapping = THREE.UVMapping;
      skyTexture.flipY = true;
      // colorSpace is deliberately left as the loader set it — HDR data is already linear,
      // so forcing a value here would double-convert and shift the room's colour.
      skyTexture.needsUpdate = true;
      this.handles.skyboxTexture = skyTexture;

      const skybox = new GroundedSkybox(skyTexture, height, radius);
      // The mesh is built centred on the camera; lifting it by `height` puts the
      // projected ground at y = 0, which is where the cue's own origin sits.
      skybox.position.y = height;
      // GroundedSkybox uses a MeshBasicMaterial holding the raw radiance texture, so it
      // must go through the renderer's ACES tone mapping like every other lit surface —
      // otherwise the backdrop blows out to white while the cue stays correctly exposed.
      const skyMat = skybox.material as THREE.MeshBasicMaterial;
      skyMat.toneMapped = true;
      // backgroundIntensity does not apply to a mesh, so exposure is folded into its tint.
      skyMat.color.setScalar(config.backgroundIntensity);
      skyMat.needsUpdate = true;
      skybox.rotation.y = THREE.MathUtils.degToRad(config.rotationY);
      // The skybox is scenery, not a shadow caster/receiver.
      skybox.castShadow = false;
      skybox.receiveShadow = false;
      skybox.name = "studio-v2-skybox";
      this.handles.skybox = skybox;
      this.scene.add(skybox);
      this.scene.background = null;
    } else {
      this.scene.background = texture;
      this.scene.backgroundRotation = new THREE.Euler(
        0,
        THREE.MathUtils.degToRad(config.rotationY),
        0
      );
      this.scene.backgroundIntensity = config.backgroundIntensity;
    }

    return { ok: true };
  }

  // ───────────────────────────── GLB mode ─────────────────────────────

  /**
   * GLB mode: a real room model, so the cue can be occluded by furniture and the
   * camera can move freely with correct perspective.
   *
   * The room still needs an HDRI for lighting — a GLB carries no light probe — so the
   * currently configured panorama (or a neutral fallback) supplies scene.environment.
   */
  private async buildGlbRoom(
    config: StudioEnvironmentConfig
  ): Promise<RoomEnvironmentBuildResult> {
    const gltfScene = await this.loadRoom(config.assetUrl);
    const room = gltfScene.clone(true);

    const t = config.roomTransform;
    // Room models are authored at real-world scale (a room is ~4x3 metres, so ~4 units),
    // but the studio cue spans ~11 units. Loaded raw the cue towers through the ceiling and
    // the user has to find the right scale by dragging a slider blind. So `scale` is applied
    // as a multiplier on top of an automatic fit that first brings the room into the cue's
    // world — scale 1 means "sized to the cue", not "raw model units".
    const autoFit = this.computeRoomAutoFit(room);
    this.roomAutoFit = autoFit;
    room.scale.setScalar(t.scale * autoFit.scale);
    // Drop the room so its floor sits at y = 0, where the cue's base and the shadow
    // catcher live, then apply the user's offset on top.
    room.position.set(
      t.positionX - autoFit.center.x * t.scale * autoFit.scale,
      t.positionY - autoFit.floorY * t.scale * autoFit.scale,
      t.positionZ - autoFit.center.z * t.scale * autoFit.scale
    );
    room.rotation.y = THREE.MathUtils.degToRad(t.rotationY + config.rotationY);
    room.name = "studio-v2-room";

    // Room surfaces receive the cue's shadow; they should not cast onto themselves
    // (self-shadowing a photogrammetry room is noisy and costs shadow-map budget).
    room.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.receiveShadow = true;
        child.castShadow = false;
      }
    });

    this.handles.room = room;
    this.scene.add(room);

    // A GLB carries no light probe, so the room is lit by a neutral studio HDRI. (In glb
    // mode `assetUrl` is the model itself, so it can never double as the environment.)
    try {
      const texture = await this.loadEquirect(GLB_ROOM_LIGHTING_HDRI);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const rt = this.pmrem.fromEquirectangular(texture);
      this.handles.envRT = rt;
      this.handles.backgroundTexture = texture;
      this.scene.environment = rt.texture;
      this.scene.environmentIntensity = config.intensity;
    } catch (err) {
      console.warn("[StudioRoomEnvironment] room lighting HDRI failed:", err);
    }

    // Inside a real room the geometry *is* the backdrop, so no panorama is drawn. Any gap
    // the room model leaves (a missing ceiling, an open doorway) shows the neutral clear
    // colour rather than a stretched photo that would not line up with the geometry.
    this.scene.background = null;

    const box = new THREE.Box3().setFromObject(room);
    const roomSize = box.getSize(new THREE.Vector3());
    return { ok: true, roomSize };
  }

  /**
   * Work out the transform that brings an arbitrary room model into the studio's scale.
   *
   * The studio's subject (the cue) spans roughly 11 world units tall. Room models come in
   * whatever units their author used — metres, centimetres, inches — so a fixed scale
   * cannot work. This measures the model and derives the factor that makes the room's
   * height a sensible multiple of the cue's, so `scale: 1` always lands in a usable place.
   */
  private computeRoomAutoFit(room: THREE.Group): {
    scale: number;
    center: THREE.Vector3;
    floorY: number;
  } {
    room.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(room);
    if (box.isEmpty()) {
      return { scale: 1, center: new THREE.Vector3(), floorY: 0 };
    }

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // Target: the room's interior height should comfortably clear the cue (~11 units),
    // so aim for roughly 18 units floor-to-ceiling.
    const TARGET_ROOM_HEIGHT = 18;
    // Use the smallest horizontal span as a sanity check — a "room" whose height is a
    // sliver of its footprint is probably a floor slab, so fall back to footprint scaling.
    const horizontal = Math.max(size.x, size.z);
    const reference = size.y > horizontal * 0.15 ? size.y : horizontal * 0.5;
    const scale = reference > 1e-6 ? TARGET_ROOM_HEIGHT / reference : 1;

    return { scale, center, floorY: box.min.y };
  }

  // ─────────────────────────── shadow catcher ───────────────────────────

  /**
   * An invisible plane that renders nothing but the shadows falling on it.
   *
   * In HDRI mode the photographed floor has no geometry, so without this the cue
   * floats — a contact shadow is the cue that anchors an object to a surface.
   */
  private buildShadowCatcher(config: StudioEnvironmentConfig): void {
    const cfg = config.shadowCatcher;
    if (!cfg.enabled) return;

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(cfg.size, cfg.size),
      new THREE.ShadowMaterial({
        color: 0x000000,
        opacity: cfg.opacity,
        // Keep the catcher out of the depth buffer so it never occludes the backdrop.
        depthWrite: false,
        transparent: true,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = cfg.height;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = "studio-v2-shadow-catcher";
    // Mark it so the studio's existing surface-picking logic can identify it.
    mesh.userData = { type: "shadowCatcher" };

    this.handles.shadowCatcher = mesh;
    this.scene.add(mesh);
  }

  // ────────────────────────── live cheap updates ──────────────────────────

  /**
   * Apply the config values that do not require reloading the asset.
   *
   * Called on slider drags so rotation/intensity/shadow feel instant instead of
   * triggering a full rebuild (which would re-decode a multi-megabyte HDRI).
   */
  applyLightUpdates(config: StudioEnvironmentConfig): void {
    if (this.disposed) return;

    const yaw = THREE.MathUtils.degToRad(config.rotationY);

    this.scene.environmentIntensity = config.intensity;
    this.scene.environmentRotation = new THREE.Euler(0, yaw, 0);

    if (this.scene.background && this.scene.background !== null) {
      this.scene.backgroundIntensity = config.backgroundIntensity;
      this.scene.backgroundRotation = new THREE.Euler(0, yaw, 0);
    }

    if (this.handles.skybox) {
      this.handles.skybox.rotation.y = yaw;
      this.handles.skybox.position.y = Math.max(0.1, config.groundProjection.height);
      // The skybox is a mesh, so its brightness is its material tint (see build()).
      const skyMat = this.handles.skybox.material as THREE.MeshBasicMaterial;
      skyMat.color.setScalar(config.backgroundIntensity);
    }

    if (this.handles.room && this.roomAutoFit) {
      // Must reuse the SAME auto-fit as the build, otherwise dragging the scale slider
      // would snap the room back to its raw authoring units.
      const t = config.roomTransform;
      const fit = this.roomAutoFit;
      const s = t.scale * fit.scale;
      this.handles.room.scale.setScalar(s);
      this.handles.room.position.set(
        t.positionX - fit.center.x * s,
        t.positionY - fit.floorY * s,
        t.positionZ - fit.center.z * s
      );
      this.handles.room.rotation.y = THREE.MathUtils.degToRad(t.rotationY + config.rotationY);
    }

    const catcher = this.handles.shadowCatcher;
    if (catcher) {
      catcher.visible = config.shadowCatcher.enabled;
      catcher.position.y = config.shadowCatcher.height;
      const mat = catcher.material as THREE.ShadowMaterial;
      mat.opacity = config.shadowCatcher.opacity;
    }
  }

  /** Hide environment scenery for transparent PNG capture. */
  setVisible(visible: boolean): void {
    if (this.handles.skybox) this.handles.skybox.visible = visible;
    if (this.handles.room) this.handles.room.visible = visible;
    if (this.handles.shadowCatcher) this.handles.shadowCatcher.visible = visible;
  }

  /** The shadow-catcher mesh, so the host can register it for gizmo picking. */
  getShadowCatcher(): THREE.Mesh | null {
    return this.handles.shadowCatcher;
  }

  /** The loaded room root, for camera auto-fit or raycast placement. */
  getRoom(): THREE.Group | null {
    return this.handles.room;
  }

  /**
   * Far-plane distance needed to enclose this environment.
   *
   * The caller grows its cameras to at least this, otherwise the environment's far side is
   * clipped and shows as a black void.
   */
  getFarPlaneRequirement(config: StudioEnvironmentConfig): number {
    if (config.mode === "glb") {
      const room = this.handles.room;
      if (!room) return 200;
      // Measured AFTER the auto-fit transform is applied, so this is the room's real
      // extent in studio units. Distance is from the origin, where the camera orbits.
      room.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(room);
      return Math.max(box.max.length(), box.min.length(), 50);
    }
    // A GroundedSkybox's outermost vertices sit at exactly `radius` from its centre.
    return config.groundProjection.enabled
      ? Math.max(config.groundProjection.radius, 50)
      : 200;
  }

  /** True when an environment is currently built. */
  isActive(): boolean {
    return !!(this.handles.skybox || this.handles.room || this.handles.envRT);
  }

  // ───────────────────────────── loaders ─────────────────────────────

  /** Load an .hdr/.exr equirect texture, caching decoded results per URL. */
  private async loadEquirect(url: string): Promise<THREE.DataTexture> {
    const cached = this.textureCache.get(url);
    if (cached) return this.cloneDataTexture(cached);

    const isExr = url.toLowerCase().split("?")[0].endsWith(".exr");
    const loader = isExr ? new EXRLoader() : new RGBELoader();
    const texture = (await loader.loadAsync(url)) as THREE.DataTexture;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    this.textureCache.set(url, texture);
    return this.cloneDataTexture(texture);
  }

  /**
   * Load a GLB/GLTF room, caching the parsed scene per URL.
   *
   * KTX2 support is wired up because compressed textures are common in the room
   * models on Poly Haven / Sketchfab, and a missing transcoder shows up as an
   * unhelpful parse error.
   */
  private async loadRoom(url: string): Promise<THREE.Group> {
    const cached = this.roomCache.get(url);
    if (cached) return cached;

    const loader = new GLTFLoader();
    if (!this.ktx2Loader) {
      this.ktx2Loader = new KTX2Loader()
        .setTranscoderPath("/basis/")
        .detectSupport(this.renderer);
    }
    loader.setKTX2Loader(this.ktx2Loader);

    const gltf = await loader.loadAsync(url);
    this.roomCache.set(url, gltf.scene);
    return gltf.scene;
  }

  /** Deep-copy a DataTexture so cached pixel data is never mutated downstream. */
  private cloneDataTexture(source: THREE.DataTexture): THREE.DataTexture {
    const data = source.image.data as Float32Array | Uint16Array | Uint8Array;
    let copy: Float32Array | Uint16Array | Uint8Array;
    if (data instanceof Float32Array) copy = new Float32Array(data);
    else if (data instanceof Uint16Array) copy = new Uint16Array(data);
    else copy = new Uint8Array(data);

    // RGBELoader/EXRLoader always produce an uncompressed float/half-float format, so the
    // source format is narrowed here — DataTexture's signature excludes compressed formats.
    const clone = new THREE.DataTexture(
      copy,
      source.image.width,
      source.image.height,
      source.format as THREE.PixelFormat,
      source.type
    );
    clone.mapping = source.mapping;
    clone.minFilter = source.minFilter;
    clone.magFilter = source.magFilter;
    clone.wrapS = source.wrapS;
    clone.wrapT = source.wrapT;
    clone.colorSpace = source.colorSpace;
    clone.needsUpdate = true;
    return clone;
  }

  // ───────────────────────────── teardown ─────────────────────────────

  /** Remember the scene's original background/environment for a faithful restore. */
  private captureSceneState(): void {
    if (this.savedStateCaptured) return;
    const bg = this.scene.background;
    this.savedBackground = bg instanceof THREE.Color || bg instanceof THREE.Texture ? bg : null;
    this.savedEnvironment = this.scene.environment;
    this.savedStateCaptured = true;
  }

  /** Remove and free everything this builder added to the scene. */
  private teardownObjects(): void {
    if (this.handles.skybox) {
      this.scene.remove(this.handles.skybox);
      this.handles.skybox.geometry.dispose();
      const mat = this.handles.skybox.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
      this.handles.skybox = null;
    }

    if (this.handles.room) {
      this.scene.remove(this.handles.room);
      // The cached original is kept for reuse; only this clone's geometry is freed.
      this.handles.room.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
      this.handles.room = null;
      this.roomAutoFit = null;
    }

    if (this.handles.shadowCatcher) {
      this.scene.remove(this.handles.shadowCatcher);
      this.handles.shadowCatcher.geometry.dispose();
      (this.handles.shadowCatcher.material as THREE.Material).dispose();
      this.handles.shadowCatcher = null;
    }

    if (this.handles.envRT) {
      this.handles.envRT.dispose();
      this.handles.envRT = null;
    }

    if (this.handles.backgroundTexture) {
      this.handles.backgroundTexture.dispose();
      this.handles.backgroundTexture = null;
    }

    if (this.handles.skyboxTexture) {
      this.handles.skyboxTexture.dispose();
      this.handles.skyboxTexture = null;
    }
  }

  /** Tear down and restore the scene to its pre-build background/environment. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.teardownObjects();

    if (this.savedStateCaptured) {
      this.scene.background = this.savedBackground;
      this.scene.environment = this.savedEnvironment;
      this.scene.environmentIntensity = 1;
      this.scene.backgroundIntensity = 1;
      this.scene.environmentRotation = new THREE.Euler(0, 0, 0);
      this.scene.backgroundRotation = new THREE.Euler(0, 0, 0);
    }

    for (const tex of this.textureCache.values()) tex.dispose();
    this.textureCache.clear();

    for (const room of this.roomCache.values()) {
      room.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) m.dispose();
        }
      });
    }
    this.roomCache.clear();

    if (this.ktx2Loader) {
      this.ktx2Loader.dispose();
      this.ktx2Loader = null;
    }

    if (this.ownsPmrem) this.pmrem.dispose();
  }
}
