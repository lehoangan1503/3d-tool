/**
 * Bakes a contact shadow into a texture and returns it as a ground plane mesh.
 *
 * Real-time shadows live in the renderer, not in the model — a .glb has nowhere to store
 * "this light casts that shadow". Any viewer that opens the exported file supplies its
 * own lighting, so the cue would arrive floating with no contact with the ground.
 *
 * The fix is to turn the shadow into geometry + texture, which glTF *can* carry: render
 * the model from directly below into an off-screen target, blur the resulting silhouette,
 * and map it onto a transparent unlit plane sitting at the model's feet. The result looks
 * like a soft drop shadow in every viewer, with no lights required.
 *
 * This is an approximation of a downward-cast shadow, not a light-accurate render of the
 * studio's HDRI-driven shadows. It is intended to keep the exported model grounded.
 */

import * as THREE from "three";

export interface ShadowBakeOptions {
  /** Resolution of the baked shadow texture. Default 1024. */
  resolution?: number;
  /** Blur radius in pixels applied to the silhouette. Default 12. */
  blur?: number;
  /** Peak opacity of the shadow directly under the model. Default 0.55. */
  opacity?: number;
  /** Extra margin around the model's footprint, as a fraction of its size. Default 0.35. */
  padding?: number;
}

/**
 * Renders `model` from below into a canvas, producing a soft grayscale silhouette.
 * Returns the blurred canvas, or null when the model has no measurable footprint.
 */
function renderSilhouette(
  model: THREE.Object3D,
  box: THREE.Box3,
  resolution: number,
  blur: number
): HTMLCanvasElement | null {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  if (size.x <= 0 || size.z <= 0) return null;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(resolution, resolution);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();

  // Flat black stand-in for every material: we only want the outline, and unlit black
  // keeps the silhouette independent of the cue's own colours and lighting.
  const silhouette = model.clone(true);
  const overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  silhouette.traverse((child) => {
    if (child instanceof THREE.Mesh) child.material = overrideMaterial;
  });
  scene.add(silhouette);

  // Orthographic camera looking straight up from under the model, so the silhouette is a
  // true plan view with no perspective spread.
  const half = Math.max(size.x, size.z) / 2;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, size.y * 4 + 10);
  camera.position.set(center.x, box.min.y - 1, center.z);
  camera.up.set(0, 0, -1);
  camera.lookAt(center.x, box.max.y, center.z);

  renderer.render(scene, camera);

  const raw = document.createElement("canvas");
  raw.width = resolution;
  raw.height = resolution;
  const rawCtx = raw.getContext("2d");
  if (!rawCtx) {
    renderer.dispose();
    overrideMaterial.dispose();
    return null;
  }
  rawCtx.drawImage(renderer.domElement, 0, 0);

  renderer.dispose();
  overrideMaterial.dispose();

  // Blur the hard silhouette into a soft shadow. Drawing the source twice through a
  // blur filter gives a denser core than a single pass, which reads more like contact
  // shadow falloff than a uniform smudge.
  const blurred = document.createElement("canvas");
  blurred.width = resolution;
  blurred.height = resolution;
  const ctx = blurred.getContext("2d");
  if (!ctx) return null;

  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(raw, 0, 0);
  ctx.drawImage(raw, 0, 0);
  ctx.filter = "none";

  return blurred;
}

/**
 * Builds a shadow-plane mesh for `model`, positioned just under its lowest point.
 *
 * The returned mesh uses an unlit transparent material so it renders identically in any
 * viewer. Returns null when the model is empty or a WebGL context is unavailable.
 */
export function bakeShadowPlane(
  model: THREE.Object3D,
  options: ShadowBakeOptions = {}
): THREE.Mesh | null {
  const { resolution = 1024, blur = 12, opacity = 0.55, padding = 0.35 } = options;

  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return null;

  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = renderSilhouette(model, box, resolution, blur);
  } catch {
    // A failed shadow bake must never fail the whole export.
    return null;
  }
  if (!canvas) return null;

  // Convert the black-on-transparent silhouette into a white shadow mask whose alpha
  // carries the darkness, so the plane can be tinted black and blended normally.
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "BakedContactShadow";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const extent = Math.max(size.x, size.z) * (1 + padding);

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Multiply-style darkening without needing a custom blend mode, so it survives glTF.
    color: 0xffffff,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(extent, extent), material);
  mesh.name = "ContactShadow";
  mesh.rotation.x = -Math.PI / 2;
  // A hair below the model so it never z-fights with the cue's own geometry.
  mesh.position.set(center.x, box.min.y - size.y * 0.002, center.z);

  return mesh;
}
