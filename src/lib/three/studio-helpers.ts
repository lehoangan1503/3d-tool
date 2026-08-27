import * as THREE from "three";
import type { ExtractorSceneManager } from "./extractor-scene-manager";

/**
 * Create an envMap-blocking MeshBasicMaterial. The ESM's updateSurfaceHdri()
 * tries to set envMap + envMapIntensity on wall/table materials every update;
 * blocking the setter prevents expensive PMREM texture application and
 * shader recompilation on every config change.
 */
export function createWhiteImmuneMaterial(tint?: string | null): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    // There is no texture to multiply here, so the surface tint IS the colour.
    color: tint ? new THREE.Color(tint) : 0xffffff,
    side: THREE.FrontSide,
  });
  Object.defineProperty(mat, "envMap", { get: () => null, set: () => {}, configurable: true });
  return mat;
}

/**
 * Multiply a surface material by its base tint.
 *
 * `.color` on a mapped MeshStandardMaterial multiplies the colour map, so tinting keeps the
 * texture pack's grain instead of flattening it. An absent or white tint resets to neutral,
 * which is what makes the picker's "white" swatch mean "no tint" rather than "paint it white".
 */
export function applySurfaceTint(
  mat: THREE.MeshStandardMaterial,
  tint?: string | null
): void {
  mat.color.set(tint || "#ffffff");
  mat.needsUpdate = true;
}

/**
 * Replace wall/table materials with immune-to-lighting MeshBasicMaterial.
 * Only needs to run ONCE after setupStudioFromStudioConfig (or rebuild).
 */
export function forceWhiteWalls(esm: ExtractorSceneManager): void {
  const scene = esm.getScene();
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const t = obj.userData?.type;
    if (t === "wall" || t === "table" || t === "corner-fill") {
      const oldMat = obj.material as THREE.Material;
      obj.material = createWhiteImmuneMaterial();
      oldMat.dispose();
    }
  });
}
