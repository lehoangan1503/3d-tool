import * as THREE from "three";
import type { ExtractorSceneManager } from "./extractor-scene-manager";

/**
 * Create an envMap-blocking MeshBasicMaterial. The ESM's updateSurfaceHdri()
 * tries to set envMap + envMapIntensity on wall/table materials every update;
 * blocking the setter prevents expensive PMREM texture application and
 * shader recompilation on every config change.
 */
export function createWhiteImmuneMaterial(): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide });
  Object.defineProperty(mat, "envMap", { get: () => null, set: () => {}, configurable: true });
  return mat;
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
    if (t === "wall" || t === "table") {
      const oldMat = obj.material as THREE.Material;
      obj.material = createWhiteImmuneMaterial();
      oldMat.dispose();
    }
  });
}
