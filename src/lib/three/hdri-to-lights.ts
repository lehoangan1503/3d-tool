/**
 * Approximates an HDRI environment as a small rig of punctual lights.
 *
 * glTF cannot store an environment map. `KHR_materials_ies` and friends do not help, and
 * there is no "scene.environment" equivalent in the format — an importer is expected to
 * bring its own IBL. That is why a cue exported straight from the customizer looks flat
 * when opened somewhere else.
 *
 * What glTF *can* store is `KHR_lights_punctual`: directional, point and spot lights. So we
 * sample the HDRI itself and fit a handful of directional lights to it — a key light aimed
 * at the brightest region, fill lights for the next-brightest lobes, and an ambient-ish
 * light carrying the average colour. The result is not image-based lighting, but it travels
 * inside the single .glb and gives a lit, correctly-tinted model in any viewer.
 */

import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

export interface HdriLightRigOptions {
  /** Number of directional lights fitted to the HDRI's bright lobes. Default 3. */
  lightCount?: number;
  /** Multiplies every fitted light's intensity. Default 1. */
  intensity?: number;
  /** Y-axis rotation of the environment, in degrees, matching the viewer's HDRI rotation. */
  rotationY?: number;
  /** Radius at which lights are placed around the model. Default 10. */
  distance?: number;
}

interface Lobe {
  direction: THREE.Vector3;
  color: THREE.Color;
  luminance: number;
}

/**
 * Points a directional light at the origin in the way glTF can actually record.
 *
 * `KHR_lights_punctual` has no target node: a light shines down its own -Z axis. The
 * exporter only keeps the direction when `light.target` is a child of the light sitting at
 * (0, 0, -1) — the default `target` at the scene origin makes it warn and drop the aim. So
 * we orient the light itself with lookAt and re-parent the target to match.
 */
function aimAtOrigin(light: THREE.DirectionalLight): void {
  light.lookAt(0, 0, 0);
  light.target.position.set(0, 0, -1);
  light.add(light.target);
}

/** Rec. 709 luma — matches how the eye weights the channels. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Reduces an equirectangular HDR image to `count` bright lobes plus an average colour.
 *
 * The image is walked on a coarse grid (sampling every pixel of a 2K HDR is needless work
 * for a handful of lights). Each sample is converted from equirect UV to a direction on the
 * unit sphere and weighted by sin(theta), which corrects for the pole distortion that would
 * otherwise make the top of the sky dominate.
 */
function extractLobes(
  data: Float32Array | Uint16Array,
  width: number,
  height: number,
  count: number,
  rotationYRadians: number
): { lobes: Lobe[]; average: THREE.Color } {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 128));
  const samples: Lobe[] = [];

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumWeight = 0;

  for (let y = 0; y < height; y += step) {
    // theta: 0 at the top of the sphere, PI at the bottom.
    const theta = (y / height) * Math.PI;
    const sinTheta = Math.sin(theta);
    if (sinTheta <= 0) continue;

    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      const r = Number(data[index]);
      const g = Number(data[index + 1]);
      const b = Number(data[index + 2]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;

      const weight = sinTheta;
      sumR += r * weight;
      sumG += g * weight;
      sumB += b * weight;
      sumWeight += weight;

      // phi measured from -X so the result lines up with three.js's equirect convention.
      const phi = (x / width) * Math.PI * 2 + rotationYRadians;
      const direction = new THREE.Vector3(
        -Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi)
      );

      samples.push({
        direction,
        color: new THREE.Color(r, g, b),
        luminance: luminance(r, g, b) * weight,
      });
    }
  }

  const average =
    sumWeight > 0
      ? new THREE.Color(sumR / sumWeight, sumG / sumWeight, sumB / sumWeight)
      : new THREE.Color(1, 1, 1);

  samples.sort((a, b) => b.luminance - a.luminance);

  // Greedily take the brightest samples, skipping any that sit close to one already chosen,
  // so the rig ends up with lights from distinct directions instead of a cluster on the sun.
  const lobes: Lobe[] = [];
  const minAngle = Math.cos(Math.PI / 4);
  for (const sample of samples) {
    if (lobes.length >= count) break;
    const tooClose = lobes.some((lobe) => lobe.direction.dot(sample.direction) > minAngle);
    if (!tooClose) lobes.push(sample);
  }

  return { lobes, average };
}

/**
 * Loads `hdriUrl` and returns lights approximating it, ready to add to an export scene.
 * Returns an empty array if the HDRI cannot be loaded — the export should still proceed.
 */
export async function buildLightRigFromHdri(
  hdriUrl: string,
  options: HdriLightRigOptions = {}
): Promise<THREE.Light[]> {
  const { lightCount = 3, intensity = 1, rotationY = 0, distance = 10 } = options;

  let texture: THREE.DataTexture;
  try {
    texture = await new RGBELoader().loadAsync(hdriUrl);
  } catch (error) {
    console.warn(`[hdri-to-lights] Could not load "${hdriUrl}":`, error);
    return [];
  }

  const image = texture.image as { width: number; height: number; data: Float32Array | Uint16Array };
  if (!image?.data) {
    texture.dispose();
    return [];
  }

  const { lobes, average } = extractLobes(
    image.data,
    image.width,
    image.height,
    lightCount,
    THREE.MathUtils.degToRad(rotationY)
  );
  texture.dispose();

  const lights: THREE.Light[] = [];

  // The sky's overall contribution would naturally be an AmbientLight, but
  // KHR_lights_punctual only covers directional/point/spot — the exporter warns and drops
  // anything else. A pair of dim opposing directionals in the environment's average colour
  // fills the shadow side instead, which does survive the round-trip.
  const ambientColor = average.clone().convertLinearToSRGB();
  for (const [name, dir] of [
    ["HDRI_Sky_Top", new THREE.Vector3(0, 1, 0.35)],
    ["HDRI_Sky_Bottom", new THREE.Vector3(0, -1, -0.35)],
  ] as const) {
    const skyLight = new THREE.DirectionalLight(ambientColor, 0.6 * intensity);
    skyLight.name = name;
    skyLight.position.copy(dir).normalize().multiplyScalar(distance);
    aimAtOrigin(skyLight);
    lights.push(skyLight);
  }

  const brightest = lobes[0]?.luminance ?? 1;
  lobes.forEach((lobe, index) => {
    // Normalise against the key light so a very bright sun does not blow out the fills.
    const relative = brightest > 0 ? lobe.luminance / brightest : 1;
    const light = new THREE.DirectionalLight(
      lobe.color.clone().convertLinearToSRGB(),
      (index === 0 ? 2.2 : 1.1 * relative) * intensity
    );
    light.name = index === 0 ? "HDRI_Key" : `HDRI_Fill_${index}`;
    light.position.copy(lobe.direction).multiplyScalar(distance);
    aimAtOrigin(light);
    lights.push(light);
  });

  return lights;
}
