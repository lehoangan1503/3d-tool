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
 * 3. **Shader-only effects.** The bumper logo is masked through `onBeforeCompile`, which
 *    glTF has no representation for. `bakeLogoMasksIntoGeometry` moves that mask into
 *    the geometry (separate end-face primitive) so the logo lands where it does in-app.
 *
 * `material.envMap` is deliberately NOT exported — glTF has no per-material environment
 * slot, and viewers are expected to supply their own IBL. Callers that want the web
 * lighting reproduced should ship the HDRI next to the .glb (see `exportProductBundle`).
 */

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import * as WebGLTextureUtils from "three/examples/jsm/utils/WebGLTextureUtils.js";
import { isRubberMaterial, isTopCapFaceMaterial, isTopCapMaterial } from "./leather-config";

/**
 * Default texture-size cap for exports: no downsampling in practice.
 *
 * GLTFExporter clamps width and height *independently* (`min(w, cap)`, `min(h, cap)`), so a
 * cue wrap of e.g. 1500x16000 under a 4096 cap was squashed ~4x along the cue's length —
 * the printed logos/text came out jagged while the site (which uploads the native image)
 * stayed sharp. 16384 is the common GPU max, i.e. the most any viewer can display anyway.
 */
export const FULL_QUALITY_TEXTURE_SIZE = 16384;

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
  /** Largest texture edge to write, in pixels. Default FULL_QUALITY_TEXTURE_SIZE (native size). */
  maxTextureSize?: number;
  /** Write .gltf + separate resources instead of a single binary .glb. Default false. */
  binary?: boolean;
}

/**
 * Collapses every material onto UV channel 0.
 *
 * glTF lets each texture slot pick its own UV set via `texCoord`, and the source cue models
 * genuinely use two: `leather_mat.002` and `Plastic Black 4` sample base/normal/metalRough
 * from `TEXCOORD_1`, while the joint and body stay on `TEXCOORD_0`. three.js and Blender
 * both honour that, which is why the export looks right in Blender.
 *
 * After Effects' Advanced 3D glTF importer only reads `TEXCOORD_0`. Faced with
 * `texCoord: 1` it does not fall back to UV0 — it drops the texture outright, so the leather
 * and bumper arrive untextured even though the image data is present in the file.
 *
 * Rather than re-authoring the models, the export rewrites the geometry: where a material
 * samples UV1, the `uv1` attribute is copied over `uv`, and every texture is pointed back at
 * channel 0. The coordinates are unchanged, so the mapping stays pixel-identical — only the
 * slot it lives in moves. Meshes already on UV0 are left untouched.
 *
 * This is safe because each mesh here carries a single material; a mesh whose materials
 * disagreed about which UV set to use could not be collapsed this way, so those are skipped
 * and reported rather than silently corrupted.
 */
function collapseToSingleUvChannel(root: THREE.Object3D): void {
  const channelZeroCopies = new Map<THREE.Texture, THREE.Texture>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];

    // Which UV channels does this mesh's texture set actually reference?
    const channels = new Set<number>();
    for (const material of materials) {
      const mat = material as TexturedMaterial;
      for (const slot of TEXTURE_SLOTS) {
        const texture = mat[slot];
        if (texture) channels.add(texture.channel ?? 0);
      }
    }

    if (channels.size === 0 || (channels.size === 1 && channels.has(0))) return;

    if (channels.size > 1) {
      console.warn(
        `[export-glb] Mesh "${child.name}" mixes UV channels ${[...channels].join(", ")}; ` +
          "leaving it as-is because collapsing would move some maps off their own UV set."
      );
      return;
    }

    const [sourceChannel] = [...channels];
    const geometry = child.geometry as THREE.BufferGeometry;
    const sourceAttribute = geometry.getAttribute(`uv${sourceChannel}`);

    if (!sourceAttribute) {
      console.warn(
        `[export-glb] Mesh "${child.name}" samples UV${sourceChannel} but has no matching ` +
          "attribute; leaving it as-is."
      );
      return;
    }

    geometry.setAttribute("uv", sourceAttribute.clone());

    for (const material of materials) {
      const mat = material as TexturedMaterial;
      for (const slot of TEXTURE_SLOTS) {
        const texture = mat[slot];
        if (!texture) continue;
        // Textures are still shared with the live scene (only materials were cloned), so
        // repoint a copy — mutating the original would move the editor's maps onto UV0.
        // One copy per source texture: the exporter relies on identity (e.g. roughnessMap ===
        // metalnessMap) to avoid re-packing a merged metal/rough image.
        let copy = channelZeroCopies.get(texture);
        if (!copy) {
          copy = texture.clone();
          copy.channel = 0;
          channelZeroCopies.set(texture, copy);
        }
        mat[slot] = copy;
      }
      material.needsUpdate = true;
    }
  });
}

/**
 * Verifies that no material still references a UV channel other than 0.
 *
 * Runs after `collapseToSingleUvChannel` as a build-time guard: a regression here is
 * invisible in Blender and only shows up as missing leather in After Effects, so it is worth
 * catching at export time rather than by eye. Reports every offender instead of throwing —
 * a mis-mapped texture is still a more useful download than no download at all.
 */
function reportRemainingUvChannels(root: THREE.Object3D): void {
  const offenders: string[] = [];

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      const mat = material as TexturedMaterial;
      const channels = new Set<number>();
      for (const slot of TEXTURE_SLOTS) {
        const texture = mat[slot];
        if (texture) channels.add(texture.channel ?? 0);
      }
      if (channels.size > 0 && !(channels.size === 1 && channels.has(0))) {
        offenders.push(`"${material.name || child.name}" -> UV ${[...channels].join(", ")}`);
      }
    }
  });

  if (offenders.length > 0) {
    console.warn(
      "[export-glb] These materials still sample a non-zero UV channel and will lose their " +
        `textures in After Effects: ${offenders.join("; ")}`
    );
  }
}

/**
 * Mirrors `applyBumperEmissiveShaderMask`: the bumper logo only shows where the object-space
 * normal points down the cue axis (smoothstep(-0.95, -0.85, normal.y) in the shader). The
 * midpoint of that ramp is the per-triangle cut-off used here.
 */
const BUMPER_FACE_NORMAL_Y = -0.9;

/** Folds `emissiveIntensity` into `emissive` so viewers without KHR_materials_emissive_strength agree. */
function foldEmissiveIntensity(mat: THREE.MeshStandardMaterial): void {
  if (mat.emissiveIntensity === 1) return;
  mat.emissive = mat.emissive.clone().multiplyScalar(mat.emissiveIntensity);
  mat.emissiveIntensity = 1;
}

/**
 * Rewrites a mesh's index so triangles passing `keep` form group 1 and the rest group 0.
 * Returns the triangle count of group 1 (0 = nothing matched, mesh untouched).
 */
function splitTrianglesByNormalY(mesh: THREE.Mesh, keep: (normalY: number) => boolean): number {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const normal = geometry.getAttribute("normal");
  const position = geometry.getAttribute("position");
  if (!normal || !position) return 0;

  const index = geometry.getIndex();
  const indexCount = index ? index.count : position.count;
  const vertexAt = (i: number): number => (index ? index.getX(i) : i);

  const rest: number[] = [];
  const kept: number[] = [];
  for (let i = 0; i + 2 < indexCount; i += 3) {
    const a = vertexAt(i);
    const b = vertexAt(i + 1);
    const c = vertexAt(i + 2);
    const normalY = (normal.getY(a) + normal.getY(b) + normal.getY(c)) / 3;
    (keep(normalY) ? kept : rest).push(a, b, c);
  }

  if (kept.length === 0) return 0;

  const merged = rest.concat(kept);
  const IndexArray = position.count > 65535 ? Uint32Array : Uint16Array;
  geometry.setIndex(new THREE.BufferAttribute(new IndexArray(merged), 1));
  geometry.clearGroups();
  if (rest.length > 0) geometry.addGroup(0, rest.length, 0);
  geometry.addGroup(rest.length, kept.length, 1);
  return kept.length / 3;
}

/**
 * Makes the engraved logos survive export.
 *
 * In the app the logo is an `emissiveMap`; on the bumper it is additionally masked by an
 * `onBeforeCompile` shader, because the bumper's UV1 places the logo's square over the side
 * wall as well as the flat end face (measured on the shipped models: ~34 end-face triangles vs
 * ~526 wall triangles inside the logo rect). glTF cannot carry that shader, so a naive export
 * smears the logo across the wall.
 *
 * The fix is to move the mask into geometry: the bumper is split into two primitives, the end
 * face keeping the logo material and the wall getting a logo-free copy. The joint has no shader
 * mask in the app, so its emissive logo exports as-is. Emissive intensity is folded into the
 * colour for viewers (After Effects) that ignore KHR_materials_emissive_strength.
 *
 * Returns the materials it created so the caller can dispose them.
 */
function bakeLogoMasksIntoGeometry(root: THREE.Object3D): THREE.Material[] {
  const created: THREE.Material[] = [];

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) return;

    const mat = child.material as THREE.MeshStandardMaterial;
    if (!mat.emissiveMap) return;

    const isBumper = isRubberMaterial(mat.name, child.name);
    const isJoint = !isBumper && (isTopCapFaceMaterial(mat.name) || isTopCapMaterial(mat.name, child.name));
    if (!isBumper && !isJoint) return;

    foldEmissiveIntensity(mat);
    // The clone has already lost the shader hook; make sure nothing re-installs it.
    mat.onBeforeCompile = () => {};
    mat.needsUpdate = true;

    if (!isBumper) return;

    const faceTriangles = splitTrianglesByNormalY(child, (y) => y < BUMPER_FACE_NORMAL_Y);
    if (faceTriangles === 0) {
      // No end face found — a logo smeared over the wall is worse than none.
      console.warn(`[export-glb] Bumper "${child.name}" has no end face; exporting it without a logo.`);
      mat.emissiveMap = null;
      mat.emissive = new THREE.Color(0x000000);
      return;
    }

    const wall = mat.clone();
    wall.emissiveMap = null;
    wall.emissive = new THREE.Color(0x000000);
    created.push(wall);

    mat.name = `${mat.name} Logo`;
    child.material = [wall, mat];
  });

  return created;
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
  const { lights = [], camera = null, maxTextureSize = FULL_QUALITY_TEXTURE_SIZE, binary = true } = options;

  // Export a detached copy: GLTFExporter walks parents for world transforms, and we
  // want the cue centred on its own origin rather than wherever the studio put it.
  const root = new THREE.Group();
  root.name = "CueModel";

  const clone = model.clone(true);
  clone.position.set(0, 0, 0);
  clone.rotation.set(0, 0, 0);
  clone.scale.setScalar(1);
  root.add(clone);

  // `Object3D.clone()` shares both material and geometry instances with the source, so the
  // texture swaps and the UV rewrite below would otherwise reach into the live editor scene —
  // repointing its maps at baked copies that get disposed the moment the export finishes, and
  // overwriting its `uv` attribute. Give the export its own materials and geometry.
  const clonedMaterials: THREE.Material[] = [];
  const clonedGeometries: THREE.BufferGeometry[] = [];
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const geometry = child.geometry.clone();
    clonedGeometries.push(geometry);
    child.geometry = geometry;

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

  // After Effects' glTF importer only reads TEXCOORD_0, so fold everything onto UV0 before
  // the exporter writes any `texCoord` values.
  collapseToSingleUvChannel(clone);
  reportRemainingUvChannels(clone);

  // Carry the engraved logos into the file as plain glTF geometry + emissive maps.
  clonedMaterials.push(...bakeLogoMasksIntoGeometry(clone));

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
    clonedGeometries.forEach((geometry) => geometry.dispose());
  }
}

/** Strips characters that are unsafe in file names across Windows/macOS. */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_ ]/g, "_").trim() || "cue";
}
