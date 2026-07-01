import * as THREE from "three";

/**
 * SILVER COATING ("Phủ bạc") MODULE
 *
 * The Pro cue line is printed on a silver metallic-flake blank (phôi phủ bạc):
 * the ink is printed ON TOP of a silver substrate, so the artwork keeps its
 * full colour and the silver shimmers THROUGH the light/unprinted areas. The
 * silver is BEHIND the print, never a wash over it.
 *
 * This is a *material* effect, not a 2D overlay — it lives in the PBR material
 * so it follows the cylinder's curvature/rotation and shows up in the
 * image/video extractors (which render their own offscreen WebGL canvas).
 *
 * Model: the artwork stays as the material `map` (untouched, full colour). We
 * turn the body into a flaked METAL so its reflection is tinted by the artwork:
 *  - metalnessMap: dense flake grain — the surface behaves as silver metal.
 *    Dark/saturated ink reflects as dark colour; light/white ink reflects bright
 *    silver → the silver "shows through" exactly where a real print is light.
 *  - roughnessMap: glossy grains in a slightly rougher field → fine sparkle.
 *  - normalMap: tiny facets so each grain catches the HDRI differently (twinkle).
 *  No emissive — emissive ADDS light on top of the ink and washes the artwork
 *  out (the "in front" look we want to avoid).
 *
 * The maps are generated once and cached (module-level) since they're identical
 * for every cue and reused by both the live preview and the extractors.
 */

export interface SilverCoatingMaps {
  metalnessMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

/**
 * User-tunable grain controls for the silver flake ("Phủ bạc") pattern.
 * A single global setting shared by every product — users adjust it until the
 * sparkle looks right and all cues reuse the same look.
 *  - `density`: 0–100 slider. 50 reproduces the original hardcoded flake count.
 *    Lower = sparser/subtler grain, higher = denser grain.
 *  - `size`: 0–100 slider. 50 reproduces the original ~1–3px grain radius.
 *    Lower = finer flecks, higher = coarser/larger flakes.
 */
export interface SilverGrainParams {
  /**
   * 0..100 — silver-frost COVERAGE. How strongly the frosted-silver surface
   * covers/dims the artwork. 0 = artwork with a light silver sheen; 100 = ~96%
   * frosted silver like the real "phủ bạc" blank. The fine tooth micro-texture
   * is fixed; this slider only changes the coverage blend (cheap per-material).
   */
  density: number;
}

/** Default coverage. Frost brightness/look is controlled by the live tuning
 * panel (see SilverTuning), not here. */
export const DEFAULT_SILVER_GRAIN: SilverGrainParams = {
  density: 80,
};

// The frost TOOTH tile (fine matte speckle) is generated ONCE at a fixed
// resolution + fixed speckle count, so it's cheap and never regenerates. The
// coverage slider does NOT touch this tile — it only blends each material toward
// silver frost (see densityToCoverage), which is what hides the artwork.
const FLAKE_TEXTURE_SIZE = 1024; // tooth tile resolution (fixed — fast to build once)
// The body surface UV is a tall cylinder unwrap (recommended art is 1141×8359 ≈
// 1:7.3 W:H). The tooth tile is repeated far more along V than U (see
// FROST_TILES_*) to keep the speckle round & even across the stretched cylinder.
/** With a metalnessMap present, metalness acts as the max — keep it full so the map drives the pattern. */
export const SILVER_METALNESS = 1.0;
/** Base metalness floor (non-grain). High so the body is a silver substrate and
 * its reflection is tinted by the artwork — light ink → bright silver, dark ink
 * → dark colour. This is the "shows through" without bleaching the print. */
export const SILVER_BASE_METALNESS_FLOOR = 0.7;
/** Base roughness (non-grain) when coating is on — glossy silver substrate. */
export const SILVER_BASE_ROUGHNESS = 0.32;
/** envMapIntensity bump so the metallic sheen reads strongly under the HDRI.
 * With metalness=1 the surface has NO diffuse — its ONLY brightness comes from
 * reflecting the environment, so this is the main lever for making the silver
 * LIGHTER. Pushed high so the frost reads bright even against a dark background
 * (the HDRI it reflects is a bright daytime scene). */
export const SILVER_ENV_MAP_INTENSITY = 9.0;
/** Normal map strength — small, so grains glint without distorting the print. */
export const SILVER_NORMAL_SCALE = 0.4;
/** Clearcoat: a clear reflective top layer whose specular highlight is WHITE
 * (independent of the artwork colour). This is what produces the bright rolling
 * "glare/glow" band of real glossy silver, without washing out the print. */
export const SILVER_CLEARCOAT = 1.0;
/** Clearcoat roughness — low = a tight, bright glare; higher = a softer glow. */
export const SILVER_CLEARCOAT_ROUGHNESS = 0.12;
/** Specular intensity bump — strengthens the white specular reflection. */
export const SILVER_SPECULAR_INTENSITY = 1.0;

/**
 * Fixed speckle COUNT for the one tooth tile we build. Dense so the frost reads
 * as a fine uniform tooth (like fine sandpaper) rather than discrete dots — but
 * cheap since it's a single 1024² build, once.
 */
const FIXED_FLAKE_COUNT = 260_000;
/** Fine tooth radius range: ~0.6–1.8px, so the frost is a tight micro-texture. */
const BASE_GRAIN_MIN = 0.6;
const BASE_GRAIN_SPAN = 1.2;

/** Tooth grain is FINE and fixed — no per-flake size scaling for the frost look. */
const SIZE_MULTIPLIER = 1.0;

/** Density slider range: 0–100. Here "density" = COVERAGE: how much the silver
 * frost covers/dims the artwork. 0 = artwork with light sheen (old look),
 * 100 = ~96% frosted silver like the real cue. */
export const SILVER_GRAIN_DENSITY_MAX = 100;

/** Frosted-silver target look at full coverage. A bright silver with a fine
 * matte tooth — matches the real "phủ bạc" blank.
 *
 * NOTE ON BRIGHTNESS: metalness is kept only PARTIAL (not 1.0). A fully metallic
 * surface has NO diffuse colour — it can only show what it reflects, so under a
 * dark background/HDRI it reads near-black (that was the "too dark" problem).
 * Keeping metalness ~0.5 preserves a bright diffuse silver that the scene lights
 * directly, so the frost stays light while still looking metallic. */
export const SILVER_FROST_COLOR = 0xffffff; // white silver tint (locked-in default)
export const SILVER_FROST_METALNESS = 1; // full metal (locked-in default)
export const SILVER_FROST_ROUGHNESS = 1; // locked-in default
/** Cap coverage so a sliver of artwork can still faintly read at max (like the
 * ~96% in the reference — never a 100% featureless sheet). */
export const SILVER_MAX_COVERAGE = 0.96;
/** Emissive silver fill added at full coverage. A metal reflecting a dark
 * artwork/background reads dark; this adds a small constant brightness floor so
 * the dark stained-glass areas can't drag the frost to black. Scaled by coverage
 * so it only kicks in with the frost. Keep low — too high washes the sparkle. */
export const SILVER_FROST_EMISSIVE = 0x2a2a2c; // subtle grey lift
export const SILVER_FROST_EMISSIVE_INTENSITY = 0.6;

/**
 * LIVE-TUNABLE frost material values. Seeded from the constants above; the
 * editor's tuning panel mutates these via setSilverTuning() and the material
 * apply reads them, so every value can be dragged and seen instantly. Once the
 * look is dialled in, bake the chosen numbers back into the constants as the
 * permanent defaults.
 *
 * DEFAULT AIM: natural + lighter. Emissive OFF (0) — the natural look; lightness
 * comes from reflecting more environment (envMapIntensity) at a slightly lower
 * roughness, which reads like real frosted metal rather than a flat glow.
 */
export interface SilverTuning {
  metalness: number; // 0..1
  roughness: number; // 0..1
  envMapIntensity: number; // 0..15
  clearcoat: number; // 0..1
  clearcoatRoughness: number; // 0..1
  normalScale: number; // 0..2
  color: number; // hex silver tint
  emissive: number; // hex emissive lift colour
  emissiveIntensity: number; // 0..3 (0 = natural, no glow)
}

// LOCKED-IN defaults (the look the user approved). Metalness/normalScale are
// the only two the user can still change live (plus coverage); the rest are fixed.
const silverTuning: SilverTuning = {
  metalness: 1.0,
  roughness: 1.0,
  envMapIntensity: 6.7,
  clearcoat: 1.0,
  clearcoatRoughness: 0.0,
  normalScale: 0.5,
  color: 0xffffff,
  emissive: SILVER_FROST_EMISSIVE,
  emissiveIntensity: 0.0,
};

export function getSilverTuning(): SilverTuning {
  return { ...silverTuning };
}

export function setSilverTuning(patch: Partial<SilverTuning>): void {
  Object.assign(silverTuning, patch);
}

/**
 * The ONLY user-editable, DB-persisted silver settings — a single GLOBAL config
 * shared by every product. Everything else in SilverTuning is hard-coded above.
 *  - density: 0–100 "Độ phủ bạc" coverage
 *  - metalness: 0–1
 *  - normalScale: 0–2 "Độ sâu hạt"
 */
export interface SilverGlobalConfig {
  density: number;
  metalness: number;
  normalScale: number;
}

/** Global defaults = the approved look from the reference screenshot. */
export const DEFAULT_SILVER_GLOBAL: SilverGlobalConfig = {
  density: 90,
  metalness: 1.0,
  normalScale: 0.5,
};

/**
 * Map a 0–100 density slider to a COVERAGE fraction (0..SILVER_MAX_COVERAGE).
 * Linear; 100 → 0.96. This is the blend amount from the base material toward the
 * frosted-silver target — cheap per-material lerp, no texture work.
 */
export function densityToCoverage(v: number): number {
  const clamped = Math.max(0, Math.min(SILVER_GRAIN_DENSITY_MAX, v));
  return (clamped / SILVER_GRAIN_DENSITY_MAX) * SILVER_MAX_COVERAGE;
}

/** Fixed tile repeat for the fine tooth (frost micro-texture). Kept high so the
 * speckle is fine/dense regardless of coverage — decoupled from the slider. */
const FROST_TILES_U = 16;
const FROST_TILES_V = 116;

// The flake tile is built ONCE (size is fixed) and cached. Density does not
// affect the canvas, only the repeat count, so a single cache entry suffices.
let cachedMaps: SilverCoatingMaps | null = null;

/**
 * Deterministic pseudo-random so the flake pattern is identical every run
 * (Math.random is unavailable in some sandboxes and we want stable output).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildFlakeCanvases(): {
  metalness: HTMLCanvasElement;
  roughness: HTMLCanvasElement;
  normal: HTMLCanvasElement;
} {
  const size = FLAKE_TEXTURE_SIZE;
  const rand = mulberry32(0x5b1f);
  const sizeMul = SIZE_MULTIPLIER;

  // --- Metalness map ---
  // High metallic base so the body is a silver substrate; denser grain makes it
  // flaked. The reflection is tinted by the artwork `map`, so light ink → bright
  // silver and dark ink → dark colour (silver shows through, no wash-out).
  const metalCanvas = document.createElement("canvas");
  metalCanvas.width = size;
  metalCanvas.height = size;
  const mctx = metalCanvas.getContext("2d")!;
  const baseMetal = Math.round(SILVER_BASE_METALNESS_FLOOR * 255);
  mctx.fillStyle = `rgb(${baseMetal},${baseMetal},${baseMetal})`;
  mctx.fillRect(0, 0, size, size);

  // --- Roughness map ---
  // Rough base, glossy flakes → tight bright highlights = the sparkle.
  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = size;
  roughCanvas.height = size;
  const rctx = roughCanvas.getContext("2d")!;
  const baseRough = Math.round(SILVER_BASE_ROUGHNESS * 255);
  rctx.fillStyle = `rgb(${baseRough},${baseRough},${baseRough})`;
  rctx.fillRect(0, 0, size, size);

  // --- Normal map ---
  // Neutral base (128,128,255 = flat), per-flake facets perturb the normal.
  const normalCanvas = document.createElement("canvas");
  normalCanvas.width = size;
  normalCanvas.height = size;
  const nctx = normalCanvas.getContext("2d")!;
  nctx.fillStyle = "rgb(128,128,255)";
  nctx.fillRect(0, 0, size, size);

  // Scatter grain. Fixed count + fixed size for a tight metallic tile that we
  // build only once. Each grain gets ONE random "intensity" and all maps are
  // driven from it so a bright/metallic grain is also the glossiest one — a real
  // flake catching light. Visual density is added later by tiling, not here.
  const flakeCount = FIXED_FLAKE_COUNT;
  for (let i = 0; i < flakeCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = (BASE_GRAIN_MIN + rand() * BASE_GRAIN_SPAN) * sizeMul; // ~2.5–7.5px at size 125
    const intensity = Math.sqrt(rand()); // 0..1, skewed toward bright/metallic

    // Metal grain — strongly metallic, brighter grains fully metal.
    const metalV = Math.round(190 + intensity * 65); // 190–255
    mctx.fillStyle = `rgb(${metalV},${metalV},${metalV})`;
    mctx.beginPath();
    mctx.arc(x, y, r, 0, Math.PI * 2);
    mctx.fill();

    // Brighter grains are glossier (lower roughness) → tighter, brighter glint.
    const roughV = Math.round(85 - intensity * 65); // 0.08–0.33 roughness
    rctx.fillStyle = `rgb(${roughV},${roughV},${roughV})`;
    rctx.beginPath();
    rctx.arc(x, y, r, 0, Math.PI * 2);
    rctx.fill();

    // Tilt the normal so each grain catches light from a different angle.
    const nx = 128 + Math.floor((rand() - 0.5) * 230);
    const ny = 128 + Math.floor((rand() - 0.5) * 230);
    nctx.fillStyle = `rgb(${nx},${ny},255)`;
    nctx.beginPath();
    nctx.arc(x, y, r, 0, Math.PI * 2);
    nctx.fill();
  }

  return { metalness: metalCanvas, roughness: roughCanvas, normal: normalCanvas };
}

function makeTiledTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Fixed dense anisotropic repeat → a fine, uniform matte tooth across the whole
  // surface (the frost micro-texture). Independent of the coverage slider.
  tex.repeat.set(FROST_TILES_U, FROST_TILES_V);
  tex.colorSpace = THREE.NoColorSpace; // data textures, not color
  tex.needsUpdate = true;
  return tex;
}

/**
 * Get (and lazily create) the shared silver-frost tooth maps. Built ONCE, then
 * reused by the live preview and the extractors — callers must NOT dispose them.
 * Coverage (how much the frost hides the artwork) is applied separately per
 * material via densityToCoverage(), so these maps never change.
 */
export function getSilverCoatingMaps(): SilverCoatingMaps {
  if (cachedMaps) return cachedMaps;

  const { metalness, roughness, normal } = buildFlakeCanvases();
  cachedMaps = {
    metalnessMap: makeTiledTexture(metalness),
    roughnessMap: makeTiledTexture(roughness),
    normalMap: makeTiledTexture(normal),
  };
  return cachedMaps;
}
