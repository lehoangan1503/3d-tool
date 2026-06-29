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

// Tunables for the "subtle sparkle" look. Kept conservative so the artwork
// underneath stays clearly readable, but strong enough to be obviously visible
// when toggled.
const FLAKE_TEXTURE_SIZE = 1024; // tile resolution
// The body surface UV is a tall cylinder unwrap (recommended art is 1141×8359 ≈
// 1:7.3 W:H). Tiling a SQUARE flake tile equally in U and V would stretch the
// flecks ~7× vertically. So we repeat far more along V than U to keep flakes
// round and evenly covering the full width & height.
const FLAKE_TILES_U = 8; // repeats across the (narrow) circumference
const FLAKE_TILES_V = 58; // repeats along the (tall) length — ~8 × 7.3 aspect
/** With a metalnessMap present, metalness acts as the max — keep it full so the map drives the pattern. */
export const SILVER_METALNESS = 1.0;
/** Base metalness floor (non-grain). High so the body is a silver substrate and
 * its reflection is tinted by the artwork — light ink → bright silver, dark ink
 * → dark colour. This is the "shows through" without bleaching the print. */
export const SILVER_BASE_METALNESS_FLOOR = 0.7;
/** Base roughness (non-grain) when coating is on — glossy silver substrate. */
export const SILVER_BASE_ROUGHNESS = 0.32;
/** envMapIntensity bump so the metallic sheen reads strongly under the HDRI. */
export const SILVER_ENV_MAP_INTENSITY = 2.6;
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

  // Scatter grain. Very high density + fine size for a tight metallic texture.
  // Each grain gets ONE random "intensity" and all maps are driven from it so a
  // bright/metallic grain is also the glossiest one — a real flake catching light.
  const flakeCount = Math.round((size * size) / 2.2);
  for (let i = 0; i < flakeCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1.0 + rand() * 2.0; // ~1.0–3.0px grains (larger)
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
  // Anisotropic repeat keeps flakes round on the stretched cylinder UV and
  // covers the full width & height of the surface.
  tex.repeat.set(FLAKE_TILES_U, FLAKE_TILES_V);
  tex.colorSpace = THREE.NoColorSpace; // data textures, not color
  tex.needsUpdate = true;
  return tex;
}

/**
 * Get (and lazily create) the shared silver-flake texture maps.
 * Returns cached textures — callers must NOT dispose them.
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
