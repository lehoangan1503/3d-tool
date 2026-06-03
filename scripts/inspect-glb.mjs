import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const path = process.argv[2];
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(path);
const root = doc.getRoot();

console.log(`\n=== ${path} ===`);
console.log("Nodes:");
for (const n of root.listNodes()) {
  const mesh = n.getMesh();
  console.log(`  node "${n.getName()}" mesh=${mesh ? `"${mesh.getName()}"` : "none"} T=${n.getTranslation().map(v=>v.toFixed(2))}`);
}
console.log("Meshes:");
for (const m of root.listMeshes()) {
  const prims = m.listPrimitives();
  console.log(`  mesh "${m.getName()}" prims=${prims.length}`);
  for (const p of prims) {
    const mat = p.getMaterial();
    const pos = p.getAttribute("POSITION");
    console.log(`    prim verts=${pos?.getCount()} mat="${mat?.getName()}" baseColorTex=${mat?.getBaseColorTexture() ? "yes" : "no"}`);
  }
}
console.log("Materials:");
for (const mat of root.listMaterials()) {
  console.log(`  mat "${mat.getName()}" baseColorTex=${mat.getBaseColorTexture()?.getName() ?? "none"}`);
}
console.log("Textures:");
for (const tex of root.listTextures()) {
  console.log(`  tex "${tex.getName()}" mime=${tex.getMimeType()} size=${tex.getImage()?.byteLength}`);
}
