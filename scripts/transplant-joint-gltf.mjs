#!/usr/bin/env node
/**
 * transplant-joint-gltf.mjs
 *
 * Replaces the joint-cover mesh of a destination GLB with the joint-cover mesh
 * from a (known-good) source GLB, operating entirely at the glTF level so the
 * source joint geometry + normals are preserved byte-for-byte — no Blender round
 * trip that could alter custom normals.
 *
 * The source file is only READ. Output is written to a new path.
 *
 * Usage:
 *   node scripts/transplant-joint-gltf.mjs <dest.glb> <source.glb> <output.glb>
 *
 * Both files must have a node named "AI_CUE_joint_cover". Only that node's mesh
 * (with its material/accessors/textures) is swapped in; the destination node's
 * placement is preserved, with a vertical (Y, glTF is Y-up) re-align so the new
 * joint's base sits where the old joint's base was.
 */

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { copyToDocument, prune } from "@gltf-transform/functions";

const [destPath, srcPath, outPath] = process.argv.slice(2);
if (!destPath || !srcPath || !outPath) {
  console.error("Usage: node scripts/transplant-joint-gltf.mjs <dest.glb> <source.glb> <output.glb>");
  process.exit(1);
}

const JOINT = "AI_CUE_joint_cover";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const dest = await io.read(destPath);
const src = await io.read(srcPath);

const findJoint = (doc) => doc.getRoot().listNodes().find((n) => n.getName() === JOINT);
const destJoint = findJoint(dest);
const srcJoint = findJoint(src);
if (!destJoint) throw new Error(`No "${JOINT}" node in dest ${destPath}`);
if (!srcJoint) throw new Error(`No "${JOINT}" node in source ${srcPath}`);

const srcMesh = srcJoint.getMesh();
if (!srcMesh) throw new Error("Source joint node has no mesh");
const destMesh = destJoint.getMesh();

function meshLocalMinY(mesh) {
  let minY = Infinity;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    if (!pos) continue;
    const el = [];
    for (let i = 0; i < pos.getCount(); i++) {
      const y = pos.getElement(i, el)[1];
      if (y < minY) minY = y;
    }
  }
  return minY;
}

const destNodeTY = destJoint.getTranslation()[1];
const destWorldMinY = destNodeTY + (destMesh ? meshLocalMinY(destMesh) : 0);
const srcLocalMinY = meshLocalMinY(srcMesh);
console.log(`[transplant] dest joint world base Y=${destWorldMinY.toFixed(2)} (node T.y=${destNodeTY.toFixed(2)})`);
console.log(`[transplant] src  joint mesh localMinY=${srcLocalMinY.toFixed(2)}`);

// Copy ONLY the source joint mesh (pulls in its material/accessors/textures) into dest.
const map = copyToDocument(dest, src, [srcMesh]);
const mergedMesh = map.get(srcMesh);
if (!mergedMesh) throw new Error("copyToDocument did not return the mesh mapping");

// Swap the destination joint's mesh for the clean one.
destJoint.setMesh(mergedMesh);

// Re-align vertically so the new joint base matches the old base.
const newWorldMinY = destNodeTY + srcLocalMinY;
const dy = destWorldMinY - newWorldMinY;
if (Math.abs(dy) > 1e-4) {
  const t = destJoint.getTranslation();
  destJoint.setTranslation([t[0], t[1] + dy, t[2]]);
  console.log(`[transplant] shifted joint node T.y by ${dy.toFixed(3)} to keep base aligned`);
}

// Drop the now-orphaned old joint mesh + any unused resources.
// IMPORTANT: keepAttributes/keepIndices/keepLeaves preserve vertex data that
// prune() would otherwise strip. The body ("outside") and leather meshes carry
// UV sets (TEXCOORD_0/1) that no *GLB-level* material references — the surface
// (surface.jpg) and leather textures are bound at RUNTIME in the viewer. Default
// prune() treats those UVs as unused and deletes them, which leaves the body
// with no texture coords so surface.jpg can't map (renders blank). Keep them.
await dest.transform(
  prune({
    keepAttributes: true,
    keepIndices: true,
    keepLeaves: true,
  })
);

// copyToDocument brought in the source's buffer; a GLB must have exactly one.
// Reassign every accessor to the first buffer, then drop the extras.
const buffers = dest.getRoot().listBuffers();
if (buffers.length > 1) {
  const main = buffers[0];
  for (const acc of dest.getRoot().listAccessors()) {
    acc.setBuffer(main);
  }
  for (const b of buffers.slice(1)) b.dispose();
  console.log(`[transplant] consolidated ${buffers.length} buffers into 1`);
}

await io.write(outPath, dest);
console.log(`\n✅ Wrote ${outPath} — clean joint transplanted at glTF level (source untouched).`);
