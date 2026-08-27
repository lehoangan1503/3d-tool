/**
 * Video Studio — the giant camera-locked logo plate drawn behind the cue.
 *
 * The plate must stay perfectly still while the studio camera orbits, dollies and
 * spirals, so it is deliberately NOT a plane placed in the world: a world plane would
 * slide and foreshorten with every camera move. Instead this module owns a tiny second
 * scene with its own orthographic camera spanning exactly [-0.5, 0.5] on both axes, and
 * the studio renders it as a pre-pass. Because that camera never moves, the plate is
 * locked to the frame by construction — no per-frame tracking maths, and the recorded
 * video behaves identically to the live preview.
 *
 * Draw order in the studio is:
 *   1. clear to the scene background colour
 *   2. this logo pass (depth writes off)
 *   3. the main scene WITHOUT its own clear, so the cue lands on top of the plate
 *
 * The blur, the flat fill and the neon glow all happen in one fragment shader over the
 * logo's alpha channel. The neon recipe mirrors the CSS text-shadow stack — a bright,
 * nearly-white core wrapped in progressively wider coloured halos — which is why the
 * core colour and the halo colour are two separate uniforms.
 */

import * as THREE from "three";
import type { LogoBackdropConfig, LogoBackdropAnchor } from "@/types/video-studio";
import { cueLogoPath } from "@/types/product";

/**
 * Taps per separable pass.
 *
 * Because the passes are separable the cost is 2*TAPS samples, not TAPS^2, so this can be
 * high enough to sample the widest radius densely. The earlier single-pass 2D kernel used
 * 9 and banded visibly (a ~60px sigma left ~15px gaps between samples, which read as a
 * plaid grid); combined with BLUR_DOWNSCALE this leaves no perceptible gaps.
 */
/**
 * Resolve which image the plate should draw.
 *
 * A custom upload wins outright. Otherwise "auto" follows the cue's own engraved logo
 * (so the plate matches the product without the user picking anything), and any other
 * value is an explicit catalog id.
 */
export function resolveLogoBackdropUrl(
  config: LogoBackdropConfig | undefined | null,
  productLogoId: string | undefined | null
): string | null {
  if (!config?.enabled) return null;
  if (config.customUrl) return config.customUrl;
  return cueLogoPath(config.logoId === "auto" ? productLogoId : config.logoId);
}

const BLUR_TAPS = 25;

/**
 * Maximum blur radius, as a fraction of the plate's own height.
 *
 * The blur runs in the plate's UV space, so this is what `config.blur = 1` means. Beyond
 * about a quarter of the mark's height the logo stops being readable as a logo, so the
 * slider's full travel is mapped onto that useful range rather than onto "infinite mush".
 */
const MAX_BLUR_UV = 0.22;

/**
 * Longest side the alpha plate is rasterised at.
 *
 * This was 1024 on the assumption that the plate is always heavily blurred. It is not: at
 * blur = 0 the mark is drawn at its own edges, and 1024 was measured against the SOURCE
 * file — after cropping to the mark and adding glow padding, a wordmark's letters ended up
 * only a few hundred pixels tall and stair-stepped visibly across a 34-unit wall.
 *
 * 4096 resolves typical logo artwork essentially pixel-for-pixel. The extra cost is one
 * getImageData readback plus the alpha-extraction loop below — measured at ~83 ms for a
 * full 4096x4096 plate, paid ONCE when a logo loads, never per frame. The blur path
 * immediately downsamples anyway (see BLUR_DOWNSCALE), so a blurred plate pays nothing
 * beyond that. Raising this further would start to be felt on load.
 */
const MAX_PLATE_SIZE = 4096;

/**
 * Factor by which the plate is downsampled before blurring.
 *
 * Blurring at reduced resolution is what lets a modest tap count cover a wide radius
 * smoothly: the hardware's bilinear filter averages the pixels that fall between taps,
 * so there are no unsampled gaps to show up as banding. The plate is heavily blurred
 * anyway, so the lost detail is detail the blur would have destroyed.
 */
const BLUR_DOWNSCALE = 3;

/**
 * Blur radius (in the config's 0-1 units) below which the composite samples the plate
 * directly instead of a blurred render target.
 *
 * The blur targets are 1/BLUR_DOWNSCALE resolution, which is invisible on a soft glow but
 * is exactly what made a crisp logo look jagged: a sharp mark was being routed through a
 * third-resolution buffer for no reason. Under this threshold there is no blur worth
 * running, so the full-resolution plate goes straight to the composite.
 */
const SHARP_BLUR_EPSILON = 0.004;

/**
 * The V1 back wall: a 34 x 24 plane centred at (0, 10, -5.5).
 *
 * The wall-anchored plate is sized and placed against these numbers so `scale = 1` means
 * "as wide as the wall", which is the intuitive meaning of the size slider when the logo
 * is set dressing rather than a screen overlay.
 */
const WALL_WIDTH = 34;
const WALL_HEIGHT = 24;
const WALL_Y = 10;
const WALL_Z = -5.5;

/**
 * How far in front of the wall the plate sits.
 *
 * Small enough to read as painted onto the wall, large enough to clear the wall's
 * displacement-mapped surface (the wall is subdivided 64x64 and can push toward the
 * camera) so the two never z-fight.
 */
const WALL_OFFSET_Z = 0.06;

/**
 * Transparent-queue position for the wall-anchored plate.
 *
 * Wall background frames sit at renderOrder 0 (four of them, stacked 0.01 apart in z), so
 * anything above 0 draws after all of them. The logo is also parked further forward in z
 * (WALL_OFFSET_Z = 0.06 vs the frames' 0.01-0.04), so this ordering agrees with the actual
 * geometry rather than fighting it.
 */
const LOGO_WALL_RENDER_ORDER = 10;

/** The four near-plane corners in NDC, used to trace the frustum edges onto the wall. */
const NDC_CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** Scratch vectors for the per-frame frustum trace — this runs every frame while recording. */
const FRUSTUM_EYE = new THREE.Vector3();
const FRUSTUM_CORNER = new THREE.Vector3();

/**
 * Transparent margin added around the cropped mark when the plate is rasterised.
 *
 * The blur and especially the neon glow spread outward past the mark's edges. Without
 * headroom the glow gets clipped flat against the texture border, which reads as a
 * rectangle of light rather than a halo. 40% of the mark's size clears the widest glow.
 */
const GLOW_PADDING = 0.4;

/** Smallest neon halo reach, so even at glow size 0 there is a visible tube glow. */
const NEON_GLOW_MIN_UV = 0.012;

/** How much further the halo reaches at glow size 1. */
const NEON_GLOW_RANGE_UV = 0.20;

/**
 * Flicker timing, in RADIANS PER SECOND (these multiply raw seconds inside a sin()).
 *
 * Tuned so one full beat between the two detuned waves takes roughly 3-5 seconds: the tube
 * drifts and stutters slowly rather than buzzing. The earlier values were ~7 and ~12 rad/s
 * — over a cycle per second — which read as a strobe instead of an ageing sign.
 *
 * The pair is deliberately not a simple ratio, so the combined waveform does not visibly
 * repeat on a short period.
 */
const FLICKER_HZ_A = 1.62;
const FLICKER_HZ_B = 2.35;

/** Rate of the sparse deeper dropout — one dip every ~4 seconds. */
const FLICKER_DIP_HZ = 0.42;

/** Result of turning a logo image into a premultiplied-alpha plate. */
interface LogoAlphaPlate {
  canvas: HTMLCanvasElement;
  /** Aspect (width / height) of the CROPPED mark, not of the source file. */
  aspect: number;
}

/**
 * Build a white-on-transparent plate from a logo image.
 *
 * Most of the logo catalog ships as JPEG (`novera.jpg`, `procue.jpg`, …), which has no
 * alpha channel at all — every pixel reads a = 1. The shader keys entirely off alpha, so
 * feeding a JPEG in directly produces one opaque rectangle instead of a logo. The cue's
 * own laser-engraving path solves this the same way (see `prepareLogoSource` in
 * leather-material.ts): sample the four corners to learn the paper colour, then derive
 * alpha from how far each pixel departs from it.
 *
 * This version differs from the cue's in one deliberate way: it crops to the mark and
 * keeps the mark's TRUE aspect ratio, instead of fitting it into a 1024 square. The plate
 * is supposed to fill the camera frame edge-to-edge, and a square-padded texture would
 * letterbox the logo inside its own quad and make `scale = 1` stop meaning "full frame".
 *
 * A PNG that already has real transparency is used as-is — re-deriving alpha from
 * luminance would throw away the authored matte and knock out any white in the artwork.
 */
function buildLogoAlphaPlate(image: HTMLImageElement): LogoAlphaPlate | null {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) return null;

  // Work at a bounded resolution: the plate is heavily blurred, so sampling the full
  // 3940px UNI artwork would cost a large readback for detail the blur discards anyway.
  const scale = Math.min(1, MAX_PLATE_SIZE / Math.max(naturalWidth, naturalHeight));
  const w = Math.max(1, Math.round(naturalWidth * scale));
  const h = Math.max(1, Math.round(naturalHeight * scale));

  const source = document.createElement("canvas");
  source.width = w;
  source.height = h;
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, w, h);

  let pixels: ImageData;
  try {
    pixels = ctx.getImageData(0, 0, w, h);
  } catch {
    // A cross-origin image without CORS headers taints the canvas. Nothing to recover.
    return null;
  }
  const data = pixels.data;

  // Does the source already carry a real matte? Anything meaningfully transparent means
  // the artwork is an authored cutout and must be trusted as-is.
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) { hasAlpha = true; break; }
  }

  const corners = [
    0,
    (w - 1) * 4,
    (h - 1) * w * 4,
    (w * h - 1) * 4,
  ];
  const background = corners.reduce(
    (sum, i) => sum + (data[i] + data[i + 1] + data[i + 2]) / 3,
    0
  ) / corners.length;

  // Crop bounds of the actual mark, so the plate is the logo and not the paper around it.
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let alpha: number;
      if (hasAlpha) {
        alpha = data[i + 3];
      } else {
        const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
        // The same 96-level ramp the cue engraving uses: far enough from the paper to
        // ignore JPEG ringing, soft enough to keep anti-aliased edges smooth.
        alpha = Math.round(Math.min(1, Math.abs(luminance - background) / 96) * 255);
      }
      // The shader colours the mark itself, so the RGB here is irrelevant — but it must
      // be white, or the (unused) colour would still bleed through the linear filter at
      // partially transparent edges and darken the halo.
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = alpha;
      if (alpha > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // A blank image (or one whose "logo" is the same colour as its background) has no mark
  // to show; drawing an empty plate would be worse than drawing nothing.
  if (maxX < minX || maxY < minY) return null;

  ctx.putImageData(pixels, 0, 0);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  // Re-draw the crop into a canvas with transparent padding around it. The blur and the
  // neon halo spread outward past the mark, and without room to spread they would be
  // clipped square against the texture border — a glowing rectangle instead of a halo.
  const padX = Math.round(cropW * GLOW_PADDING);
  const padY = Math.round(cropH * GLOW_PADDING);
  const out = document.createElement("canvas");
  out.width = cropW + padX * 2;
  out.height = cropH + padY * 2;
  const outCtx = out.getContext("2d");
  if (!outCtx) return null;
  outCtx.drawImage(source, minX, minY, cropW, cropH, padX, padY, cropW, cropH);

  return { canvas: out, aspect: out.width / out.height };
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Single-pass fragment shader.
 *
 * Sampling is done on a 2D grid rather than as two separable passes: at 9 taps that is
 * 81 samples, which a modern GPU absorbs easily for one full-screen quad, and it avoids
 * allocating and resizing a ping-pong render target on every config change.
 */
/**
 * Separable Gaussian pass, run twice (horizontal then vertical).
 *
 * A single-pass 2D kernel was the previous approach and it banded badly: covering a
 * 60+ pixel sigma with 9x9 taps leaves ~15px gaps between samples, which shows up as the
 * plaid/grid pattern. Two separable passes give the same result as an NxN kernel for N
 * taps of cost instead of N*N, so the tap count can be high enough to sample densely.
 *
 * Sampling is also done from a pre-downsampled copy of the plate (see BLUR_DOWNSCALE),
 * which multiplies the effective reach of every tap: the hardware's bilinear filter
 * averages the pixels between taps instead of leaving them unsampled.
 */
const BLUR_FRAG = /* glsl */ `
uniform sampler2D uSource;
// Step between taps, in UV. Only one component is non-zero per pass, which is what
// makes the pass separable.
uniform vec2 uStep;
uniform float uSigma;
varying vec2 vUv;

// Everything outside the plate is transparent. With ClampToEdgeWrapping a sample past
// the border would return the nearest edge pixel instead, and a wide kernel would drag
// that border row across the whole quad as streaks -- the original smearing bug.
vec4 tapSample(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uSource, uv);
}

void main() {
  if (uSigma <= 0.0001) {
    gl_FragColor = tapSample(vUv);
    return;
  }
  const int TAPS = ${BLUR_TAPS};
  const float HALF = float(TAPS - 1) * 0.5;
  float total = 0.0;
  float weightSum = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float offset = (float(i) - HALF) / HALF;
    float w = exp(-(offset * offset) / 0.5);
    total += tapSample(vUv + uStep * offset).a * w;
    weightSum += w;
  }
  gl_FragColor = vec4(1.0, 1.0, 1.0, total / max(weightSum, 0.0001));
}
`;

/**
 * Final composite. Reads the already-blurred alpha (and, for neon, a second, wider blur)
 * and turns it into colour. All the expensive sampling has happened by this point, so
 * this shader is a handful of instructions per pixel.
 */
const FRAG = /* glsl */ `
uniform sampler2D uBlurred;   // the mark, blurred at the chosen radius (or the raw plate)
uniform sampler2D uGlow;      // the mark, blurred much wider (neon halo)
uniform vec3  uColor;
uniform vec3  uNeonColor;
uniform float uNeonIntensity;
uniform float uNeonCoreWidth;
uniform float uNeonCoreGlow;
uniform float uNeonBloom;
uniform float uFlicker;       // per-frame brightness multiplier, 1.0 = steady
uniform float uOpacity;
uniform float uNeon;
varying vec2 vUv;

void main() {
  float base = texture2D(uBlurred, vUv).a;

  // -- Solid style --
  vec3 rgb = uColor;
  float alpha = base;

  // -- Neon style --
  //
  // Real neon is not "a coloured blur of the mark". It is a very bright, nearly white
  // filament inside a coloured tube, wrapped in a tight coloured glow, wrapped again in a
  // wide dim bloom thrown onto the surface behind it. The previous version had only the
  // first and third of those and mixed toward the core colour, which is why it read as a
  // soft shadow rather than a lit sign.
  //
  // Layers below, tube outward:
  //   filament — the hot centre, near-white, driven by uNeonCoreGlow
  //   tube     — the coloured stroke itself, its thickness set by uNeonCoreWidth
  //   halo     — tight coloured glow hugging the tube
  //   bloom    — wide, dim spill on the wall
  //
  // Colour is ADDED rather than mixed, so overlapping layers get brighter instead of
  // averaging toward grey. That additive build-up is what makes it read as light.
  if (uNeon > 0.5) {
    float wide = texture2D(uGlow, vUv).a;

    // Tube: a narrower core edge means a thin filament and more visible glow.
    float coreLo = mix(0.62, 0.10, uNeonCoreWidth);
    float coreHi = mix(0.92, 0.42, uNeonCoreWidth);
    float tube = smoothstep(coreLo, coreHi, base);

    // Filament: the hottest slice at the very centre of the stroke.
    float filament = smoothstep(coreHi, min(coreHi + 0.28, 1.0), base) * uNeonCoreGlow;

    // Halo: tight glow hugging the tube. Squared, not cubed — cubing pulled it so far in
    // that it disappeared into the stroke and the brightness slider had nothing to act on.
    float halo = wide * wide;

    // Bloom: the wide, dim spill on the wall. pow(0.6) reaches much further out than the
    // halo, and the control scales it LINEARLY here (it used to be applied twice, once
    // here and again in alpha, which made it quadratic and invisible below about 0.7).
    float bloom = pow(max(wide, 0.0), 0.6) * uNeonBloom;

    // Brightness spans a wide range so the slider is felt across its whole travel. The
    // previous 0.55..2.0 range saturated the tube almost immediately, which is why moving
    // it appeared to do nothing.
    float intensity = 0.15 + 2.85 * uNeonIntensity;

    // Additive light build-up. The tube carries the neon colour; the filament pushes the
    // centre toward white the way an overexposed tube does on camera.
    //
    // Every layer is scaled by intensity — including the tube. Leaving the tube at a fixed
    // brightness is what made the control look dead: the stroke dominates the image, so a
    // constant stroke reads as a constant logo no matter what the glow does.
    // The tube's own colour runs from the pure gas colour to near-white as uNeonCoreGlow
    // rises. Adding white light alone could not express this: once the stroke saturates,
    // more light cannot change its hue, so the control looked dead at any usable
    // brightness. Shifting the colour is what actually reads as a hotter tube.
    vec3 tubeColor = mix(uNeonColor, mix(uNeonColor, vec3(1.0), 0.9), uNeonCoreGlow * tube);
    vec3 light = tubeColor * tube * 0.85 * intensity;
    light += uNeonColor * (halo * 1.30 + bloom * 0.90) * intensity;
    light += mix(uNeonColor, vec3(1.0), 0.85) * filament * 1.5 * intensity;
    // uColor still tints the tube itself, so the core colour control keeps meaning something.
    light *= mix(vec3(1.0), uColor, 0.35);
    light *= uFlicker;

    // Tone-map so a hot core saturates to white instead of clipping to a flat block of
    // colour — the same reason a real neon photo blows out at the tube. Applied gently
    // (0.85) so the curve does not swallow the intensity range it is meant to shape.
    rgb = vec3(1.0) - exp(-light * 0.85);

    // Additive blending ignores alpha for colour, so the light above IS the output. Alpha
    // is carried only so the discard below can skip empty pixels; deriving it from the
    // light's own luminance keeps a bright glow from being culled.
    alpha = clamp(max(rgb.r, max(rgb.g, rgb.b)), 0.0, 1.0);

    if (alpha <= 0.002) discard;
    // Source factor is ONE under AdditiveBlending: emit the light directly. It must NOT be
    // premultiplied by alpha — doing so squared the falloff and crushed the outer glow and
    // bloom to nothing, which is why those two controls appeared to do nothing at all.
    gl_FragColor = vec4(rgb * uOpacity, alpha * uOpacity);
    return;
  }

  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(rgb, alpha * uOpacity);
}
`;

/** Uniforms of the final composite pass. */
interface CompositeUniforms {
  uBlurred: { value: THREE.Texture | null };
  uGlow: { value: THREE.Texture | null };
  uColor: { value: THREE.Color };
  uNeonColor: { value: THREE.Color };
  uNeonIntensity: { value: number };
  uNeonCoreWidth: { value: number };
  uNeonCoreGlow: { value: number };
  uNeonBloom: { value: number };
  uFlicker: { value: number };
  uOpacity: { value: number };
  uNeon: { value: number };
}

/** Uniforms of one separable blur pass. */
interface BlurUniforms {
  uSource: { value: THREE.Texture | null };
  uStep: { value: THREE.Vector2 };
  uSigma: { value: number };
}

/**
 * Owns the camera-locked logo plate for one studio. Lifetime matches the scene manager's.
 *
 * `setConfig` is cheap and idempotent, so the studio calls it on every config change; the
 * blur is only re-run when a value that affects it actually changed.
 */
export class LogoBackdrop {
  /**
   * Final on-screen quad. Its camera spans [-0.5, 0.5] on both axes and never moves,
   * which is what locks the plate to the frame: the studio camera can orbit, dolly and
   * spiral, and this pass renders identically every time.
   */
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private uniforms: CompositeUniforms;

  /** Offscreen scene used to run the blur passes over a full-target quad. */
  private blurScene = new THREE.Scene();
  private blurCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
  private blurMesh: THREE.Mesh;
  private blurMaterial: THREE.ShaderMaterial;
  private blurUniforms: BlurUniforms;

  /** Intermediate for the horizontal pass, plus the two results the composite reads. */
  private rtPing: THREE.WebGLRenderTarget | null = null;
  private rtBlurred: THREE.WebGLRenderTarget | null = null;
  private rtGlow: THREE.WebGLRenderTarget | null = null;

  /** The raw white-on-transparent plate built from the logo image. */
  private texture: THREE.Texture | null = null;
  /** URL currently loaded into `texture`, so repeated setConfig calls do not reload. */
  private loadedUrl: string | null = null;
  /** Aspect (width / height) of the loaded plate, including its glow padding. */
  private logoAspect = 1;
  private config: LogoBackdropConfig | null = null;
  private disposed = false;

  /** Frame aspect the quad is currently laid out for. */
  private viewportAspect = 16 / 9;

  /**
   * Fingerprint of the inputs the blur depends on. The blur runs on the GPU into render
   * targets, so it must NOT re-run every frame — only when one of these actually changes.
   */
  private blurKey = "";
  /** Set when something invalidated the blur and it has to be re-run before the next draw. */
  private blurDirty = true;

  /**
   * Max anisotropy of the GPU actually in use, learned from the first renderer that draws
   * this plate. 1 (isotropic) until then, which is only ever the case before the first
   * frame; `prepare` re-applies it to a texture that loaded earlier.
   */
  private maxAnisotropy = 1;

  /** Seconds on the plate's own clock, fed by setElapsed. Drives the neon flicker only. */
  private elapsed = 0;


  /** Camera whose view defines the wall rectangle, for frame-relative placement. */
  private frameCamera: THREE.Camera | null = null;

  /**
   * Called once the plate's texture has finished decoding and the plate becomes `active`.
   *
   * The studio uses it to re-run the checks that depend on `active` — they run synchronously
   * after setConfig, which is always before an image can have loaded.
   */
  onReady: (() => void) | null = null;

  constructor() {
    this.uniforms = {
      uBlurred: { value: null },
      uGlow: { value: null },
      uColor: { value: new THREE.Color("#ffffff") },
      uNeonColor: { value: new THREE.Color("#ff2fd0") },
      uNeonIntensity: { value: 0.6 },
      uNeonCoreWidth: { value: 0.5 },
      uNeonCoreGlow: { value: 0.65 },
      uNeonBloom: { value: 0.5 },
      uFlicker: { value: 1 },
      uOpacity: { value: 1 },
      uNeon: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      transparent: true,
      // The plate is a backdrop: it must never occlude the cue drawn after it, and it has
      // nothing to depth-test against in its own empty scene.
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    // Wall mode puts this transparent quad in the middle of the studio scene, where it
    // shares the transparent queue with the wall's background frame planes. Those planes
    // are opaque paint at renderOrder 0, so a plate ordered before them was drawn and then
    // buried the moment a background was added — the logo simply vanished. Ordering it
    // after the frames keeps it on top of whatever backdrop is chosen, while `depthTest`
    // still lets the cue in front occlude it.
    this.mesh.renderOrder = LOGO_WALL_RENDER_ORDER;
    this.scene.add(this.mesh);

    this.blurUniforms = {
      uSource: { value: null },
      uStep: { value: new THREE.Vector2() },
      uSigma: { value: 0 },
    };
    this.blurMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: this.blurUniforms as unknown as Record<string, THREE.IUniform>,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    // Exactly fills the [-0.5, 0.5] box, so one draw covers the whole render target.
    this.blurMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.blurMaterial);
    this.blurScene.add(this.blurMesh);
  }

  /** True when there is something to draw. Cheap enough to call per frame. */
  get active(): boolean {
    return !this.disposed && !!this.config?.enabled && !!this.texture;
  }

  /**
   * Where the plate currently lives. Drives which render path the studio uses.
   *
   * Always "wall" now. The screen-locked anchor was removed once frame-relative wall
   * placement did the same job better — it keeps the plate as real set geometry, so the cue
   * occludes it and it holds the set's perspective, which a flat screen overlay never could.
   * Templates saved with `anchor: "screen"` are read as wall so they keep rendering.
   */
  get anchor(): LogoBackdropAnchor {
    return "wall";
  }

  /**
   * The plate mesh, for the caller to add to the studio scene in wall mode.
   *
   * In wall mode the plate is ordinary set geometry: the main render draws it in the same
   * pass as everything else, so it is occluded by the cue and picks up the set's
   * perspective for free. In screen mode the mesh belongs to this module's own overlay
   * scene instead and the caller must not touch it.
   */
  get worldMesh(): THREE.Mesh {
    return this.mesh;
  }

  /**
   * Apply a config. Resolving the logo URL is the caller's job (it depends on the
   * product's own logoId and on the CUE_LOGO_OPTIONS catalog), so this takes the
   * already-resolved `url`.
   */
  setConfig(config: LogoBackdropConfig, url: string | null): void {
    if (this.disposed) return;
    this.config = config;

    this.uniforms.uColor.value.set(config.color);
    this.uniforms.uNeonColor.value.set(config.neonColor);
    this.uniforms.uNeonIntensity.value = THREE.MathUtils.clamp(config.neonIntensity, 0, 1);
    this.uniforms.uNeonCoreWidth.value = THREE.MathUtils.clamp(config.neonCoreWidth ?? 0.5, 0, 1);
    this.uniforms.uNeonCoreGlow.value = THREE.MathUtils.clamp(config.neonCoreGlow ?? 0.65, 0, 1);
    this.uniforms.uNeonBloom.value = THREE.MathUtils.clamp(config.neonBloom ?? 0.5, 0, 1);
    this.uniforms.uOpacity.value = THREE.MathUtils.clamp(config.opacity, 0, 1);
    this.uniforms.uNeon.value = config.style === "neon" ? 1 : 0;
    // A steady tube is the default; the flicker uniform is driven per frame by tick().
    if ((config.neonFlicker ?? 0) <= 0 || config.style !== "neon") {
      this.uniforms.uFlicker.value = 1;
    }
    this.mesh.rotation.z = -THREE.MathUtils.degToRad(config.rotation);

    // Depth behaviour differs by anchor. On the wall the plate is real set geometry and
    // must depth-test so the cue occludes it; as a screen overlay it is drawn into its own
    // empty scene before anything else and has nothing to test against.
    const onWall = (config.anchor ?? "wall") === "wall";
    this.material.depthTest = onWall;
    // Never write depth either way: the plate is a flat backdrop and writing depth would
    // let it reject the cue's own fragments where they overlap.
    this.material.depthWrite = false;

    // Neon EMITS light, so it composites additively: its glow brightens whatever is behind
    // it instead of blending toward it. With normal alpha blending a dim outer halo over a
    // black wall is multiplied down to nothing — which is exactly why neon "did not render"
    // on a black backdrop while looking fine on a light one. Additive also gives the
    // overlapping halo/bloom layers their build-up, so the tube reads as genuinely hot.
    const additive = config.style === "neon";
    const wantBlending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    if (this.material.blending !== wantBlending) {
      this.material.blending = wantBlending;
      this.material.needsUpdate = true;
    }
    this.applyAnchorParenting();

    if (url !== this.loadedUrl) this.loadTexture(url);

    // Only blur radius, neon reach and the plate itself change the blurred textures.
    // Colour, opacity and rotation are free — they are applied by the composite pass.
    const key = [
      this.loadedUrl ?? "",
      (config.style === "neon" ? (config.neonBlur ?? 0) : config.blur).toFixed(4),
      config.style,
      // Only the GLOW SIZE changes the blurred textures. Brightness, core width, bloom and
      // flicker are composite-pass uniforms and must not trigger a re-blur.
      config.style === "neon" ? (config.neonGlowSize ?? 0.5).toFixed(4) : "0",
    ].join("|");
    if (key !== this.blurKey) {
      this.blurKey = key;
      this.blurDirty = true;
    }

    this.layout();
  }

  /**
   * Move the plate between this module's overlay scene and the caller's world scene.
   *
   * Wall mode needs the mesh inside the studio scene so the normal render pass draws and
   * occludes it; screen mode needs it in the private overlay scene so the dedicated
   * pre-pass can draw it alone. Being in both at once would draw it twice.
   */
  private applyAnchorParenting(): void {
    if (this.anchor === "wall") {
      if (this.mesh.parent === this.scene) this.scene.remove(this.mesh);
    } else {
      if (this.mesh.parent !== this.scene) {
        this.mesh.removeFromParent();
        this.scene.add(this.mesh);
      }
    }
  }

  private loadTexture(url: string | null): void {
    this.loadedUrl = url;
    this.disposeTexture();
    if (!url) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (this.disposed || this.loadedUrl !== url) return;
      const plate = buildLogoAlphaPlate(img);
      if (!plate) {
        console.warn("[LogoBackdrop] could not extract a logo from", url);
        this.loadedUrl = null;
        return;
      }
      const tex = new THREE.CanvasTexture(plate.canvas);
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      // Mipmaps + anisotropy, not plain LinearFilter. The plate is now high resolution and
      // the composite can sample it directly, so it is regularly MINIFIED onto the wall —
      // and unmipmapped minification is precisely what makes a wordmark's strokes crawl and
      // stair-step. Anisotropy keeps it clean when the wall is viewed at an angle.
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = this.maxAnisotropy;
      tex.needsUpdate = true;
      this.logoAspect = plate.aspect;
      this.texture = tex;
      // A new plate means new dimensions, so the targets are rebuilt on the next blur.
      this.blurDirty = true;
      this.blurKey = "";
      this.layout();
      // `active` is false until the texture exists, so anything the studio decided while
      // this image was still downloading was decided as if there were no logo at all — in
      // particular, whether the wall mesh belongs in the scene. Tell it to look again, or a
      // saved template opens with no logo until some unrelated edit re-runs that check.
      this.onReady?.();
    };
    img.onerror = () => {
      // A missing logo file must not take the studio down - the plate simply stays off.
      if (this.loadedUrl === url) this.loadedUrl = null;
    };
    img.src = url;
  }

  /** Tell the plate what shape the frame is. Call on resize and before recording. */
  setViewportAspect(aspect: number): void {
    if (!isFinite(aspect) || aspect <= 0) return;
    if (Math.abs(aspect - this.viewportAspect) < 1e-6) return;
    this.viewportAspect = aspect;
    this.layout();
  }

  /**
   * Size and place the quad inside the [-0.5, 0.5] box.
   *
   * The mark is fitted by its LONGEST side, so at scale = 1 a wide logo touches the left
   * and right edges and a tall one touches top and bottom - either way the whole mark is
   * always on screen ("display full in camera frame").
   *
   * The glow padding is already baked into the plate texture (and therefore into
   * logoAspect), so it is not applied again here.
   */
  private layout(): void {
    if (!this.config) return;
    const scale = Math.max(0.05, this.config.scale);
    const offsetX = this.config.offsetX;
    const offsetY = this.config.offsetY;

    if (this.anchor === "wall") {
      // ── Wall mode: real geometry, in world units, parked in front of the back wall.
      //
      // Two framings share this branch:
      //
      //   frame-relative (config.frameRelative) — the plate is positioned inside the
      //     rectangle the camera's view cuts out of the wall, so it holds the same spot in
      //     the shot while the camera moves. See layoutFrameRelative.
      //
      //   wall-relative (the default) — the plate is positioned against the wall itself, so
      //     it stays put on the wall and slides through frame as the camera moves.
      //
      // Either way it is real geometry on the wall, so the cue occludes it and it takes the
      // set's perspective for free.
      const frame = this.config.frameRelative ? this.wallFrameRect() : null;

      const spanW = frame ? frame.width : WALL_WIDTH;
      const spanH = frame ? frame.height : WALL_HEIGHT;
      const centreX = frame ? frame.centerX : 0;
      const centreY = frame ? frame.centerY : WALL_Y;

      // Fit by the longer side against the span, so scale = 1 means "spans the frame" in
      // frame-relative mode and "spans the wall" otherwise. The mark's own aspect is kept
      // either way so it is never stretched.
      const spanAspect = spanW / Math.max(spanH, 1e-6);
      let w: number;
      let h: number;
      if (this.logoAspect >= spanAspect) {
        w = spanW * scale;
        h = w / this.logoAspect;
      } else {
        h = spanH * scale;
        w = h * this.logoAspect;
      }
      this.mesh.scale.set(w, h, 1);
      // Offsets are fractions of the span, so the slider feels the same in every mode.
      this.mesh.position.set(
        centreX + offsetX * (spanW / 2),
        centreY + offsetY * (spanH / 2),
        WALL_Z + WALL_OFFSET_Z
      );
      // The studio disables scene.matrixWorldAutoUpdate while recording, so a transform
      // written after that point would never reach the GPU. Pushing it through here keeps
      // the plate correct regardless of when it was last edited.
      this.mesh.updateMatrix();
      this.mesh.updateMatrixWorld(true);
      return;
    }

    // ── Screen mode: the quad lives in the overlay camera's [-0.5, 0.5] box.
    // That box is square in NDC but the frame is not, so the quad's width is divided by
    // the viewport aspect to keep the logo's own proportions.
    let w: number;
    let h: number;
    if (this.logoAspect >= this.viewportAspect) {
      w = scale;
      h = (w / this.logoAspect) * this.viewportAspect;
    } else {
      h = scale;
      w = (h * this.logoAspect) / this.viewportAspect;
    }
    this.mesh.scale.set(w, h, 1);
    this.mesh.position.set(offsetX * 0.5, offsetY * 0.5, 0);
  }

  /**
   * The rectangle the camera's view cuts out of the back wall, in world units.
   *
   * This is the "4 orange lines meet the wall" construction: each of the camera's four
   * frustum corners is a ray from the eye through a corner of the near plane; extending
   * that ray until it reaches z = WALL_Z gives the corner of the visible rectangle ON the
   * wall. Positioning the plate inside that rectangle by a fixed fraction is what makes it
   * hold its spot in the shot while the camera moves — the rectangle slides and grows, and
   * the plate rides along with it.
   *
   * An axis-aligned box is used rather than the exact (possibly sheared) quad. The plate is
   * an axis-aligned quad itself, so it could not fill a sheared one anyway, and the bounding
   * box degrades gracefully: on a straight-on camera the two are identical, and on an angled
   * one the plate stays inside frame rather than tracking a corner it cannot match.
   *
   * Returns null when there is no camera yet, or when the camera cannot see the wall at all
   * (looking away from it, or past it) — the caller then falls back to wall-relative
   * placement rather than putting the plate somewhere nonsensical.
   */
  private wallFrameRect(): { centerX: number; centerY: number; width: number; height: number } | null {
    const camera = this.frameCamera;
    if (!camera) return null;

    camera.updateMatrixWorld();
    const eye = FRUSTUM_EYE.setFromMatrixPosition(camera.matrixWorld);

    // The wall is only in view if the camera is in front of it and facing it. Everything
    // downstream divides by the ray's z travel, so this also guards the division.
    const depth = WALL_Z - eye.z;
    if (depth >= -1e-4) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const [ndcX, ndcY] of NDC_CORNERS) {
      // Unproject a near-plane corner into world space; the eye-to-corner direction is the
      // frustum edge (one of the orange lines).
      const corner = FRUSTUM_CORNER.set(ndcX, ndcY, -1).unproject(camera);
      const dz = corner.z - eye.z;
      // A frustum edge parallel to the wall never reaches it, so there is no rectangle.
      if (Math.abs(dz) < 1e-6) return null;
      const t = depth / dz;
      // The wall must lie FORWARD along the ray; behind the camera means it is not in shot.
      if (t <= 0) return null;
      const x = eye.x + (corner.x - eye.x) * t;
      const y = eye.y + (corner.y - eye.y) * t;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const width = maxX - minX;
    const height = maxY - minY;
    if (!isFinite(width) || !isFinite(height) || width <= 1e-4 || height <= 1e-4) return null;

    return {
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      width,
      height,
    };
  }

  /**
   * Tell the plate which camera frames the shot.
   *
   * Only frame-relative placement uses it, and it re-lays out on every call because the
   * rectangle moves whenever the camera does. The studio hands over the PRODUCTION camera
   * (not the scene-view god camera) so the plate is composed against the shot that will be
   * recorded, not against whatever angle the editor happens to be looking from.
   */
  setFrameCamera(camera: THREE.Camera | null): void {
    this.frameCamera = camera;
    if (this.config?.frameRelative) this.layout();
  }

  /**
   * Re-place a frame-relative plate for the camera's current pose.
   *
   * Cheap enough to call every frame: it is four unprojections and a matrix write, with no
   * allocation. A no-op unless the plate is actually frame-relative.
   */
  syncToFrame(): void {
    if (this.config?.frameRelative && this.anchor === "wall") this.layout();
  }


  /**
   * Run the two separable blur passes into render targets.
   *
   * Blurring here rather than in the composite shader is what removes the plaid banding:
   * a single-pass 2D kernel would need TAPS^2 samples to cover a wide radius densely,
   * while two 1D passes cover the same area with 2*TAPS and no gaps between samples.
   * Blurring at a reduced resolution stretches each tap further still, because the
   * hardware's bilinear filter averages whatever falls between taps.
   */
  private runBlur(renderer: THREE.WebGLRenderer): void {
    const tex = this.texture;
    const config = this.config;
    if (!tex || !config) return;

    // The plate can finish loading before any renderer has touched this object, so the
    // real anisotropy limit is applied here rather than at texture-creation time.
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    if (maxAniso !== this.maxAnisotropy) this.maxAnisotropy = maxAniso;
    if (tex.anisotropy !== maxAniso) {
      tex.anisotropy = maxAniso;
      tex.needsUpdate = true;
    }

    const image = tex.image as { width: number; height: number };
    const srcW = image.width;
    const srcH = image.height;
    const rtW = Math.max(2, Math.round(srcW / BLUR_DOWNSCALE));
    const rtH = Math.max(2, Math.round(srcH / BLUR_DOWNSCALE));

    if (!this.rtPing || this.rtPing.width !== rtW || this.rtPing.height !== rtH) {
      this.disposeTargets();
      const opts: THREE.RenderTargetOptions = {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
      };
      this.rtPing = new THREE.WebGLRenderTarget(rtW, rtH, opts);
      this.rtBlurred = new THREE.WebGLRenderTarget(rtW, rtH, opts);
      this.rtGlow = new THREE.WebGLRenderTarget(rtW, rtH, opts);
      for (const rt of [this.rtPing, this.rtBlurred, this.rtGlow]) {
        rt.texture.wrapS = THREE.ClampToEdgeWrapping;
        rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      }
    }

    const savedTarget = renderer.getRenderTarget();
    const savedAutoClear = renderer.autoClear;
    renderer.autoClear = true;

    // The blur radius is expressed along the plate's LONGER axis, so the per-axis UV step
    // is scaled by that axis's share of the plate. Without this the kernel would be
    // elliptical on a non-square plate.
    const longest = Math.max(srcW, srcH);
    const stepScaleX = longest / srcW;
    const stepScaleY = longest / srcH;

    const blurInto = (
      radius: number,
      destination: THREE.WebGLRenderTarget
    ): void => {
      const ping = this.rtPing!;
      // Horizontal pass: source plate -> ping
      this.blurUniforms.uSource.value = tex;
      this.blurUniforms.uSigma.value = radius;
      this.blurUniforms.uStep.value.set(radius * stepScaleX, 0);
      renderer.setRenderTarget(ping);
      renderer.render(this.blurScene, this.blurCamera);
      // Vertical pass: ping -> destination
      this.blurUniforms.uSource.value = ping.texture;
      this.blurUniforms.uStep.value.set(0, radius * stepScaleY);
      renderer.setRenderTarget(destination);
      renderer.render(this.blurScene, this.blurCamera);
    };

    // Each style carries its own softness — see LogoBackdropConfig.neonBlur.
    const rawBlur = THREE.MathUtils.clamp(
      config.style === "neon" ? (config.neonBlur ?? 0) : config.blur,
      0,
      1
    );
    const radius = rawBlur * MAX_BLUR_UV;

    // Sharp path: nothing to blur, so skip the reduced-resolution round trip entirely and
    // let the composite read the full-resolution plate. This is what keeps a crisp logo
    // crisp — see SHARP_BLUR_EPSILON.
    const sharp = rawBlur < SHARP_BLUR_EPSILON;
    if (sharp) {
      this.uniforms.uBlurred.value = tex;
    } else {
      blurInto(radius, this.rtBlurred!);
      this.uniforms.uBlurred.value = this.rtBlurred!.texture;
    }

    if (config.style === "neon") {
      // The halo always blurs, sharp core or not — that is the whole point of neon. Its
      // reach is driven by the glow-size control rather than by intensity, so brightness
      // and spread can be dialled independently.
      const spread = THREE.MathUtils.clamp(config.neonGlowSize ?? 0.5, 0, 1);
      const glowRadius = radius + NEON_GLOW_MIN_UV + spread * NEON_GLOW_RANGE_UV;
      blurInto(glowRadius, this.rtGlow!);
      this.uniforms.uGlow.value = this.rtGlow!.texture;
    } else {
      // Solid style never reads uGlow, but the sampler must still be bound to a real
      // texture or some drivers sample undefined memory.
      this.uniforms.uGlow.value = this.uniforms.uBlurred.value;
    }

    renderer.setRenderTarget(savedTarget);
    renderer.autoClear = savedAutoClear;
    this.blurDirty = false;
  }

  /**
   * Draw the plate. The caller has already cleared the target to the background colour
   * and must render the main scene afterwards with `autoClear` disabled.
   *
   * `opacityScale` dims this one pass (scene view uses it) without touching the config.
   */
  render(renderer: THREE.WebGLRenderer, opacityScale = 1): void {
    if (!this.active || this.anchor !== "screen") return;
    if (!this.prepare(renderer)) return;

    const base = this.uniforms.uOpacity.value;
    this.uniforms.uOpacity.value = base * opacityScale;
    renderer.render(this.scene, this.camera);
    this.uniforms.uOpacity.value = base;
  }

  /**
   * Make sure the blurred textures are up to date, and report whether the plate is
   * ready to be drawn.
   *
   * The blur renders into offscreen targets, so it cannot run while the caller has a
   * render target bound mid-pass — wall mode must call this BEFORE it starts the main
   * scene render, not during it.
   */
  prepare(renderer: THREE.WebGLRenderer): boolean {
    if (!this.active) return false;
    if (this.blurDirty) this.runBlur(renderer);
    this.updateFlicker();
    return !!this.uniforms.uBlurred.value;
  }

  /**
   * Drive the per-frame flicker uniform.
   *
   * Two detuned sines plus a sparse dip give the irregular, slightly unstable brightness of
   * a real tube; a single sine reads as a deliberate pulse instead. `setElapsed` supplies
   * the clock so a recording flickers on its own timeline rather than on wall-clock time —
   * the same frame always renders the same way, which matters for a deterministic export.
   */
  private updateFlicker(): void {
    const amount = THREE.MathUtils.clamp(this.config?.neonFlicker ?? 0, 0, 1);
    if (amount <= 0 || this.config?.style !== "neon") {
      this.uniforms.uFlicker.value = 1;
      return;
    }
    const t = this.elapsed;
    const wave =
      Math.sin(t * FLICKER_HZ_A) * 0.6 + Math.sin(t * FLICKER_HZ_B) * 0.4;
    // Sparse deeper dropout, so the tube occasionally stutters instead of merely breathing.
    const dip = Math.max(0, Math.sin(t * FLICKER_DIP_HZ) - 0.93) * 9.0;
    const swing = wave * 0.5 - dip;
    // At amount = 1 the tube swings roughly 40% down but never brightens past its nominal
    // level, so flicker never blows out a look that was already dialled in.
    this.uniforms.uFlicker.value = THREE.MathUtils.clamp(
      1 + swing * 0.4 * amount,
      0.15,
      1
    );
  }

  /**
   * Advance the plate's own clock, in seconds. Only the flicker uses it.
   *
   * Passing the animation/recording time rather than reading a wall clock keeps a rendered
   * video reproducible: the same frame index always produces the same flicker phase.
   */
  setElapsed(seconds: number): void {
    if (isFinite(seconds)) this.elapsed = seconds;
  }


  /**
   * Show or hide the wall-anchored mesh.
   *
   * Used for transparent captures (where a full backdrop would fill every pixel that is
   * supposed to stay empty) and for the same helper-hiding passes that drop the wall.
   */
  setWorldVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  private disposeTargets(): void {
    for (const rt of [this.rtPing, this.rtBlurred, this.rtGlow]) rt?.dispose();
    this.rtPing = null;
    this.rtBlurred = null;
    this.rtGlow = null;
    this.uniforms.uBlurred.value = null;
    this.uniforms.uGlow.value = null;
  }

  private disposeTexture(): void {
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    this.blurDirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeTexture();
    this.disposeTargets();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.mesh);
    this.blurMesh.geometry.dispose();
    this.blurMaterial.dispose();
    this.blurScene.remove(this.blurMesh);
  }
}
