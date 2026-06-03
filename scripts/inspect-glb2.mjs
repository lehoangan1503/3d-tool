import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const path = process.argv[2];
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(path);
const root = doc.getRoot();
console.log(`\n=== ${path} ===`);
for (const n of root.listNodes()) {
  const mesh = n.getMesh();
  if (!mesh) continue;
  for (const p of mesh.listPrimitives()) {
    const mat = p.getMaterial();
    const semantics = p.listSemantics();
    const pos = p.getAttribute("POSITION");
    // bbox
    let min=[1e9,1e9,1e9], max=[-1e9,-1e9,-1e9];
    const el=[];
    for (let i=0;i<pos.getCount();i++){pos.getElement(i,el);for(let k=0;k<3;k++){if(el[k]<min[k])min[k]=el[k];if(el[k]>max[k])max[k]=el[k];}}
    const uv = p.getAttribute("TEXCOORD_0");
    let uvinfo="none";
    if(uv){let umin=[1e9,1e9],umax=[-1e9,-1e9];const e=[];for(let i=0;i<Math.min(uv.getCount(),50000);i++){uv.getElement(i,e);for(let k=0;k<2;k++){if(e[k]<umin[k])umin[k]=e[k];if(e[k]>umax[k])umax[k]=e[k];}}uvinfo=`U[${umin[0].toFixed(2)},${umax[0].toFixed(2)}] V[${umin[1].toFixed(2)},${umax[1].toFixed(2)}]`;}
    console.log(`node "${n.getName()}" mesh "${mesh.getName()}" mat "${mat?.getName()}"`);
    console.log(`  T=${n.getTranslation().map(v=>v.toFixed(1))} S=${n.getScale().map(v=>v.toFixed(3))}`);
    console.log(`  semantics: ${semantics.join(",")}`);
    console.log(`  localBBox min=${min.map(v=>v.toFixed(1))} max=${max.map(v=>v.toFixed(1))}`);
    console.log(`  UV: ${uvinfo}`);
    if(mat){console.log(`  mat metalness=${mat.getMetallicFactor()} rough=${mat.getRoughnessFactor()} baseColor=${mat.getBaseColorFactor().map(v=>v.toFixed(2))} alphaMode=${mat.getAlphaMode()} doubleSided=${mat.getDoubleSided()}`);}
  }
}
