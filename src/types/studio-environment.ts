/**
 * Video Studio V2 — real 3D environment configuration.
 *
 * V1 builds a fake set: a flat wall PlaneGeometry + a flat table PlaneGeometry with
 * a composited background image, which is why the cue reads as "pasted onto" a photo.
 *
 * V2 replaces those two planes with a real surrounding environment:
 *   - mode "hdri": an equirectangular .hdr/.exr used as scene.background AND
 *     scene.environment, optionally ground-projected (GroundedSkybox) so the floor
 *     has real parallax instead of looking like a painted dome.
 *   - mode "glb": a genuine 3D room model (Poly Haven / Sketchfab / etc.) added to
 *     the scene, lit by an HDRI environment. Gives correct occlusion + free camera.
 *
 * Everything else in the studio (cue model, cue HDRI, camera path, recording,
 * shadows) is untouched and shared with V1.
 */

/** How the surrounding environment is produced. */
export type StudioEnvironmentMode = "hdri" | "glb";

/** A selectable environment asset (HDRI panorama or GLB room). */
export interface StudioEnvironmentAsset {
  /** Stable id, also used as the persisted value. */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  /** Which loader to use. */
  mode: StudioEnvironmentMode;
  /**
   * Asset URL. For built-ins this is a path under /public
   * (e.g. "/hdri/billiard_hall_4k.hdr" or "/rooms/pool-hall.glb").
   * For user-supplied assets this is a blob: or remote URL.
   */
  url: string;
  /** Optional preview thumbnail URL for the picker. */
  thumbnailUrl?: string;
  /** True for assets the user added at runtime (not shipped in /public). */
  userProvided?: boolean;
}

/** Placement/orientation of a GLB room relative to the cue. */
export interface RoomTransform {
  /** Uniform scale applied to the loaded room model. */
  scale: number;
  /** World position offset of the room. */
  positionX: number;
  positionY: number;
  positionZ: number;
  /** Y rotation in degrees — spins the room around the cue. */
  rotationY: number;
}

export const DEFAULT_ROOM_TRANSFORM: RoomTransform = {
  scale: 1,
  positionX: 0,
  positionY: 0,
  positionZ: 0,
  rotationY: 0,
};

/**
 * Ground projection settings for HDRI mode.
 *
 * A raw equirectangular background is an infinitely distant dome: the floor in the
 * photo does not move correctly as the camera translates, so a cue standing on it
 * still looks detached. GroundedSkybox projects the lower hemisphere onto a finite
 * ground plane at `height` with radius `radius`, which restores floor parallax.
 */
export interface GroundProjectionConfig {
  enabled: boolean;
  /** Camera-space height of the virtual horizon; typically the eye height of the shot. */
  height: number;
  /** Radius of the projected ground disc. */
  radius: number;
}

export const DEFAULT_GROUND_PROJECTION: GroundProjectionConfig = {
  enabled: true,
  /**
   * `height` is how high the panorama's original camera stood above the floor, expressed
   * in this scene's units. The studio cue sits at y = 5.5 with scale 7, so it spans roughly
   * y = 0..11 — i.e. one "eye height" is about 8 units here, not the 1.6 of a human-scale
   * scene. Setting this too high puts the projected horizon far above the camera, which
   * makes the walls bow inward because you end up looking up into the dome's curve.
   */
  height: 8,
  /**
   * Radius of the projected ground. This is the single biggest lever on how "straight" the
   * room looks: the dome's curvature across the frame scales with sceneSize / radius, so a
   * radius vastly larger than the subject leaves the camera orbiting a tiny central patch
   * of a huge sphere and every straight wall reads as curved. ~5x the subject height keeps
   * the walls visually flat while still placing them convincingly far away.
   */
  radius: 60,
};

/**
 * An invisible proxy surface the cue can rest on and cast a shadow onto.
 *
 * In HDRI mode the photographed table/floor has no geometry, so a contact shadow
 * needs a shadow-only receiver. This plane is invisible except for the shadow it
 * catches (THREE.ShadowMaterial), which is what sells the cue as being *in* the room.
 */
export interface ShadowCatcherConfig {
  enabled: boolean;
  /** World Y of the catcher plane — align to the photographed floor or tabletop. */
  height: number;
  /** Plane size (square, in world units). */
  size: number;
  /** Shadow darkness 0–1. */
  opacity: number;
}

export const DEFAULT_SHADOW_CATCHER: ShadowCatcherConfig = {
  enabled: true,
  // y = 0 is where ground projection puts the floor and where the cue's own origin sits,
  // so the contact shadow lands under the cue by default. (V1's -2 was the fake tabletop.)
  height: 0,
  size: 40,
  opacity: 0.35,
};

/** Full V2 environment config. Persisted inside VideoStudioConfig as `environment`. */
export interface StudioEnvironmentConfig {
  /** Which environment source is active. */
  mode: StudioEnvironmentMode;
  /** Selected asset id from the catalog (or a user-added asset). */
  assetId: string;
  /**
   * Resolved URL for the selected asset. Stored so user-provided assets keep
   * working without a catalog lookup.
   */
  assetUrl: string;
  /** Show the panorama as the visible backdrop (vs. lighting-only). */
  showBackground: boolean;
  /** Y rotation of the environment in degrees — aims the room behind the cue. */
  rotationY: number;
  /** Environment lighting multiplier applied to scene.environmentIntensity. */
  intensity: number;
  /** Background brightness multiplier (independent of lighting intensity). */
  backgroundIntensity: number;
  /** Ground projection (HDRI mode only). */
  groundProjection: GroundProjectionConfig;
  /** Invisible shadow-receiving proxy surface. */
  shadowCatcher: ShadowCatcherConfig;
  /** Placement of the GLB room (glb mode only). */
  roomTransform: RoomTransform;
  /**
   * When true the cue also takes its reflections from this environment.
   * When false the cue keeps its own dedicated cue-HDRI (V1 behaviour), which is
   * usually preferable because the cue HDRI is tuned for product highlights.
   */
  lightCueFromEnvironment: boolean;
}

export const DEFAULT_STUDIO_ENVIRONMENT: StudioEnvironmentConfig = {
  mode: "hdri",
  assetId: "church_museum_2k.hdr",
  assetUrl: "/hdri/church_museum_2k.hdr",
  showBackground: true,
  rotationY: 0,
  intensity: 1,
  backgroundIntensity: 1,
  groundProjection: { ...DEFAULT_GROUND_PROJECTION },
  shadowCatcher: { ...DEFAULT_SHADOW_CATCHER },
  roomTransform: { ...DEFAULT_ROOM_TRANSFORM },
  lightCueFromEnvironment: false,
};

/**
 * Built-in environment catalog.
 *
 * The four .hdr files already ship in /public/hdri for the existing cue lighting,
 * so they are reused here as ready-to-use 360° environments. Drop additional
 * panoramas into /public/hdri (Poly Haven "Billiard Hall" is the obvious one for
 * cues) or room models into /public/rooms and add an entry below.
 */
export const BUILTIN_ENVIRONMENTS: StudioEnvironmentAsset[] = [
  {
    id: "church_museum_2k.hdr",
    label: "Church Museum",
    mode: "hdri",
    url: "/hdri/church_museum_2k.hdr",
  },
  {
    id: "church_stairway_2k.hdr",
    label: "Church Stairway",
    mode: "hdri",
    url: "/hdri/church_stairway_2k.hdr",
  },
  {
    id: "ferndale_studio_07_2k.hdr",
    label: "Ferndale Studio",
    mode: "hdri",
    url: "/hdri/ferndale_studio_07_2k.hdr",
  },
  {
    id: "bloem_train_track_clear_2k.hdr",
    label: "Bloem Train Track",
    mode: "hdri",
    url: "/hdri/bloem_train_track_clear_2k.hdr",
  },
];

/** Look up a built-in asset by id. */
export function findEnvironmentAsset(id: string): StudioEnvironmentAsset | undefined {
  return BUILTIN_ENVIRONMENTS.find((a) => a.id === id);
}

/** File extensions accepted by the environment uploader, per mode. */
export const ENVIRONMENT_ACCEPT: Record<StudioEnvironmentMode, string> = {
  hdri: ".hdr,.exr",
  glb: ".glb,.gltf",
};

/** Infer the loader mode from a filename or URL. */
export function inferEnvironmentMode(nameOrUrl: string): StudioEnvironmentMode {
  const lower = nameOrUrl.toLowerCase().split("?")[0];
  if (lower.endsWith(".glb") || lower.endsWith(".gltf")) return "glb";
  return "hdri";
}

/** Normalise a possibly-partial persisted environment config (older templates). */
export function normalizeEnvironmentConfig(
  raw: Partial<StudioEnvironmentConfig> | undefined | null
): StudioEnvironmentConfig {
  if (!raw) return { ...DEFAULT_STUDIO_ENVIRONMENT };
  return {
    mode: raw.mode ?? DEFAULT_STUDIO_ENVIRONMENT.mode,
    assetId: raw.assetId ?? DEFAULT_STUDIO_ENVIRONMENT.assetId,
    assetUrl: raw.assetUrl ?? DEFAULT_STUDIO_ENVIRONMENT.assetUrl,
    showBackground: raw.showBackground ?? DEFAULT_STUDIO_ENVIRONMENT.showBackground,
    rotationY: raw.rotationY ?? DEFAULT_STUDIO_ENVIRONMENT.rotationY,
    intensity: raw.intensity ?? DEFAULT_STUDIO_ENVIRONMENT.intensity,
    backgroundIntensity:
      raw.backgroundIntensity ?? DEFAULT_STUDIO_ENVIRONMENT.backgroundIntensity,
    groundProjection: {
      ...DEFAULT_GROUND_PROJECTION,
      ...(raw.groundProjection ?? {}),
    },
    shadowCatcher: {
      ...DEFAULT_SHADOW_CATCHER,
      ...(raw.shadowCatcher ?? {}),
    },
    roomTransform: {
      ...DEFAULT_ROOM_TRANSFORM,
      ...(raw.roomTransform ?? {}),
    },
    lightCueFromEnvironment:
      raw.lightCueFromEnvironment ?? DEFAULT_STUDIO_ENVIRONMENT.lightCueFromEnvironment,
  };
}
