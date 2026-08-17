/**
 * Exports a configured cue model to a self-contained .glb file.
 *
 * Three things make a naive `GLTFExporter.parse(model)` produce a bare, leather-less
 * cue, and this module deals with each of them:
 *
 * 1. **KTX2 / compressed textures.** The cue GLBs ship with KTX2-compressed maps.
 *    `GLTFExporter` refuses to serialise a `CompressedTexture` unless it is given a
 *    texture-utils implementation, so we hand it `WebGLTextureUtils`, which blits each
 *    compressed map back into a readable canvas before writing.
 *
 * 2. **Runtime-generated maps.** The leather (`map`, `normalMap`, `roughnessMap`) is
 *    drawn procedurally into canvases at runtime. Those survive export only while the
 *    source canvas is still alive, so we snapshot every canvas-backed texture into a
 *    detached image first (`bakeCanvasTextures`).
 *
 * 3. **Shader-only effects.** Laser logos and bumper masks are injected through
 *    `onBeforeCompile`, which glTF has no representation for. The underlying
 *    emissiveMap/emissive values are standard PBR and do export; the shader-driven
 *    masking does not. That is a documented limitation, not a bug we can fix here.
 *
 * `material.envMap` is deliberately NOT exported — glTF has no per-material environment
 * slot, and viewers are expected to supply their own IBL. Callers that want the web
 * lighting reproduced should ship the HDRI next to the .glb (see `exportProductBundle`).
 */

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import * as WebGLTextureUtils from "three/examples/jsm/utils/WebGLTextureUtils.js";
import { isRubberMaterial, isTopCapFaceMaterial, isTopCapMaterial } from "./leather-config";

/** Texture slots that carry image data we care about preserving. */
const TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "emissiveMap",
  "aoMap",
  "alphaMap",
  "bumpMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "sheenColorMap",
  "specularIntensityMap",
] as const;

type TextureSlot = (typeof TEXTURE_SLOTS)[number];

/** A material with indexable texture slots, so we can walk them without `any`. */
type TexturedMaterial = THREE.Material & Partial<Record<TextureSlot, THREE.Texture | null>>;

export interface GlbExportOptions {
  /** Lights to embed via `KHR_lights_punctual`. Directional/point/spot only. */
  lights?: THREE.Light[];
  /** Camera to embed, so the file opens on the same framing as the editor. */
  camera?: THREE.Camera | null;
  /** Largest texture edge to write, in pixels. Default 4096 (full quality). */
  maxTextureSize?: number;
  /** Write .gltf + separate resources instead of a single binary .glb. Default false. */
  binary?: boolean;
}

/**
 * Replaces every canvas-backed texture on `root` with an equivalent image-backed one.
 *
 * A `CanvasTexture` points at a live `<canvas>`; once the SceneManager that drew it is
 * disposed the canvas may be blanked or GC'd, and the export silently loses the leather.
 * Copying the pixels into a detached canvas makes each texture independent of the
 * renderer's lifetime.
 *
 * Returns a disposer for the textures it created.
 */
function bakeCanvasTextures(root: THREE.Object3D): () => void {
  const created: THREE.Texture[] = [];
  const converted = new Map<THREE.Texture, THREE.Texture>();

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];

    for (const material of materials) {
      const mat = material as TexturedMaterial;

      for (const slot of TEXTURE_SLOTS) {
        const texture = mat[slot];
        if (!texture) continue;

        const image: unknown = texture.image;
        if (!(image instanceof HTMLCanvasElement)) continue;

        const cached = converted.get(texture);
        if (cached) {
          mat[slot] = cached;
          continue;
        }

        const snapshot = document.createElement("canvas");
        snapshot.width = image.width;
        snapshot.height = image.height;
        const ctx = snapshot.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(image, 0, 0);

        // Copy every sampling property verbatim, `flipY` included. The exporter applies its
        // own flip for `flipY === true`, which is the correct three.js -> glTF conversion;
        // pre-flipping the pixels here and forcing `flipY = false` cancels it out and lands
        // the map upside-down. This snapshot only detaches the pixels from a live canvas —
        // it must not reinterpret them.
        const baked = new THREE.CanvasTexture(snapshot);
        baked.name = texture.name;
        baked.colorSpace = texture.colorSpace;
        baked.wrapS = texture.wrapS;
        baked.wrapT = texture.wrapT;
        baked.repeat.copy(texture.repeat);
        baked.offset.copy(texture.offset);
        baked.center.copy(texture.center);
        baked.rotation = texture.rotation;
        baked.flipY = texture.flipY;
        baked.channel = texture.channel;
        baked.needsUpdate = true;

        converted.set(texture, baked);
        created.push(baked);
        mat[slot] = baked;
      }
    }
  });

  return () => created.forEach((texture) => texture.dispose());
}


/**
 * Serialises `model` to a .glb blob with all of its textures embedded.
 *
 * The model is cloned first so the live scene is never mutated; the clone keeps the
 * same material instances, which is what lets the baked textures apply cleanly.
 */
export async function exportModelToGlb(
  model: THREE.Object3D,
  options: GlbExportOptions = {}
): Promise<Blob> {
  const { lights = [], camera = null, maxTextureSize = 4096, binary = true } = options;

  // Export a detached copy: GLTFExporter walks parents for world transforms, and we
  // want the cue centred on its own origin rather than wherever the studio put it.
  const root = new THREE.Group();
  root.name = "CueModel";

  const clone = model.clone(true);
  clone.position.set(0, 0, 0);
  clone.rotation.set(0, 0, 0);
  clone.scale.setScalar(1);
  root.add(clone);

  // `Object3D.clone()` shares material instances with the source, so the texture swaps
  // performed below would otherwise reach into the live editor scene and repoint its maps
  // at our baked copies — which are disposed as soon as the export finishes, blanking the
  // on-screen cue. Give the export its own materials.
  const clonedMaterials: THREE.Material[] = [];
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (Array.isArray(child.material)) {
      child.material = child.material.map((m: THREE.Material) => {
        const copy = m.clone();
        clonedMaterials.push(copy);
        return copy;
      });
    } else {
      const copy = (child.material as THREE.Material).clone();
      clonedMaterials.push(copy);
      child.material = copy;
    }
  });

  // Strip the engraved logos. They are drawn as an emissive map masked by an
  // `onBeforeCompile` shader, and glTF has no way to carry that shader — the mask is lost on
  // export and the raw emissive map lands on the whole part instead of the flat face it was
  // meant for, which is why exported logos came out misplaced. Dropping the emissive channel
  // on those materials is deliberate: an unlogo'd part is correct, a smeared logo is not.
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      const mat = material as THREE.MeshPhysicalMaterial;
      if (!mat.emissiveMap) continue;

      const isLogoCarrier =
        isRubberMaterial(mat.name, child.name) ||
        isTopCapFaceMaterial(mat.name) ||
        isTopCapMaterial(mat.name, child.name);
      if (!isLogoCarrier) continue;

      mat.emissiveMap = null;
      mat.emissive = new THREE.Color(0x000000);
      // The shader mask is re-attached on clone by the scene managers; clear it so the
      // exporter does not warn about a material it cannot represent.
      mat.onBeforeCompile = () => {};
      mat.needsUpdate = true;
    }
  });

  // Hidden meshes (unselected joint/bumper variants) would otherwise be written out as
  // invisible-but-present geometry and show up in other DCC tools.
  const hidden: THREE.Object3D[] = [];
  clone.traverse((child) => {
    if (child instanceof THREE.Mesh && !child.visible) hidden.push(child);
  });
  hidden.forEach((mesh) => mesh.removeFromParent());

  // Added directly rather than cloned: these rigs parent their `target` to the light so the
  // aim survives export, and `Light.clone()` does not carry that child across.
  for (const light of lights) {
    root.add(light);
  }

  if (camera) {
    root.add(camera);
  }

  const disposeBaked = bakeCanvasTextures(root);

  const exporter = new GLTFExporter();
  // Lets the exporter decompress the model's KTX2 maps itself. Doing this decompression by
  // hand looks tempting — `WebGLTextureUtils.decompress` drops repeat/offset/flipY/channel —
  // but it sizes its output from `texture.image.width`, which for a KTX2 CompressedTexture
  // is not the full 2048px mip, so every leather map silently came out downsampled. The
  // exporter's own path reads the mip chain correctly; leave it alone.
  exporter.setTextureUtils(WebGLTextureUtils);

  try {
    const result = await exporter.parseAsync(root, {
      binary,
      onlyVisible: true,
      maxTextureSize,
    });

    if (result instanceof ArrayBuffer) {
      return new Blob([result], { type: "model/gltf-binary" });
    }

    return new Blob([JSON.stringify(result)], { type: "model/gltf+json" });
  } finally {
    disposeBaked();
    clonedMaterials.forEach((material) => material.dispose());
  }
}

/** Strips characters that are unsafe in file names across Windows/macOS. */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_ ]/g, "_").trim() || "cue";
}
