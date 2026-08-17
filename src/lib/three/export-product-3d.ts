/**
 * Packages a product's 3D model for download.
 *
 * A single `.glb` carries the geometry and every PBR texture (leather included), but glTF
 * has no slot for an environment map and no way to store a real-time shadow. To make the
 * download match what the customizer shows on screen, we ship a small bundle instead:
 *
 *   Product Name.glb            model + all textures, embedded
 *   environment.hdr             the HDRI the editor was using (optional)
 *   README.txt                  how to reproduce the web lighting
 *
 * When `shadow` is enabled, a baked contact-shadow plane is merged into the .glb so the
 * cue still looks grounded in viewers that provide no lighting of their own.
 */

import * as THREE from "three";
import JSZip from "jszip";
import { exportModelToGlb, safeFileName } from "./export-glb";
import { bakeShadowPlane } from "./bake-shadow-plane";
import { buildLightRigFromHdri } from "./hdri-to-lights";

export interface ProductGlbExportOptions {
  /** Bake a contact-shadow plane into the model. Default true. */
  shadow?: boolean;
  /** HDRI filename (as served from /hdri/) to include in the bundle. */
  hdriFile?: string | null;
  /** Largest texture edge to write. Default 4096. */
  maxTextureSize?: number;
  /**
   * Fit a `KHR_lights_punctual` rig to `hdriFile` and embed it in the .glb, so the model
   * arrives lit in viewers that supply no environment of their own. Default false.
   */
  embedLights?: boolean;
  /** Y-rotation of the environment in degrees, so the baked rig matches the editor. */
  hdriRotationY?: number;
  /** Camera to embed, giving the file the same default framing as the editor. */
  camera?: THREE.Camera | null;
}

export interface ProductGlbResult {
  /** The .glb on its own — useful when the caller wants to zip many products together. */
  glb: Blob;
  /** The HDRI bytes, when one was requested and fetched successfully. */
  hdri: { fileName: string; blob: Blob } | null;
}

const README = `Cue 3D Model Export
===================

Files
-----
- *.glb            The 3D model. Contains all geometry, leather/wrap textures,
                   joint and bumper materials, and any engraved logo maps.
- environment.hdr  The HDRI used for lighting in the web customizer. Only present
                   when the export was made with the HDRI option enabled.

Why the model may look flat when you open it
--------------------------------------------
glTF/GLB stores materials, not lighting. The metallic sheen and reflections you see
on the website come from an HDRI environment map applied by the web viewer, which
the format cannot store inside the model file. Load "environment.hdr" as the world
/ environment texture in your software and the look will match.

Blender:  World Properties > Color > Environment Texture > open environment.hdr
Three.js: RGBELoader + PMREMGenerator -> scene.environment
Unity:    Lighting > Environment > Skybox Material (from the HDRI)

About the shadow
----------------
Real-time shadows are computed by the renderer from its lights and cannot be stored
in a GLB either. If this export includes a "ContactShadow" plane, that is a baked
soft shadow rendered as a transparent texture, so the model stays grounded in any
viewer. Delete that object if you plan to light the scene yourself.
`;

/**
 * Builds the .glb (and optional HDRI) for one already-loaded model.
 *
 * `model` should be the configured cue — typically `ExtractorSceneManager.getModelClone()`
 * or `SceneManager.getModelForClone()`, both of which return a fully-textured tree.
 */
export async function buildProductGlb(
  model: THREE.Object3D,
  options: ProductGlbExportOptions = {}
): Promise<ProductGlbResult> {
  const {
    shadow = true,
    hdriFile = null,
    maxTextureSize = 4096,
    embedLights = false,
    hdriRotationY = 0,
    camera = null,
  } = options;

  // The shadow plane is parented to a wrapper alongside the cue so the exporter writes
  // both as siblings, leaving the cue's own transform untouched.
  let exportRoot: THREE.Object3D = model;
  let shadowMesh: THREE.Mesh | null = null;

  if (shadow) {
    shadowMesh = bakeShadowPlane(model);
    if (shadowMesh) {
      const wrapper = new THREE.Group();
      wrapper.name = "CueWithShadow";
      wrapper.add(model.clone(true));
      wrapper.add(shadowMesh);
      exportRoot = wrapper;
    }
  }

  // Fitting the rig means decoding the HDRI, so only pay for it when it will be embedded.
  const lights =
    embedLights && hdriFile && !hdriFile.startsWith("__")
      ? await buildLightRigFromHdri(`/hdri/${encodeURIComponent(hdriFile)}`, {
          rotationY: hdriRotationY,
        })
      : [];

  const glb = await exportModelToGlb(exportRoot, { maxTextureSize, lights, camera });

  if (shadowMesh) {
    shadowMesh.geometry.dispose();
    const material = shadowMesh.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    material.dispose();
  }

  let hdri: ProductGlbResult["hdri"] = null;
  if (hdriFile && !hdriFile.startsWith("__")) {
    try {
      const response = await fetch(`/hdri/${encodeURIComponent(hdriFile)}`);
      if (response.ok) {
        hdri = { fileName: hdriFile, blob: await response.blob() };
      }
    } catch {
      // An unavailable HDRI must not fail the model export.
    }
  }

  return { glb, hdri };
}

/**
 * Bundles many products into one .zip, one folder per product.
 * The HDRI is written once at the root since it is shared across products.
 */
export async function zipManyProducts(
  entries: Array<{ name: string; result: ProductGlbResult }>
): Promise<Blob> {
  const zip = new JSZip();
  const used = new Set<string>();
  let sharedHdri: Blob | null = null;

  for (const entry of entries) {
    let folder = safeFileName(entry.name);
    // Two products may legitimately share a name; keep both rather than overwriting.
    let suffix = 2;
    while (used.has(folder)) folder = `${safeFileName(entry.name)}_${suffix++}`;
    used.add(folder);

    zip.file(`${folder}/${folder}.glb`, entry.result.glb);
    if (entry.result.hdri && !sharedHdri) sharedHdri = entry.result.hdri.blob;
  }

  if (sharedHdri) zip.file("environment.hdr", sharedHdri);
  zip.file("README.txt", README);

  // STORE: .glb payloads are already-compressed textures, so DEFLATE costs time for ~0 gain.
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

/** Triggers a browser download for `blob`. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so the download has committed to the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
