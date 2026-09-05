import type { HdriLayer } from "./extractor";
import type { StudioEnvironmentConfig } from "./studio-environment";
import { DEFAULT_STUDIO_ENVIRONMENT, normalizeEnvironmentConfig } from "./studio-environment";
import { createDefaultHdriLayer, STUDIO_WHITE_HDRI } from "./extractor";

// ── Camera Keyframes (start and end) ──

export interface CameraKeyframe {
  x: number;  // Camera world X position
  y: number;  // Camera world Y position
  z: number;  // Camera world Z position
  rotationX?: number; // Euler X (radians)
  rotationY?: number; // Euler Y (radians)
  rotationZ?: number; // Euler Z (radians)
}

export const DEFAULT_CAMERA_START: CameraKeyframe = {
  x: 0,
  y: 5.5,
  z: 3,
};

export const DEFAULT_CAMERA_END: CameraKeyframe = {
  x: 0,
  y: 12.5,
  z: 2,
};

// ── Camera Path (custom shapes: curve, circle, zigzag, …) ──

/** A waypoint is a full keyframe (position + rotation) plus a stable id for React keys. */
export interface CameraWaypoint extends CameraKeyframe {
  id: string;
}

/** "linear" reproduces the legacy straight start→end lerp. "spline" runs the waypoint curve. */
export type CameraPathMode = "linear" | "spline";

/**
 * Catmull-Rom parameterisation.
 *   centripetal — no self-intersecting loops on sharp turns (best default)
 *   chordal     — spacing-proportional, smoother through uneven point spacing
 *   catmullrom  — uniform, honours `tension`
 *   linear      — straight segments between points (zigzag with hard corners)
 */
export type CameraCurveType = "centripetal" | "chordal" | "catmullrom" | "linear";

/**
 * How the camera is oriented while travelling the path. Both modes aim at the cue; they
 * differ only in whether the camera is allowed to tilt.
 *
 *   level  — the camera stays perfectly horizontal (no pitch/roll) and yaws toward the cue
 *            axis at its OWN height, so the shot's horizon never tips. On a vertical curve
 *            the camera rises alongside the shaft looking straight at it.
 *   center — aim at the cue's center point, tilting up or down as needed.
 *
 * "interpolate" and "path" are retained only so templates saved with them keep loading;
 * both migrate to "level".
 */
export type CameraLookMode = "level" | "center" | "interpolate" | "path";

/** Look modes offered in the UI. The other two exist only for backward compatibility. */
export const CAMERA_LOOK_MODES: readonly { id: CameraLookMode; label: string }[] = [
  { id: "level",  label: "Theo từng góc điểm (luôn ngang)" },
  { id: "center", label: "Luôn hướng center cue" },
];

/** Collapse legacy look modes onto the two supported ones. */
export function normalizeLookMode(mode: CameraLookMode | undefined): CameraLookMode {
  return mode === "center" ? "center" : "level";
}

/**
 * Per-shape size controls. Every preset reads only the fields it needs, so one flat object
 * covers all shapes without a discriminated union in saved templates.
 */
export interface CameraShapeParams {
  /** Radius / half-width of the shape, in world units. Circle, spiral, figure-8. */
  radius: number;
  /** Height of the shape's plane above the world floor. All shapes. */
  height: number;
  /** How far a "cong" bows away from straight, and zigzag's lateral swing. 0–1. */
  amplitude: number;
  /** Number of back-and-forth segments in a zigzag. */
  segments: number;
  /** Turns for the spiral. */
  turns: number;
  /** Vertical rise across the spiral, in world units. */
  rise: number;
}

export const DEFAULT_CAMERA_SHAPE_PARAMS: CameraShapeParams = {
  radius: 8,
  height: 5.5,
  amplitude: 0.35,
  segments: 5,
  turns: 1.5,
  // Tall enough that the climb reads as the dominant motion: at the default radius 8 the
  // helix spans 16 units laterally, so rise must exceed that or it looks like a flat orbit
  // drifting upward rather than a vertical spiral.
  rise: 20,
};

export interface CameraPathConfig {
  mode: CameraPathMode;
  /**
   * When true, the camera follows the shape curve and its start/end are chosen ON the
   * curve. When false the studio uses the legacy two-button placement (free camera →
   * "Đặt") and no curve exists.
   */
  enabled: boolean;
  /** Which shape preset generated the current waypoints ("curve" | "circle" | …). */
  shapeId: string;
  /** Size controls for the active shape. */
  shapeParams: CameraShapeParams;
  /**
   * Every point of the curve, in order. Unlike the earlier design these are the WHOLE
   * path — the camera's start and end are picked from this list via startIndex/endIndex
   * rather than living outside it. The shape is generated around the cue, independent of
   * wherever the camera happens to be, so a circle comes out perfectly round.
   */
  waypoints: CameraWaypoint[];
  /** Index into `waypoints` where the recorded move begins. */
  startIndex: number;
  /** Index into `waypoints` where the recorded move ends. */
  endIndex: number;
  curveType: CameraCurveType;
  /** 0–1, only meaningful when curveType === "catmullrom" */
  tension: number;
  /** Loop the path back to the start — turns an arc into a full circle / orbit. */
  closed: boolean;
  lookMode: CameraLookMode;
}

export const DEFAULT_CAMERA_PATH: CameraPathConfig = {
  mode: "linear",
  enabled: false,
  shapeId: "circle",
  shapeParams: { ...DEFAULT_CAMERA_SHAPE_PARAMS },
  waypoints: [],
  startIndex: 0,
  endIndex: 0,
  curveType: "centripetal",
  tension: 0.5,
  closed: false,
  lookMode: "level",
};

/** Max waypoints on a path — keeps the curve LUT and the UI list manageable. */
export const MAX_CAMERA_WAYPOINTS = 24;

/**
 * True when the camera should follow the shape curve.
 *
 * Requires the toggle on AND at least two points to travel between — a single point has
 * no direction, so it falls back to the legacy straight path.
 */
export function isCameraPathActive(path?: CameraPathConfig): boolean {
  return !!path && path.enabled && path.waypoints.length >= 2;
}

/**
 * The waypoints actually recorded: the span from startIndex to endIndex.
 *
 * On a closed path the span may wrap past the end of the array (e.g. start at 6, end at 2
 * on an 8-point circle), which is what lets a user record any arc of an orbit.
 */
export function getCameraPathSpan(path: CameraPathConfig): CameraWaypoint[] {
  const n = path.waypoints.length;
  if (n === 0) return [];
  const start = Math.max(0, Math.min(n - 1, path.startIndex));
  const end = Math.max(0, Math.min(n - 1, path.endIndex));
  if (start === end) return [path.waypoints[start]];
  if (start < end) return path.waypoints.slice(start, end + 1);
  // Wrapping span — only meaningful on a closed loop.
  if (path.closed) return [...path.waypoints.slice(start), ...path.waypoints.slice(0, end + 1)];
  // Open path picked backwards: walk from end to start instead of wrapping.
  return path.waypoints.slice(end, start + 1).reverse();
}

// ── Camera Direction ──

export type CameraDirection = "fixed" | "x" | "y" | "z" | "xy" | "xz" | "yz" | "xyz";

export interface CameraDirectionPreset {
  id: CameraDirection;
  name: string;
  description: string;
}

export const CAMERA_DIRECTION_PRESETS: CameraDirectionPreset[] = [
  { id: "fixed", name: "Fixed",     description: "Camera stays still" },
  { id: "x",    name: "Slide X",    description: "Left ↔ right" },
  { id: "y",    name: "Slide Y",    description: "Down ↔ up" },
  { id: "z",    name: "Dolly Z",    description: "Close ↔ far" },
  { id: "xy",   name: "Cross XY",   description: "Horizontal + vertical" },
  { id: "xz",   name: "Depth XZ",   description: "Horizontal + depth" },
  { id: "yz",   name: "Along YZ",   description: "Vertical + depth" },
  { id: "xyz",  name: "Free XYZ",   description: "Unconstrained path" },
];

// ── Cue Instance & Config ──

export const MAX_CUE_INSTANCES = 5;

/**
 * Hard position limits derived from studio scene geometry:
 *   - Back wall plane at z = -5.5
 *   - Table surface at y = -7.5  (FRAME_TABLE_Y)
 *   - Wall lateral extent ±17    (34 / 2)
 * These are enforced in both the slider UI and the 3D drag controls.
 */
export const CUE_BOUNDS = {
  xMin: -17,
  xMax: 17,
  yMin: -2,     // table surface (raised from -7.5)
  yMax: 16,     // wall top
  zMin: -5.5,   // back wall plane
  zMax: 6.5,    // front edge of table (FRAME_WALL_Z + FRAME_TABLE_DEPTH)
} as const;

export interface CueInstance {
  id: string;
  positionX: number;  // CUE_BOUNDS.xMin to CUE_BOUNDS.xMax
  positionY: number;  // CUE_BOUNDS.yMin to CUE_BOUNDS.yMax
  positionZ: number;  // CUE_BOUNDS.zMin to CUE_BOUNDS.zMax
  scale: number;      // 4–12
  isMain: boolean;    // first cue is always main
  /** Per-instance rotation (radians). Only used in Simulator mode. Optional for backward compat. */
  rotationX?: number;
  rotationY?: number;
  rotationZ?: number;
  /** Source product whose surface texture is applied to this cue instance (optional). */
  sourceProductId?: string;
  sourceProductName?: string;
  /** Surface image URL to restore the custom texture when loading a template. */
  sourceSurfaceUrl?: string;
}

export interface CueConfig {
  instances: CueInstance[];  // 1–5 cues
  spinY: number;             // Model Y rotation (radians, 0–2π) — shared (Video Studio only)
  spinSpeed: number;         // Continuous Y-rotation speed (0–1) — shared
  spinX: number;             // Model X rotation (radians, 0–2π) — shared (Video Studio only)
  spinSpeedX: number;        // Continuous X-rotation speed (0–1) — shared
  spinZ: number;             // Model Z rotation (radians, 0–2π) — shared (Video Studio only)
}

export const DEFAULT_CUE_CONFIG: CueConfig = {
  instances: [{
    id: "main",
    positionX: 0,
    positionY: 5.5,
    positionZ: 0,
    scale: 7,
    isMain: true,
  }],
  spinY: 0,
  spinSpeed: 0,
  spinX: 0,
  spinSpeedX: 0,
  spinZ: 0,
};

// ── Easing ──

export interface EasingConfig {
  type: "preset" | "custom";
  preset?: string;
  customValue?: string; // cubic-bezier params e.g. "0.4, 0, 0.2, 1"
}

export interface EasingPreset {
  id: string;
  name: string;
  value: string;
  feel: string;
}

export const EASING_PRESETS: EasingPreset[] = [
  { id: "linear",           name: "Linear",               value: "linear",                       feel: "Constant speed" },
  { id: "ease-in",          name: "Ease In",              value: "cubic-bezier(0.4, 0, 1, 1)",   feel: "Slow start, fast end" },
  { id: "ease-out",         name: "Ease Out",             value: "cubic-bezier(0, 0, 0.2, 1)",   feel: "Fast start, slow end" },
  { id: "ease-in-out",      name: "Ease In-Out",          value: "cubic-bezier(0.4, 0, 0.2, 1)", feel: "Smooth acceleration" },
  { id: "cinematic-slow",   name: "Cinematic Slow-Start", value: "cubic-bezier(0.7, 0, 0.3, 1)", feel: "Dramatic slow build" },
  { id: "dramatic-reveal",  name: "Dramatic Reveal",      value: "cubic-bezier(0.1, 0, 0.1, 1)", feel: "Very slow start, hold" },
];

export const DEFAULT_EASING: EasingConfig = {
  type: "preset",
  preset: "ease-in-out",
};

// ── Background Frame & Surface Config ──

export const MAX_BACKGROUND_FRAMES = 4;

// ── Wall / table dimensions ──

/**
 * The V1 backdrop's real size in scene units.
 *
 * `BackgroundFrame.width` / `.height` are fractions of these, so anything converting a
 * frame between wall units and normalised units needs them. They were copied as bare
 * literals into the scene manager and the frame-controls panel, which is how the panel's
 * aspect-fit maths and the renderer's could disagree.
 *
 * Keep in sync with the geometry in `extractor-scene-manager.setupStudioFromStudioConfig`.
 */
export const WALL_WIDTH = 34;
export const WALL_HEIGHT = 24;

/** Default size of a newly created frame, as fractions of the wall. */
export const DEFAULT_FRAME_WIDTH = 0.4;
export const DEFAULT_FRAME_HEIGHT = 0.35;

/** Slider bounds for `BackgroundFrame.width` / `.height`. */
export const MIN_FRAME_SIZE = 0.05;
export const MAX_FRAME_SIZE = 2;

/** @deprecated Only used for legacy frames that have a `type` field */
export type BackgroundFrameType = "color" | "gradient" | "image";

/**
 * @deprecated Only "cover" (repeat-to-fill) remains. The single-centred-tile mode was
 * removed: a backdrop is a wall material, and one tile floating in the middle of the wall
 * never read as one. Kept so templates that stored the field still parse.
 */
export type FrameImageFit = "contain" | "cover";

/**
 * How many image pixels make up one wall unit.
 *
 * A fixed pixel-per-unit is what keeps the mapping predictable: the same image always
 * lands as the same size patch of wall, and one image pixel always covers a known number
 * of texture pixels, so nothing is resampled up (blurry) or squashed down (aliased).
 *
 * 2048 / 34 is the wall's own texture density — the compositor renders the 34-unit wall
 * into a ~2048 px canvas, so at shrink factor 1 one image pixel is one canvas pixel.
 */
export const FRAME_PIXELS_PER_UNIT = 2048 / WALL_WIDTH;

/**
 * How much the image is shrunk before being laid onto the surface, as a fraction of its
 * native size (1 = native, 0.1 = one tenth).
 *
 * This is the only quality/scale control. `FRAME_PIXELS_PER_UNIT` fixes how many image
 * pixels make one wall unit, so shrinking the image makes each tile physically smaller on
 * the wall and more tiles are repeated to fill it. That is exactly what makes the texture
 * read at a believable scale: at native size a 6000 px photo becomes a ~100-unit slab, so
 * the camera — which frames only a few units of wall — sees one enormously magnified
 * patch of leather. Shrinking to ~0.15 puts the grain back at a plausible size and, because
 * more pixels are packed into the same wall area, actually *increases* effective texture
 * detail in shot.
 */
export const MIN_FRAME_IMAGE_SCALE = 0.1;
export const MAX_FRAME_IMAGE_SCALE = 1;

/**
 * Default shrink factor.
 *
 * Native size is far too large for this set's scale, so the default has to be small
 * enough to look like a material rather than a mural.
 */
export const DEFAULT_FRAME_IMAGE_SCALE = 0.2;

/** Clamp a shrink factor into the slider's range. */
export function clampFrameImageScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FRAME_IMAGE_SCALE;
  return Math.min(MAX_FRAME_IMAGE_SCALE, Math.max(MIN_FRAME_IMAGE_SCALE, value));
}

/**
 * The size, in wall units, that an image of the given pixel dimensions occupies at the
 * given shrink factor. Both the wall's frame plane and the cove's composite derive their
 * layout from this one function, which is what keeps them in lockstep.
 */
export function frameImageTileSize(
  imagePixelWidth: number,
  imagePixelHeight: number,
  scale: number = DEFAULT_FRAME_IMAGE_SCALE
): { width: number; height: number } {
  const s = clampFrameImageScale(scale);
  return {
    width: (imagePixelWidth * s) / FRAME_PIXELS_PER_UNIT,
    height: (imagePixelHeight * s) / FRAME_PIXELS_PER_UNIT,
  };
}

/**
 * How many copies of a tile are needed to cover a surface, and where the grid starts.
 *
 * The count is rounded UP and then one extra row/column is added, so the grid always
 * overhangs the surface on every side — that overhang is what guarantees no uncovered
 * strip at the top, bottom or edges, and it is clipped away when drawn. The grid is
 * centred on the surface.
 */
export function frameTileGrid(
  tileWidth: number,
  tileHeight: number,
  surfaceWidth: number,
  surfaceHeight: number
): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(surfaceWidth / Math.max(tileWidth, 1e-6)) + 1);
  const rows = Math.max(1, Math.ceil(surfaceHeight / Math.max(tileHeight, 1e-6)) + 1);
  return { cols, rows };
}

export interface BackgroundFrame {
  id: string;
  // ── Image layer ──
  imageUrl?: string | null;
  imageOpacity?: number;         // 0–1, default 1
  /** @deprecated Layout is always repeat-to-fill now. Kept so older templates parse. */
  imageFit?: FrameImageFit;
  /**
   * Shrink factor applied to the image's native size, 0.1–1 (absent = 0.2).
   *
   * Smaller means a physically smaller tile on the wall and more repeats to fill it,
   * which is how the texture is kept at a believable scale for this set.
   */
  imageScale?: number;
  // ── Background layer ──
  backgroundEnabled?: boolean;   // default true
  backgroundType?: "color" | "gradient";
  backgroundColor?: string;      // Hex color
  backgroundGradient?: { name: string; colors: string[]; angle: number };
  backgroundOpacity?: number;    // 0–1, default 1
  // ── Transform ──
  x: number;        // Center X (0=left, 0.5=center, 1=right)
  y: number;        // Center Y (0=top, 0.5=center, 1=bottom)
  width: number;    // 0–2 (1 = full surface width)
  height: number;   // 0–2 (1 = full surface height)
  rotation: number; // Degrees 0–360
  opacity: number;  // 0–1
  enabled: boolean;
  // ── Legacy (deprecated) ──
  /** @deprecated */
  type?: BackgroundFrameType;
  /** @deprecated Use backgroundColor */
  color?: string;
  /** @deprecated Use backgroundGradient */
  gradient?: { presetId: string; angle: number };
}

export interface SurfaceConfig {
  texturePreset: string;          // Texture pack ID (e.g. "white_plastic")
  envMapIntensity: number;        // 0–1, how much HDRI light the surface receives
  roughness?: number;             // 0–1, override material roughness (undefined = use texture default)
  frames: BackgroundFrame[];      // Max 4, ordered bottom-to-top
  /**
   * Tint applied to the surface material itself, under any frames.
   *
   * This multiplies the texture pack's colour map, so a grey concrete wall set to #103050
   * keeps its grain and takes the blue. It is the quick way to recolour the whole set —
   * wall, table and the corner cove that follows the wall — without adding a full-bleed
   * frame that would then sit between the wall and the logo backdrop.
   *
   * Absent on templates saved before it existed, which means "no tint" (#ffffff).
   */
  baseTint?: string;
  /** @deprecated Use texturePreset instead. Kept for migration. */
  baseColor?: string;
}

export const DEFAULT_WALL_SURFACE: SurfaceConfig = {
  texturePreset: "white_studio",
  envMapIntensity: 0.6,
  frames: [],
};

export const DEFAULT_TABLE_SURFACE: SurfaceConfig = {
  texturePreset: "white_studio",
  envMapIntensity: 0.4,
  frames: [],
};

// ── Gradient Presets (45 total: 15 cold, 15 warm, 15 neutral) ──

export type GradientCategory = "cold" | "warm" | "neutral";

export interface GradientPreset {
  id: string;
  name: string;
  category: GradientCategory;
  colors: string[];
  angle: number;
}

export const GRADIENT_PRESETS: GradientPreset[] = [
  // ── Cold (15) ──
  { id: "c01", name: "Arctic Ice",       category: "cold", colors: ["#0f2027", "#2c5364"], angle: 135 },
  { id: "c02", name: "Frozen Dawn",      category: "cold", colors: ["#141e30", "#243b55"], angle: 180 },
  { id: "c03", name: "Deep Ocean",       category: "cold", colors: ["#000428", "#004e92"], angle: 135 },
  { id: "c04", name: "Midnight Teal",    category: "cold", colors: ["#0a1628", "#1a4a5e", "#0d2137"], angle: 180 },
  { id: "c05", name: "Polar Night",      category: "cold", colors: ["#0c0c1d", "#1a1a3e"], angle: 160 },
  { id: "c06", name: "Sapphire",         category: "cold", colors: ["#0f0c29", "#302b63", "#24243e"], angle: 135 },
  { id: "c07", name: "Glacial Blue",     category: "cold", colors: ["#0d1b2a", "#1b3a4b"], angle: 180 },
  { id: "c08", name: "Twilight",         category: "cold", colors: ["#0a0e27", "#232946"], angle: 135 },
  { id: "c09", name: "Nebula",           category: "cold", colors: ["#16002f", "#2b1055", "#0f0f3d"], angle: 160 },
  { id: "c10", name: "Steel",            category: "cold", colors: ["#1a1a2e", "#16213e"], angle: 180 },
  { id: "c11", name: "Frost",            category: "cold", colors: ["#0b1520", "#1a3a4a", "#0d2030"], angle: 135 },
  { id: "c12", name: "Cyan Pulse",       category: "cold", colors: ["#000000", "#003545"], angle: 180 },
  { id: "c13", name: "Indigo Night",     category: "cold", colors: ["#0a0015", "#1a0a3e"], angle: 160 },
  { id: "c14", name: "Blue Velvet",      category: "cold", colors: ["#0d0221", "#150e3d", "#0a0a2e"], angle: 135 },
  { id: "c15", name: "Winter Sky",       category: "cold", colors: ["#0c1824", "#1e3a50"], angle: 180 },

  // ── Warm (15) ──
  { id: "w01", name: "Ember",            category: "warm", colors: ["#1a0000", "#3d0c02"], angle: 135 },
  { id: "w02", name: "Sunset Gold",      category: "warm", colors: ["#1a0f00", "#3d2400", "#1a1000"], angle: 180 },
  { id: "w03", name: "Amber Glow",       category: "warm", colors: ["#1a1000", "#3d2c00"], angle: 135 },
  { id: "w04", name: "Volcanic",         category: "warm", colors: ["#0f0000", "#2d0a00", "#1a0500"], angle: 160 },
  { id: "w05", name: "Desert Sand",      category: "warm", colors: ["#1a1208", "#3d2e1a"], angle: 180 },
  { id: "w06", name: "Rose Gold",        category: "warm", colors: ["#1a0a10", "#3d1a2a", "#2a0f1a"], angle: 135 },
  { id: "w07", name: "Copper",           category: "warm", colors: ["#1a0d05", "#3d2010"], angle: 180 },
  { id: "w08", name: "Mahogany",         category: "warm", colors: ["#1a0505", "#3d1010"], angle: 160 },
  { id: "w09", name: "Burnt Sienna",     category: "warm", colors: ["#1a0a00", "#3d1f0a", "#2a1205"], angle: 135 },
  { id: "w10", name: "Crimson",          category: "warm", colors: ["#0f0005", "#2d0010"], angle: 180 },
  { id: "w11", name: "Terracotta",       category: "warm", colors: ["#1a0e08", "#3d2418"], angle: 135 },
  { id: "w12", name: "Firefly",          category: "warm", colors: ["#0a0800", "#1a1800", "#0d0d00"], angle: 160 },
  { id: "w13", name: "Rust",             category: "warm", colors: ["#1a0800", "#3d1800"], angle: 180 },
  { id: "w14", name: "Wine",             category: "warm", colors: ["#1a0010", "#2d0020", "#1a0015"], angle: 135 },
  { id: "w15", name: "Molten",           category: "warm", colors: ["#0f0500", "#2d1400"], angle: 160 },

  // ── Neutral (15) ──
  { id: "n01", name: "Charcoal",         category: "neutral", colors: ["#0a0a0a", "#1a1a1a"], angle: 180 },
  { id: "n02", name: "Graphite",         category: "neutral", colors: ["#0d0d0d", "#2a2a2a", "#141414"], angle: 135 },
  { id: "n03", name: "Smoke",            category: "neutral", colors: ["#121212", "#1e1e1e"], angle: 180 },
  { id: "n04", name: "Obsidian",         category: "neutral", colors: ["#050505", "#151515"], angle: 160 },
  { id: "n05", name: "Slate",            category: "neutral", colors: ["#0e0e12", "#1c1c24"], angle: 135 },
  { id: "n06", name: "Ash",              category: "neutral", colors: ["#141414", "#242424", "#1a1a1a"], angle: 180 },
  { id: "n07", name: "Onyx",             category: "neutral", colors: ["#080808", "#181818"], angle: 135 },
  { id: "n08", name: "Pewter",           category: "neutral", colors: ["#101012", "#202025"], angle: 160 },
  { id: "n09", name: "Iron",             category: "neutral", colors: ["#0c0c0e", "#1c1c20", "#121215"], angle: 180 },
  { id: "n10", name: "Shadow",           category: "neutral", colors: ["#060606", "#161616"], angle: 135 },
  { id: "n11", name: "Carbon",           category: "neutral", colors: ["#0a0a0b", "#1a1a1c"], angle: 180 },
  { id: "n12", name: "Basalt",           category: "neutral", colors: ["#0d0d0f", "#1d1d22", "#131316"], angle: 160 },
  { id: "n13", name: "Ebony",            category: "neutral", colors: ["#070708", "#171718"], angle: 135 },
  { id: "n14", name: "Granite",          category: "neutral", colors: ["#0f0f10", "#1f1f22"], angle: 180 },
  { id: "n15", name: "Thunder",          category: "neutral", colors: ["#080810", "#18182a"], angle: 160 },
];

// ── Full Studio Config ──

export interface CueHdriConfig {
  hdriType: string;       // HDRI filename (e.g. "bloem_train_track_clear_2k.hdr")
  rotationX: number;      // 0-360 degrees (vertical shift)
  rotationY: number;      // 0-360 degrees (horizontal shift)
  intensity: number;      // 0-3
}

export const DEFAULT_CUE_HDRI: CueHdriConfig = {
  hdriType: "bloem_train_track_clear_2k.hdr",
  rotationX: 0,
  rotationY: 300,
  intensity: 1.0,
};

/**
 * Curved corner fillet ("cyclorama" cove) between wall and table.
 *
 * The fillet exists so the cue's shadow sweeps smoothly across the wall/table junction
 * instead of breaking at a hard 90 degree edge. Because it is real geometry it also has
 * to *look* like part of the set, so it has no appearance of its own: the scene manager
 * always derives its material from whatever the wall visibly shows — a covering
 * background frame's colour or image if there is one, otherwise the wall material.
 * There is deliberately no material picker; a cove that can disagree with the wall is
 * the bug this replaced.
 */
export interface CornerFillConfig {
  /** When false the fillet mesh is removed and the shadow receiver uses a sharp corner. */
  enabled: boolean;
  /** Fillet radius in scene units. Larger = wider, softer cove. */
  radius: number;
  /**
   * Last-resort tint, used only when the wall itself is the flat unlit white surface
   * (`surfaceLightDisabled`) and no covering frame resolves. Not exposed in the UI.
   */
  color: string;
}

export const DEFAULT_CORNER_FILL: CornerFillConfig = {
  enabled: true,
  radius: 0.8,
  color: "#ffffff",
};

// ── Scene Background (the void around the wall/table set) ──

/**
 * Colour of the empty space surrounding the V1 set.
 *
 * V1 builds only two planes — a 34x22 wall at z = -5.5 and a 28x5 table at y = -1.2.
 * Anything the camera sees outside those planes is `scene.background`, which used to be
 * hardcoded to 0x1a1a1a. That is why setting the wall and table to #000 still left a
 * lighter grey border around the set: the border was never a surface at all.
 */
export interface SceneBackgroundConfig {
  /** Hex colour painted behind everything. */
  color: string;
}

export const DEFAULT_SCENE_BACKGROUND: SceneBackgroundConfig = {
  // The historical hardcoded value, so untouched templates look exactly as before.
  color: "#1a1a1a",
};

// ── Logo Backdrop (giant camera-locked logo behind the cue) ──

/**
 * How the logo plate is coloured.
 *
 *   solid — one flat fill, the plain "giant watermark" look.
 *   neon  — the CSS neon-text recipe (a bright near-white core wrapped in stacked
 *           coloured glows) rendered in a shader, so the core and the halo are
 *           two independent colours.
 */
export type LogoBackdropStyle = "solid" | "neon";

/**
 * Where the logo plate lives.
 *
 *   wall   — real geometry parked just in front of the back wall, inside the set. It is
 *            genuinely behind the cue, takes the set's perspective, and moves with the
 *            wall as the camera travels (a painted mural).
 *   screen — locked to the camera frame: the same screen position in every frame of the
 *            recording, regardless of camera motion (a title card / watermark).
 */
export type LogoBackdropAnchor = "wall" | "screen";

/**
 * A large, blurred rendition of the cue's laser-engraved logo, drawn behind the cue.
 *
 * It is rendered by a dedicated orthographic overlay pass rather than by a plane placed
 * in the world, which is what makes it stay locked to the camera frame: the studio camera
 * can orbit, dolly or spiral and the logo never shifts, exactly like a fixed background
 * plate in a title card. See `renderLogoBackdrop` in ExtractorSceneManager.
 */
export interface LogoBackdropConfig {
  enabled: boolean;
  /**
   * Which logo to draw. "auto" follows the product's own `logoId` (the "Logo khắc laser"
   * currently engraved on the cue); any other value is an explicit CUE_LOGO_OPTIONS id.
   * `customUrl` overrides both when set.
   */
  logoId: string;
  /** User-uploaded PNG/SVG (object URL or remote). Takes precedence over `logoId`. */
  customUrl?: string | null;
  /**
   * Whether the plate is set geometry on the wall or locked to the camera frame.
   * Absent on templates saved before the choice existed; those were all screen-locked.
   */
  anchor?: LogoBackdropAnchor;
  /**
   * Wall anchor only: position the plate inside the rectangle the camera's view cuts out of
   * the wall, instead of against the wall itself.
   *
   * The plate stays real geometry on the wall — the cue still occludes it and it still takes
   * the set's perspective — but its placement is recomputed each frame from where the
   * camera's frustum meets the wall, so it holds the same spot in the SHOT while the camera
   * moves. Without this a logo composed in the editor slides out of frame as soon as the
   * camera travels.
   *
   * Absent = false, so templates saved earlier keep their wall-fixed placement.
   */
  frameRelative?: boolean;
  style: LogoBackdropStyle;
  /** Fill colour (solid style) / core colour (neon style). */
  color: string;
  /** Neon halo colour — the "light" of the neon tube. Ignored by the solid style. */
  neonColor: string;
  /**
   * Neon brightness, 0–1. How hot the halo burns — brightness only.
   *
   * This used to drive the glow's RADIUS as well, so "brighter" and "wider" could not be
   * separated and the effect read as a soft shadow rather than a lit tube. Reach now lives
   * in `neonGlowSize`.
   */
  neonIntensity: number;
  /** Neon halo reach, 0–1. How far the light spreads past the tube. Absent = 0.5. */
  neonGlowSize?: number;
  /**
   * Tube core thickness, 0–1. Low values leave a thin bright filament with most of the
   * mark given over to glow; high values light the whole stroke. Absent = 0.5.
   */
  neonCoreWidth?: number;
  /**
   * How white-hot the centre of the tube burns, 0–1. Real neon overexposes to near-white
   * at the tube regardless of the gas colour; 0 keeps the core fully coloured. Absent = 0.65.
   */
  neonCoreGlow?: number;
  /**
   * Outer bloom, 0–1. A second, far wider and dimmer halo — the light the tube throws onto
   * the wall around it. This is most of what separates real neon from a coloured blur.
   * Absent = 0.5.
   */
  neonBloom?: number;
  /**
   * Flicker amount, 0–1. Subtle brightness instability, as in an ageing tube. 0 = rock
   * steady. Absent = 0 so existing templates never start flickering on their own.
   */
  neonFlicker?: number;
  /**
   * Gaussian blur radius for the SOLID style, 0 = crisp, 1 = very soft.
   *
   * Solid and neon are independent looks with independent softness: a neon tube's crispness
   * is a property of the tube, and inheriting a solid plate's heavy blur turned every neon
   * sign into a smear. Neon reads `neonBlur` instead.
   */
  blur: number;
  /** Gaussian blur radius for the NEON style only. Absent = 0 (a crisp tube). */
  neonBlur?: number;
  /** Overall opacity 0–1. */
  opacity: number;
  /**
   * Size as a fraction of the frame. 1 = the logo's longest side exactly spans the frame,
   * so the whole mark is always visible ("display full in camera frame").
   */
  scale: number;
  /** Centre offset in frame units (-1..1). 0,0 = dead centre. */
  offsetX: number;
  offsetY: number;
  /** Clockwise rotation in degrees. */
  rotation: number;
}

export const DEFAULT_LOGO_BACKDROP: LogoBackdropConfig = {
  enabled: false,
  logoId: "auto",
  customUrl: null,
  // On the wall by default: it is what "behind the cue" actually means in this set, and
  // it behaves correctly in every view without needing to fight the camera.
  anchor: "wall",
  // Stay in shot by default: a logo that drifts out of frame the moment the camera moves is
  // almost never what is wanted from a backdrop.
  frameRelative: true,
  style: "solid",
  color: "#ffffff",
  neonColor: "#ff2fd0",
  neonIntensity: 0.6,
  neonGlowSize: 0.5,
  neonCoreWidth: 0.5,
  neonCoreGlow: 0.65,
  neonBloom: 0.5,
  neonFlicker: 0,
  // A neon tube is crisp by default; its softness comes from the glow, not from blurring
  // the mark itself.
  neonBlur: 0,
  // A visible softness by default — the reference look is a blurred plate, not a sticker.
  blur: 0.35,
  opacity: 0.85,
  scale: 0.9,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
};

/**
 * localStorage key holding the logo backdrop settings shared by every template.
 *
 * The plate is branding, not scene composition: the same mark, colour and neon treatment
 * belong on every video of a product regardless of which camera/lighting template is
 * loaded. Keeping it per-template meant re-dialling the whole neon look every time a
 * template was switched, and a template saved by someone else silently replaced it.
 */
export const LOGO_BACKDROP_STORAGE_KEY = "videoStudio.logoBackdrop.global";

/**
 * Read the globally shared logo backdrop config.
 *
 * Returns the default when nothing is stored, when the value is unparseable, or when
 * running on the server. Merged over the default so a field added later is present even in
 * a config written by an older build.
 */
export function loadGlobalLogoBackdrop(): LogoBackdropConfig {
  if (typeof window === "undefined") return { ...DEFAULT_LOGO_BACKDROP };
  try {
    const raw = window.localStorage.getItem(LOGO_BACKDROP_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LOGO_BACKDROP };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_LOGO_BACKDROP };
    return {
      ...DEFAULT_LOGO_BACKDROP,
      ...(parsed as Partial<LogoBackdropConfig>),
      // `enabled` is deliberately NOT restored. What the plate LOOKS like is shared branding;
      // whether a given shot has a logo on the wall at all is a per-shot decision, and
      // carrying it across meant every new template silently opened with the logo already on.
      enabled: DEFAULT_LOGO_BACKDROP.enabled,
    };
  } catch {
    return { ...DEFAULT_LOGO_BACKDROP };
  }
}

/**
 * Persist the globally shared logo backdrop config. Silently no-ops if storage is full.
 *
 * `enabled` is stored as false regardless of the live value: the shared blob describes what
 * the plate looks like, not whether any particular shot uses one. See loadGlobalLogoBackdrop.
 */
export function saveGlobalLogoBackdrop(config: LogoBackdropConfig): void {
  if (typeof window === "undefined") return;
  try {
    const shared: LogoBackdropConfig = { ...config, enabled: DEFAULT_LOGO_BACKDROP.enabled };
    window.localStorage.setItem(LOGO_BACKDROP_STORAGE_KEY, JSON.stringify(shared));
  } catch {
    // A private window or a full quota must not break the studio.
  }
}

export interface VideoStudioConfig {
  cueConfig: CueConfig;
  cameraDirection: CameraDirection;
  cameraStart: CameraKeyframe;
  cameraEnd: CameraKeyframe;
  /** Optional custom camera path (curve / circle / zigzag …). Absent or mode:"linear"
   *  with no waypoints reproduces the legacy straight start→end interpolation exactly. */
  cameraPath?: CameraPathConfig;
  cameraSpeed: number;
  lockDistance: boolean;      // Deprecated — kept for backward compatibility with saved templates
  easing: EasingConfig;
  wallSurface: SurfaceConfig;
  tableSurface: SurfaceConfig;
  hdriConfig: { layers: HdriLayer[] };
  hdriIntensity: number;               // Environment intensity (0–3, default 1.0)
  /** Mixed cue HDRI — up to 2 HdriLayers blended and applied only to the cue model.
   *  When non-empty, takes precedence over the legacy `cueHdri` field. */
  cueHdriLayers?: HdriLayer[];
  cueHdri: CueHdriConfig;             // Cue-only HDRI lighting (separate from studio surface light)
  quality: "2k" | "2k120";
  shadow: { enabled: boolean; intensity: number; blur: number; softness: number; offsetX: number; offsetY: number };
  hdriFile: string;
  /** When true, wall and table surfaces use a flat MeshBasicMaterial (pure white) that is
   *  completely unaffected by studio lights / env map. Matches Simulator Studio behaviour. */
  surfaceLightDisabled?: boolean;
  /** Curved wall/table corner fillet. Absent on legacy templates — treated as the default
   *  (enabled, wall material) so existing saved scenes keep their current look. */
  cornerFill?: CornerFillConfig;
  /** Output aspect ratio for recording. Defaults to "16:9". */
  videoRatio?: VideoRatio;
  /** Duration (seconds) used when camera start and end positions are identical (fixed camera).
   *  Ignored when start ≠ end — in that case duration is computed from path length + speed. */
  fixedCameraDuration?: number;
  /** @deprecated Unified HDRI now used. Wall/table use envMapIntensity on SurfaceConfig. */
  surfaceHdri?: { enabled: boolean; hdriFile: string; rotationX: number; rotationY: number; intensity: number };
  /**
   * Colour of the empty space around the wall/table set. Absent on legacy templates,
   * which are treated as the old hardcoded #1a1a1a so their look is unchanged.
   */
  sceneBackground?: SceneBackgroundConfig;
  /** Giant camera-locked logo plate drawn behind the cue. Absent = disabled. */
  logoBackdrop?: LogoBackdropConfig;
  /**
   * Video Studio V2 — real 3D environment (360 degree HDRI or GLB room).
   *
   * Presence of this field is what selects V2: when set, the scene manager skips the V1
   * flat wall + table planes and builds a real surrounding space instead. Absent on every
   * V1 config and V1 saved template, so V1 behaviour is bit-for-bit unchanged.
   */
  environment?: StudioEnvironmentConfig;
}

export const DEFAULT_STUDIO_CONFIG: VideoStudioConfig = {
  cueConfig: { ...DEFAULT_CUE_CONFIG, instances: DEFAULT_CUE_CONFIG.instances.map(i => ({ ...i })) },
  cameraDirection: "yz",
  cameraStart: { ...DEFAULT_CAMERA_START },
  cameraEnd: { ...DEFAULT_CAMERA_END },
  cameraPath: { ...DEFAULT_CAMERA_PATH, waypoints: [] },
  cameraSpeed: 0.25,
  lockDistance: false,
  easing: { ...DEFAULT_EASING },
  wallSurface: { ...DEFAULT_WALL_SURFACE },
  tableSurface: { ...DEFAULT_TABLE_SURFACE },
  hdriConfig: { layers: [createDefaultHdriLayer(STUDIO_WHITE_HDRI)] },
  hdriIntensity: 1.0,
  cueHdri: { ...DEFAULT_CUE_HDRI },
  quality: "2k",
  shadow: { enabled: true, intensity: 0.35, blur: 4, softness: 0.5, offsetX: 0, offsetY: 0 },
  hdriFile: "ferndale_studio_07_2k.hdr",
  surfaceLightDisabled: true,
  cornerFill: { ...DEFAULT_CORNER_FILL },
  videoRatio: "16:9",
  fixedCameraDuration: 10,
  sceneBackground: { ...DEFAULT_SCENE_BACKGROUND },
  logoBackdrop: { ...DEFAULT_LOGO_BACKDROP },
};

/**
 * Default config for Video Studio V2.
 *
 * Identical to V1 except that it carries an `environment` block — which is what makes the
 * scene manager build a real 3D space instead of the flat wall + table — and turns off
 * `surfaceLightDisabled`, since the "unlit pure white surface" trick exists only to keep
 * the fake V1 set neutral and would fight the room's real lighting.
 */
export const DEFAULT_STUDIO_CONFIG_V2: VideoStudioConfig = {
  ...DEFAULT_STUDIO_CONFIG,
  cueConfig: {
    ...DEFAULT_CUE_CONFIG,
    instances: DEFAULT_CUE_CONFIG.instances.map(i => ({ ...i })),
  },
  cameraStart: { ...DEFAULT_CAMERA_START },
  cameraEnd: { ...DEFAULT_CAMERA_END },
  cameraPath: { ...DEFAULT_CAMERA_PATH, waypoints: [] },
  easing: { ...DEFAULT_EASING },
  wallSurface: { ...DEFAULT_WALL_SURFACE },
  tableSurface: { ...DEFAULT_TABLE_SURFACE },
  hdriConfig: { layers: [createDefaultHdriLayer(STUDIO_WHITE_HDRI)] },
  cueHdri: { ...DEFAULT_CUE_HDRI },
  shadow: { enabled: true, intensity: 0.35, blur: 4, softness: 0.5, offsetX: 0, offsetY: 0 },
  surfaceLightDisabled: false,
  cornerFill: { ...DEFAULT_CORNER_FILL },
  environment: {
    ...DEFAULT_STUDIO_ENVIRONMENT,
    groundProjection: { ...DEFAULT_STUDIO_ENVIRONMENT.groundProjection },
    shadowCatcher: { ...DEFAULT_STUDIO_ENVIRONMENT.shadowCatcher },
    roomTransform: { ...DEFAULT_STUDIO_ENVIRONMENT.roomTransform },
  },
};

/** True when a config drives the V2 (real 3D environment) studio. */
export function isStudioV2(config: VideoStudioConfig): boolean {
  return !!config.environment;
}

// ── Studio Template (DB record) ──

export interface VideoStudioTemplate {
  id: string;
  name: string;
  config: VideoStudioConfig;
  productId?: string;
  productName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string | null;
  createdByName?: string; // nickname or email of the creator
  isOwner?: boolean;      // true if the current user created this template
  canEdit?: boolean;      // true if the current user created it OR is a tool admin
}

// ── Quality Presets ──

export const VIDEO_QUALITY_PRESETS = {
  "2k":    { width: 2560, height: 1440, bitrate: 20_000_000, fps: 60 },
  "2k120": { width: 2560, height: 1440, bitrate: 30_000_000, fps: 120 },
} as const;

// ── Video Ratio ──

export type VideoRatio = "16:9" | "1:1" | "9:16" | "4:5" | "4:3";

export interface VideoRatioPreset {
  id: VideoRatio;
  label: string;
  /** Width relative to 1440-height baseline */
  width: number;
  height: number;
}

/** All ratios share height=1440 so pixel density stays consistent across formats. */
export const VIDEO_RATIO_PRESETS: VideoRatioPreset[] = [
  { id: "16:9", label: "16:9 Ngang",  width: 2560, height: 1440 },
  { id: "4:3",  label: "4:3 Ngang",   width: 1920, height: 1440 },
  { id: "1:1",  label: "1:1 Vuông",   width: 1440, height: 1440 },
  { id: "4:5",  label: "4:5 Dọc",     width: 1152, height: 1440 },
  { id: "9:16", label: "9:16 Dọc",    width:  810, height: 1440 },
];

/**
 * Contract between the deterministic recorder and whatever consumes its frames.
 *
 * The wall-clock recorder hands back a finished Blob because MediaRecorder
 * encodes as it goes. The deterministic recorder cannot: it renders frame N,
 * waits for that frame to be safely stored, and only then renders frame N+1 —
 * so it needs somewhere to put each frame. In the GPU worker that sink writes
 * a PNG to the pod's disk over CDP and ffmpeg muxes them afterwards; in a
 * browser it can collect blobs in memory.
 *
 * `writeFrame` MUST NOT resolve until the frame is durably handed off. That
 * promise is the entire backpressure mechanism — the reason no frame can ever
 * be dropped, however slow the render or the disk.
 */
export interface DeterministicFrameSink {
  /**
   * Stores one encoded PNG frame. `index` is zero-based and gap-free, so the
   * consumer can rely on a contiguous sequence for ffmpeg's image demuxer.
   */
  writeFrame(index: number, frame: Blob): Promise<void>;
  /**
   * Takes the frame straight off the canvas, skipping PNG entirely.
   *
   * Only a sink that lives in the same process as the canvas can do this — the
   * in-browser WebCodecs encoder can, the worker cannot, because its frames must
   * cross into Node as JSON and binary does not survive that trip. When present
   * the recorder always prefers it: PNG compression at 2K is single-threaded
   * main-thread work that costs more than drawing the frame did.
   */
  writeCanvasFrame?(index: number, canvas: HTMLCanvasElement): Promise<void>;
  /**
   * Called once after the last frame, and returns the finished video. Both
   * sinks mux their own output — ffmpeg on the pod, mp4-muxer in the browser.
   */
  finish(frameCount: number, fps: number): Promise<Blob>;
  /**
   * Called instead of finish() when a take is abandoned, so the sink can release
   * what it is holding. A WebCodecs encoder owns GPU buffers that are not
   * garbage collected, so a cancelled take leaks them until the tab is closed.
   *
   * Must not throw: it runs on the failure path, where a second error would
   * mask the first.
   */
  abort?(): void;
}

/** How a studio recording turns rendered frames into a video file. */
export type VideoRecordingMode = "realtime" | "deterministic";

/** Resolve final recording dimensions from quality + ratio */
export function getRecordingDimensions(
  quality: "2k" | "2k120",
  ratio: VideoRatio = "16:9"
): { width: number; height: number; bitrate: number; fps: number } {
  const qp = VIDEO_QUALITY_PRESETS[quality];
  const rp = VIDEO_RATIO_PRESETS.find(r => r.id === ratio) ?? VIDEO_RATIO_PRESETS[0];
  const scaleFactor = qp.height / 1440;
  return {
    width: Math.round(rp.width * scaleFactor),
    height: Math.round(rp.height * scaleFactor),
    bitrate: Math.round(qp.bitrate * (rp.width / 2560)),
    fps: qp.fps,
  };
}

// ── Utility: Compute video duration from camera path ──

/**
 * Returns true when the camera never moves (fixed / static shot).
 *
 * A custom path is NEVER fixed even when start === end: a *closed* path (circle, orbit,
 * figure-8) loops back to its own start point, so comparing endpoints alone would
 * mis-classify every circular orbit as a static shot.
 */
export function isCameraFixed(
  start: CameraKeyframe,
  end: CameraKeyframe,
  path?: CameraPathConfig
): boolean {
  // A curve path is fixed only when its recorded span collapses to a single point.
  if (isCameraPathActive(path)) return getCameraPathSpan(path!).length < 2;
  const EPS = 1e-6;
  return Math.abs(start.x - end.x) < EPS && Math.abs(start.y - end.y) < EPS && Math.abs(start.z - end.z) < EPS;
}

/** Apply direction constraint: only axes included in `direction` interpolate; others stay at start value */
export function applyDirection(
  start: CameraKeyframe,
  end: CameraKeyframe,
  direction: CameraDirection
): CameraKeyframe {
  const moveX = direction === "x" || direction === "xy" || direction === "xz" || direction === "xyz";
  const moveY = direction === "y" || direction === "xy" || direction === "yz" || direction === "xyz";
  const moveZ = direction === "z" || direction === "xz" || direction === "yz" || direction === "xyz";
  return {
    x: moveX ? end.x : start.x,
    y: moveY ? end.y : start.y,
    z: moveZ ? end.z : start.z,
    rotationX: end.rotationX,
    rotationY: end.rotationY,
    rotationZ: end.rotationZ,
  };
}

/**
 * Duration = path length / speed.
 *
 * For a custom path the length is the polyline length through every waypoint (a cheap,
 * dependency-free approximation of the spline arc length — within a few percent for
 * typical waypoint spacing, and it needs no THREE import so this module stays pure).
 * The exact arc length is available from the sampler in `lib/three/camera-path.ts`;
 * this estimate only drives the duration, so a few percent is immaterial.
 */
export function computeVideoDuration(
  start: CameraKeyframe,
  end: CameraKeyframe,
  cameraSpeed: number,
  direction: CameraDirection = "xyz",
  fixedDuration?: number,
  path?: CameraPathConfig
): number {
  if (isCameraFixed(start, end, path) && fixedDuration !== undefined) {
    return Math.max(3, Math.min(300, fixedDuration));
  }

  let pathLength: number;
  if (isCameraPathActive(path)) {
    // Walk only the recorded span (startIndex → endIndex), which is what the camera
    // actually travels — the untrimmed remainder of a shape must not inflate duration.
    const pts = getCameraPathSpan(path!);
    pathLength = 0;
    for (let i = 1; i < pts.length; i++) {
      const dX = pts[i].x - pts[i - 1].x;
      const dY = pts[i].y - pts[i - 1].y;
      const dZ = pts[i].z - pts[i - 1].z;
      pathLength += Math.sqrt(dX * dX + dY * dY + dZ * dZ);
    }
  } else {
    const effectiveEnd = applyDirection(start, end, direction);
    const dX = effectiveEnd.x - start.x;
    const dY = effectiveEnd.y - start.y;
    const dZ = effectiveEnd.z - start.z;
    pathLength = Math.sqrt(dX * dX + dY * dY + dZ * dZ);
  }

  const duration = pathLength / Math.max(0.01, cameraSpeed);
  // Cap matches the fixed-camera cap (300s): a long spiral at low speed easily exceeds
  // 60s, and a lower cap would make the speed slider stop having any effect.
  return Math.max(3, Math.min(300, duration));
}

// ── Utility: Parse easing to interpolation function ──

export function createEasingFunction(config: EasingConfig): (t: number) => number {
  const presetMap: Record<string, string> = {};
  EASING_PRESETS.forEach(p => { presetMap[p.id] = p.value; });

  let value = "linear";
  if (config.type === "preset" && config.preset) {
    value = presetMap[config.preset] || "linear";
  } else if (config.type === "custom" && config.customValue) {
    value = `cubic-bezier(${config.customValue})`;
  }

  if (value === "linear") return (t: number) => t;

  const match = value.match(/cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
  if (!match) return (t: number) => t;

  const [, p1xS, p1yS, p2xS, p2yS] = match;
  return cubicBezier(Number(p1xS), Number(p1yS), Number(p2xS), Number(p2yS));
}

function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (t: number) => number {
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Newton-Raphson to solve for x parameter
    let x = t;
    for (let i = 0; i < 8; i++) {
      const cx = 3 * p1x * x * (1 - x) * (1 - x) + 3 * p2x * x * x * (1 - x) + x * x * x - t;
      const dx = 3 * p1x * (1 - x) * (1 - x) - 6 * p1x * x * (1 - x) + 6 * p2x * x * (1 - x) - 3 * p2x * x * x + 3 * x * x;
      if (Math.abs(dx) < 1e-6) break;
      x -= cx / dx;
    }
    return 3 * p1y * x * (1 - x) * (1 - x) + 3 * p2y * x * x * (1 - x) + x * x * x;
  };
}

// ── Factory: Create a new background frame ──

export function createBackgroundFrame(): BackgroundFrame {
  return {
    id: crypto.randomUUID(),
    imageUrl: null,
    imageOpacity: 1,
    backgroundEnabled: true,
    backgroundType: "color",
    backgroundColor: "#1a1a1a",
    backgroundOpacity: 1,
    x: 0.5,
    y: 0.5,
    width: DEFAULT_FRAME_WIDTH,
    height: DEFAULT_FRAME_HEIGHT,
    rotation: 0,
    opacity: 1,
    enabled: true,
  };
}

// ── Factory: Create a new cue instance ──

export function createCueInstance(offsetX = 2): CueInstance {
  return {
    id: crypto.randomUUID(),
    positionX: offsetX,
    positionY: 5.5,
    positionZ: 0,
    scale: 7,
    isMain: false,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
  };
}

// ── Factory: Create a camera waypoint ──

export function createCameraWaypoint(kf: CameraKeyframe): CameraWaypoint {
  return {
    id: crypto.randomUUID(),
    x: kf.x,
    y: kf.y,
    z: kf.z,
    rotationX: kf.rotationX ?? 0,
    rotationY: kf.rotationY ?? 0,
    rotationZ: kf.rotationZ ?? 0,
  };
}

// ── Migration: Upgrade old SurfaceConfig to new format ──

/** Migrate a SurfaceConfig from baseColor format to texturePreset format */
export function migrateSurfaceConfig(
  surface: SurfaceConfig,
  defaultPreset: string,
  defaultIntensity: number
): SurfaceConfig {
  if (surface.texturePreset) return surface;
  return {
    texturePreset: defaultPreset,
    envMapIntensity: defaultIntensity,
    frames: surface.frames ?? [],
  };
}

/** Merge a partial/old config with defaults so every field is guaranteed present */
export function ensureFullConfig(partial: Partial<VideoStudioConfig>): VideoStudioConfig {
  const d = structuredClone(DEFAULT_STUDIO_CONFIG);
  return {
    ...d,
    ...partial,
    cueConfig: { ...d.cueConfig, ...partial.cueConfig },
    cameraStart: { ...d.cameraStart, ...partial.cameraStart },
    cameraEnd: { ...d.cameraEnd, ...partial.cameraEnd },
    cameraPath: {
      ...DEFAULT_CAMERA_PATH,
      ...partial.cameraPath,
      shapeParams: { ...DEFAULT_CAMERA_SHAPE_PARAMS, ...partial.cameraPath?.shapeParams },
      waypoints: partial.cameraPath?.waypoints?.map(w => ({ ...w })) ?? [],
    },
    easing: { ...d.easing, ...partial.easing },
    wallSurface: { ...d.wallSurface, ...partial.wallSurface },
    tableSurface: { ...d.tableSurface, ...partial.tableSurface },
    hdriConfig: partial.hdriConfig?.layers ? partial.hdriConfig : d.hdriConfig,
    cueHdri: { ...d.cueHdri, ...partial.cueHdri },
    shadow: { ...d.shadow, ...partial.shadow },
    surfaceLightDisabled: partial.surfaceLightDisabled ?? d.surfaceLightDisabled,
    cornerFill: { ...DEFAULT_CORNER_FILL, ...partial.cornerFill },
    videoRatio: partial.videoRatio ?? d.videoRatio,
    fixedCameraDuration: partial.fixedCameraDuration ?? d.fixedCameraDuration,
    sceneBackground: { ...DEFAULT_SCENE_BACKGROUND, ...partial.sceneBackground },
    logoBackdrop: { ...DEFAULT_LOGO_BACKDROP, ...partial.logoBackdrop },
    // Preserved so V2 templates keep their environment; left undefined for V1 configs.
    environment: partial.environment ?? d.environment,
  };
}

/** Migrate a full VideoStudioConfig from old format */
export function migrateVideoStudioConfig(config: VideoStudioConfig): VideoStudioConfig {
  const migrated = { ...config };
  // Templates saved before the corner fillet was configurable get the defaults, which
  // reproduce the old hardcoded behaviour (enabled, 0.8 radius) but now follow the wall.
  migrated.cornerFill = { ...DEFAULT_CORNER_FILL, ...config.cornerFill };
  // Templates predating the configurable void colour / logo plate get the defaults,
  // which reproduce the previous behaviour exactly (#1a1a1a void, no logo plate).
  migrated.sceneBackground = { ...DEFAULT_SCENE_BACKGROUND, ...config.sceneBackground };
  migrated.logoBackdrop = { ...DEFAULT_LOGO_BACKDROP, ...config.logoBackdrop };
  // V2 templates saved before a field was added get the missing defaults backfilled.
  if (migrated.environment) {
    migrated.environment = normalizeEnvironmentConfig(migrated.environment);
  }
  migrated.wallSurface = migrateSurfaceConfig(
    config.wallSurface,
    DEFAULT_WALL_SURFACE.texturePreset,
    DEFAULT_WALL_SURFACE.envMapIntensity
  );
  migrated.tableSurface = migrateSurfaceConfig(
    config.tableSurface,
    DEFAULT_TABLE_SURFACE.texturePreset,
    DEFAULT_TABLE_SURFACE.envMapIntensity
  );
  // Migrate HDRI layers to include new intensity/enabled fields
  if (migrated.hdriConfig?.layers) {
    migrated.hdriConfig = {
      layers: migrated.hdriConfig.layers.map(l => ({
        ...l,
        intensity: l.intensity ?? 1.0,
        enabled: l.enabled ?? true,
      })),
    };
  }
  // Migrate old configs without cueHdri
  if (!migrated.cueHdri) {
    migrated.cueHdri = { ...DEFAULT_CUE_HDRI };
  }
  // Templates saved before custom camera paths existed have no cameraPath — default to
  // the legacy straight line so their recordings are unchanged.
  if (!migrated.cameraPath) {
    migrated.cameraPath = { ...DEFAULT_CAMERA_PATH, waypoints: [] };
  } else {
    const wps = migrated.cameraPath.waypoints?.map(w => ({ ...w })) ?? [];
    migrated.cameraPath = {
      ...DEFAULT_CAMERA_PATH,
      ...migrated.cameraPath,
      shapeParams: { ...DEFAULT_CAMERA_SHAPE_PARAMS, ...migrated.cameraPath.shapeParams },
      waypoints: wps,
      // Templates from the first path implementation have no start/end indices; default to
      // the full span so their recorded move is unchanged.
      startIndex: migrated.cameraPath.startIndex ?? 0,
      endIndex: migrated.cameraPath.endIndex ?? Math.max(0, wps.length - 1),
      // That implementation had no `enabled` flag — infer it from whether waypoints exist.
      enabled: migrated.cameraPath.enabled ?? wps.length >= 2,
      // Retired look modes ("interpolate" / "path") collapse onto "level".
      lookMode: normalizeLookMode(migrated.cameraPath.lookMode),
    };
  }
  // Migrate old "hd" quality to "2k"
  if ((migrated.quality as string) === "hd") {
    migrated.quality = "2k";
  }
  return migrated;
}
