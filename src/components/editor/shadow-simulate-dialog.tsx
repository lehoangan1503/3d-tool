"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import type { CueShadowConfig } from "@/types/extractor";
import type { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { createLShapedShadowMesh } from "@/lib/three/studio-background";
import { Save, Lightbulb, Palette } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SimScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  shadowLight: THREE.DirectionalLight;
  lightSphere: THREE.Mesh;
  cameraGizmo: THREE.Group;
  recordingCam: THREE.PerspectiveCamera;
  camHelper: THREE.CameraHelper;
  modelClone: THREE.Object3D | null;
  floorBase: THREE.Mesh;
  wallBase: THREE.Mesh;
  lShapeShadow: THREE.Mesh;  // Single L-shaped shadow mesh for seamless wall+floor shadow
  animFrameId: number | null;
  isDisposed: boolean;
}

// Studio dimensions matching ExtractorSceneManager.FRAME_STUDIO_* constants
const STUDIO_WIDTH = 36;
const STUDIO_WALL_HEIGHT = 24;
const STUDIO_FLOOR_DEPTH = 14;
const STUDIO_CORNER_Y = -1.18;
const STUDIO_WALL_Z = -3;

interface ShadowSimulateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shadowConfig: CueShadowConfig;
  onConfigChange: (cfg: CueShadowConfig) => void;
  onSave: (cfg: CueShadowConfig) => void;
  extractorRef: React.MutableRefObject<ExtractorSceneManager | null>;
  /** Frame camera/model settings so the preview matches the final output 1:1 */
  cueSettings: { phi: number; zoom: number; offsetX: number; offsetY: number; spinY: number };
  /** Optional callback when camera position is changed via gizmo */
  onCameraChange?: (phi: number, zoom: number) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a MeshBasicMaterial that can be either solid-color or a canvas gradient. */
function makeStudioMat(colorHex: string, gradientEnd?: string): THREE.MeshBasicMaterial {
  if (gradientEnd) {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, colorHex);
    grad.addColorStop(1, gradientEnd);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(canvas);
    return new THREE.MeshBasicMaterial({ map: tex });
  }
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex) });
}

/** Update an existing MeshBasicMaterial in-place with new color / gradient. */
function applyStudioColor(mat: THREE.MeshBasicMaterial, colorHex: string, gradientEnd?: string): void {
  if (gradientEnd) {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, colorHex);
    grad.addColorStop(1, gradientEnd);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    if (mat.map) mat.map.dispose();
    mat.map = new THREE.CanvasTexture(canvas);
    mat.color.set(0xffffff);
  } else {
    if (mat.map) { mat.map.dispose(); mat.map = null; }
    mat.color.set(new THREE.Color(colorHex));
  }
  mat.needsUpdate = true;
}

/** Walk parent chain to find which selectable root object belongs to. */
function findSelectableRoot(
  obj: THREE.Object3D,
  roots: THREE.Object3D[]
): THREE.Object3D | null {
  let node: THREE.Object3D | null = obj;
  while (node) {
    if (roots.includes(node)) return node;
    node = node.parent;
  }
  return null;
}

// ─── Main Component ───────────────────────────────────────────────────────────

/** Studio scale multiplier — matches video studio model scale */
const SCALE = 7;

export function ShadowSimulateDialog({
  open,
  onOpenChange,
  shadowConfig,
  onConfigChange,
  onSave,
  extractorRef,
  cueSettings,
  onCameraChange,
}: ShadowSimulateDialogProps) {
  const simContainerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<SimScene | null>(null);

  const onConfigChangeRef = useRef(onConfigChange);
  useEffect(() => { onConfigChangeRef.current = onConfigChange; }, [onConfigChange]);

  const onCameraChangeRef = useRef(onCameraChange);
  useEffect(() => { onCameraChangeRef.current = onCameraChange; }, [onCameraChange]);

  const [localCfg, setLocalCfg] = useState<CueShadowConfig>(() => ({ ...shadowConfig }));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const setPreviewUrlRef = useRef(setPreviewUrl);
  useEffect(() => { setPreviewUrlRef.current = setPreviewUrl; }, []);
  const [showGradient, setShowGradient] = useState(false);
  const [activeSelect, setActiveSelect] = useState<"light" | "camera" | "cue" | null>(null);
  const [activeHotkeyText, setActiveHotkeyText] = useState<string | null>(null);
  const [activeHotkeyAxis, setActiveHotkeyAxisState] = useState<"x" | "y" | "z" | null>(null);
  const setActiveHotkeyAxisRef = useRef(setActiveHotkeyAxisState);
  useEffect(() => { setActiveHotkeyAxisRef.current = setActiveHotkeyAxisState; }, []);

  // Sync localCfg when dialog opens
  useEffect(() => {
    if (open) {
      setLocalCfg({ ...shadowConfig });
      setShowGradient(!!shadowConfig.wallGradientEnd);
      setActiveSelect(null);
      setActiveHotkeyText(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ─── Build / destroy Three.js simulation scene ──────────────────────────────
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let rafId: number;
    let simObj: SimScene | null = null;

    const doInit = (container: HTMLDivElement) => {
      extractorRef.current?.startLivePreview?.();

      const W = container.clientWidth;
      const H = container.clientHeight;

      // ── Renderer ──────────────────────────────────────────────────────────────
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(W, H);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.3;
      renderer.domElement.style.cssText =
        "display:block;position:absolute;top:0;left:0;width:100%;height:100%;";
      container.appendChild(renderer.domElement);

      // ── Scene ─────────────────────────────────────────────────────────────────
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xd4d4d4);

      // ── God camera — orbitable view of the whole scene ────────────────────────
      const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 500);
      camera.position.set(0, 6, 22);
      camera.lookAt(0, 3, 0);

      // OrbitControls
      const orbitControls = new OrbitControls(camera, renderer.domElement);
      orbitControls.target.set(0, 3, 0);
      orbitControls.enableDamping = true;
      orbitControls.dampingFactor = 0.1;
      orbitControls.minDistance = 4;
      orbitControls.maxDistance = 80;
      orbitControls.maxPolarAngle = Math.PI * 0.85;

      // ── Lighting ─────────────────────────────────────────────────────────────
      const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 2.0);
      scene.add(hemi);

      const cfg = shadowConfig;
      const shadowLight = new THREE.DirectionalLight(0xfffdf5, 0);
      shadowLight.castShadow = true;
      shadowLight.shadow.mapSize.set(4096, 4096);
      shadowLight.shadow.camera.near = 0.5;
      shadowLight.shadow.camera.far = 150;
      shadowLight.shadow.camera.left = -25;
      shadowLight.shadow.camera.right = 25;
      shadowLight.shadow.camera.top = 25;
      shadowLight.shadow.camera.bottom = -25;
      shadowLight.shadow.bias = 0.0001;
      shadowLight.shadow.normalBias = 0.02;
      shadowLight.shadow.radius = cfg.blur;
      shadowLight.target.position.set(0, 0, 0);
      scene.add(shadowLight);
      scene.add(shadowLight.target);

      // ── Studio surfaces — match extractor L-shaped shadow dimensions × SCALE ───
      const wallColor = cfg.wallColor ?? "#ffffff";
      const wallGradientEnd = cfg.wallGradientEnd;

      // Use shared constants × SCALE for positions
      const wallWidth = STUDIO_WIDTH * SCALE;
      const wallHeight = STUDIO_WALL_HEIGHT * SCALE;
      const floorDepth = STUDIO_FLOOR_DEPTH * SCALE;
      const cornerY = STUDIO_CORNER_Y * SCALE;
      const wallZ = STUDIO_WALL_Z * SCALE;

      // Floor base: white plane behind L-shaped shadow
      const floorBase = new THREE.Mesh(
        new THREE.PlaneGeometry(wallWidth, floorDepth),
        makeStudioMat(wallColor, wallGradientEnd)
      );
      floorBase.rotation.x = -Math.PI / 2;
      floorBase.position.set(0, cornerY - 0.002, wallZ + floorDepth / 2);
      scene.add(floorBase);

      // Wall base: white plane behind L-shaped shadow
      const wallBase = new THREE.Mesh(
        new THREE.PlaneGeometry(wallWidth, wallHeight),
        makeStudioMat(wallColor, wallGradientEnd)
      );
      wallBase.position.set(0, cornerY + wallHeight / 2, wallZ - 0.002);
      scene.add(wallBase);

      // Single L-shaped shadow mesh (replaces separate floor/wall shadows)
      const lShapeShadow = createLShapedShadowMesh(
        STUDIO_WIDTH,
        STUDIO_WALL_HEIGHT,
        STUDIO_FLOOR_DEPTH,
        STUDIO_CORNER_Y,
        STUDIO_WALL_Z,
        cfg.intensity
      );
      lShapeShadow.scale.setScalar(SCALE);
      scene.add(lShapeShadow);

      // ── Cue model at studio scale ─────────────────────────────────────────────
      const modelClone: THREE.Object3D | null = extractorRef.current?.getModelClone?.() ?? null;
      if (modelClone) {
        modelClone.scale.setScalar(SCALE);
        modelClone.position.set(0, 0, 0);
        modelClone.userData.selectType = "cue";
        modelClone.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = false;
            child.userData.selectType = "cue";
          }
        });
        // Apply frame's model rotation and offset (so preview matches final output)
        modelClone.rotation.y = cueSettings.spinY;
        modelClone.position.set(cueSettings.offsetX * SCALE, cueSettings.offsetY * SCALE, 0);
        scene.add(modelClone);
      }

      // ── Load HDRI from extractor into this scene (same renderer context) ──────
      const hdriUrl = extractorRef.current?.getCurrentHdriUrl?.();
      if (hdriUrl) {
        const pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        new RGBELoader().load(hdriUrl, (tex) => {
          if (cancelled) { tex.dispose(); pmrem.dispose(); return; }
          tex.mapping = THREE.EquirectangularReflectionMapping;
          const rt = pmrem.fromEquirectangular(tex);
          scene.environment = rt.texture;
          tex.dispose();
          pmrem.dispose();
        });
      }

      // ── RecordingCam — fixed to frame's camera settings (1:1 with extractor) ──
      // Extractor: camera at y=2*cos(phi), z=2*sin(phi) looking at (offsetX, offsetY, 0)
      // Simulator at SCALE: y×SCALE, z×SCALE, lookAt (offsetX×SCALE, offsetY×SCALE, 0)
      const clampedPhi = Math.max(0.1, Math.min(Math.PI - 0.1, cueSettings.phi));
      const camDist = 2; // extractor fixed distance
      const camY = camDist * Math.cos(clampedPhi) * SCALE;
      const camZ = camDist * Math.sin(clampedPhi) * SCALE;
      const camFov = 50 / Math.max(0.1, cueSettings.zoom);
      const camLookAt = new THREE.Vector3(
        cueSettings.offsetX * SCALE,
        cueSettings.offsetY * SCALE,
        0
      );

      // Camera gizmo shown for reference at recording cam position
      const cameraGizmo = new THREE.Group();
      cameraGizmo.userData.selectType = "camera";
      const camBody = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.45, 0.45),
        new THREE.MeshStandardMaterial({ color: 0xff6600, emissive: 0xff3300, emissiveIntensity: 0.4 })
      );
      camBody.userData.selectType = "camera";
      cameraGizmo.add(camBody);
      const camLens = new THREE.Mesh(
        new THREE.ConeGeometry(0.3, 0.5, 4),
        new THREE.MeshStandardMaterial({ color: 0xff9933, emissive: 0xff6600, emissiveIntensity: 0.3 })
      );
      camLens.rotation.x = Math.PI / 2;
      camLens.position.z = 0.45;
      camLens.userData.selectType = "camera";
      cameraGizmo.add(camLens);
      cameraGizmo.position.set(0, camY, camZ);
      cameraGizmo.lookAt(camLookAt);
      scene.add(cameraGizmo);

      // RecordingCam locked to frame camera — NOT user-controllable
      const recordingCam = new THREE.PerspectiveCamera(camFov, 1, 0.5, 100);
      recordingCam.position.set(0, camY, camZ);
      recordingCam.lookAt(camLookAt);
      recordingCam.updateProjectionMatrix();
      recordingCam.updateMatrixWorld(true);
      const camHelper = new THREE.CameraHelper(recordingCam);
      scene.add(camHelper);

      const syncCameraFromGizmo = () => {
        // Update recording camera to match gizmo position
        recordingCam.position.copy(cameraGizmo.position);
        // Recompute lookAt to maintain focus on model center
        const lookTarget = new THREE.Vector3(
          cueSettings.offsetX * SCALE,
          cueSettings.offsetY * SCALE,
          0
        );
        recordingCam.lookAt(lookTarget);
        cameraGizmo.lookAt(lookTarget);
        recordingCam.updateProjectionMatrix();
        camHelper.update();

        // Derive new phi from camera position
        const camY = cameraGizmo.position.y / SCALE;
        const camZ = cameraGizmo.position.z / SCALE;
        const dist = Math.sqrt(camY * camY + camZ * camZ);
        if (dist < 0.001) return; // Avoid division by zero at origin
        const newPhi = Math.acos(Math.max(-1, Math.min(1, camY / dist)));
        // Derive zoom from distance change (original dist was 2)
        const newZoom = 2 / dist;

        // Notify parent of camera changes
        if (onCameraChangeRef.current) {
          onCameraChangeRef.current(newPhi, newZoom);
        }
      };

      // ── Light sphere ──────────────────────────────────────────────────────────
      const lightSphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 24, 24),
        new THREE.MeshStandardMaterial({
          color: 0xffcc00, emissive: 0xff8800, emissiveIntensity: 1.2,
          roughness: 0.2, metalness: 0.1,
        })
      );
      lightSphere.userData.selectType = "light";
      lightSphere.name = "lightSphere";
      scene.add(lightSphere);
      lightSphere.add(new THREE.Mesh(
        new THREE.SphereGeometry(0.9, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
      ));
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -300, 0),
      ]);
      lightSphere.add(new THREE.Line(lineGeo,
        new THREE.LineBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.3 })
      ));

      // ── TransformControls ──────────────────────────────────────────────────────
      const transformControls = new TransformControls(camera, renderer.domElement);
      transformControls.setMode("translate");
      transformControls.setSize(0.8);
      scene.add(transformControls.getHelper());

      transformControls.addEventListener("dragging-changed", (event: { value: unknown }) => {
        orbitControls.enabled = !event.value;
      });

      transformControls.addEventListener("objectChange", () => {
        if (selectedType === "light") syncLightPos();
        if (selectedType === "camera") syncCameraFromGizmo();
      });

      const setAxisLock = (axis: "x" | "y" | "z") => {
        transformControls.showX = axis === "x";
        transformControls.showY = axis === "y";
        transformControls.showZ = axis === "z";
      };
      const resetAxisLock = () => {
        transformControls.showX = true;
        transformControls.showY = true;
        transformControls.showZ = true;
      };

      // ── Selection + Blender-style G/R/S hotkeys ────────────────────────────────
      // All gizmos are now selectable and controllable
      const selectableRoots: THREE.Object3D[] = [
        lightSphere, cameraGizmo, ...(modelClone ? [modelClone] : []),
      ];

      let selectedObj: THREE.Object3D | null = null;
      let selectedType: "light" | "camera" | "cue" | null = null;

      let activeHotkey: "g" | "r" | "s" | null = null;
      let hotkeyAxisLock: "x" | "y" | "z" | null = null;
      let hotkeyDragging = false;
      let hotkeyStartX = 0;
      let hotkeyStartY = 0;
      const hotkeyOrigPos = new THREE.Vector3();
      const hotkeyOrigRot = new THREE.Euler();
      const hotkeyOrigScl = new THREE.Vector3();

      const syncLightPos = () => {
        const { x, y, z } = lightSphere.position;
        const cx = Math.max(-80, Math.min(80, x));
        const cy = Math.max(-SCALE * 5, Math.min(150, y));  // allow below cue
        const cz = Math.max(-80, Math.min(80, z));
        if (cx !== x || cy !== y || cz !== z) lightSphere.position.set(cx, cy, cz);
        shadowLight.position.set(cx, cy, cz);
        shadowLight.shadow.camera.updateProjectionMatrix();
        setLocalCfg(prev => {
          const next = { ...prev, lightX: cx / SCALE, lightY: cy / SCALE, lightZ: cz / SCALE };
          setTimeout(() => onConfigChangeRef.current(next), 0);
          return next;
        });
      };

      const selectObject = (
        obj: THREE.Object3D | null,
        type: "light" | "camera" | "cue" | null
      ) => {
        selectedObj = obj;
        selectedType = type;
        if (obj) {
          transformControls.attach(obj);
          transformControls.enabled = true;
          transformControls.setMode("translate");
          resetAxisLock();
        } else {
          transformControls.detach();
        }
        setActiveSelect(type);
        setActiveHotkeyText(null);
        setActiveHotkeyAxisRef.current(null);
      };

      const buildHotkeyText = (hk: "g" | "r" | "s", axis: "x" | "y" | "z" | null): string => {
        const action = hk === "g" ? "Moving" : hk === "r" ? "Rotating" : "Scaling";
        return axis ? `${action}: ${axis.toUpperCase()} axis` : `${action}: free`;
      };

      const setHotkeyState = (hk: "g" | "r" | "s" | null, axis: "x" | "y" | "z" | null) => {
        setActiveHotkeyText(hk ? buildHotkeyText(hk, axis) : null);
        setActiveHotkeyAxisRef.current(axis);
      };

      // Raycaster click selection
      let mouseDownX = 0;
      let mouseDownY = 0;
      const raycaster = new THREE.Raycaster();
      const mouseVec = new THREE.Vector2();

      const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        mouseDownX = e.clientX;
        mouseDownY = e.clientY;
      };

      const onMouseUp = (e: MouseEvent) => {
        if (e.button !== 0) return;
        if (transformControls.dragging) return;
        if (Math.abs(e.clientX - mouseDownX) > 5 || Math.abs(e.clientY - mouseDownY) > 5) return;
        if (activeHotkey) return;
        const rect = renderer.domElement.getBoundingClientRect();
        mouseVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouseVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouseVec, camera);
        const hits = raycaster.intersectObjects(selectableRoots, true);
        if (!hits.length) { selectObject(null, null); return; }
        const root = findSelectableRoot(hits[0].object, selectableRoots);
        if (!root) { selectObject(null, null); return; }
        selectObject(root, (root.userData.selectType as "light" | "camera" | "cue") ?? null);
      };

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.repeat) return;
        const key = e.key.toLowerCase();

        if ((key === "x" || key === "y" || key === "z") && activeHotkey && selectedObj) {
          hotkeyAxisLock = key as "x" | "y" | "z";
          setAxisLock(key as "x" | "y" | "z");
          setHotkeyState(activeHotkey, key as "x" | "y" | "z");
          return;
        }

        if ((key === "g" || key === "r" || key === "s") && selectedObj) {
          if (key === "s" && selectedType === "camera") return;
          activeHotkey = key;
          hotkeyAxisLock = null;
          hotkeyDragging = false;
          hotkeyOrigPos.copy(selectedObj.position);
          hotkeyOrigRot.copy(selectedObj.rotation);
          hotkeyOrigScl.copy(selectedObj.scale);
          transformControls.enabled = false;
          orbitControls.enabled = false;
          transformControls.setMode(key === "g" ? "translate" : key === "r" ? "rotate" : "scale");
          resetAxisLock();
          setHotkeyState(key, null);
          e.preventDefault();
          return;
        }

        if (key === "escape") {
          if (activeHotkey && selectedObj) {
            selectedObj.position.copy(hotkeyOrigPos);
            selectedObj.rotation.copy(hotkeyOrigRot);
            selectedObj.scale.copy(hotkeyOrigScl);
            if (selectedType === "light") {
              shadowLight.position.copy(hotkeyOrigPos);
              shadowLight.shadow.camera.updateProjectionMatrix();
            }
            if (selectedType === "camera") syncCameraFromGizmo();
            endHotkeyDrag(false);
          } else {
            selectObject(null, null);
          }
        }
      };

      const onKeyUp = (e: KeyboardEvent) => {
        const key = e.key.toLowerCase();
        if ((key === "g" || key === "r" || key === "s") && activeHotkey === key) {
          endHotkeyDrag(true);
        }
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!activeHotkey || !selectedObj) return;
        if (!hotkeyDragging) {
          hotkeyDragging = true;
          hotkeyStartX = e.clientX;
          hotkeyStartY = e.clientY;
        }
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        const dx = (e.clientX - hotkeyStartX) / w;
        const dy = (e.clientY - hotkeyStartY) / h;
        const obj = selectedObj;

        if (activeHotkey === "g") {
          const speed = 20;
          const pos = hotkeyOrigPos.clone();
          const axis = hotkeyAxisLock;
          if (!axis || axis === "x") pos.x += dx * speed;
          if (!axis || axis === "y") pos.y -= dy * speed;
          if (axis === "z") pos.z -= dx * speed;
          obj.position.copy(pos);
          if (selectedType === "light") {
            shadowLight.position.copy(pos);
            shadowLight.shadow.camera.updateProjectionMatrix();
          }
          if (selectedType === "camera") syncCameraFromGizmo();
        } else if (activeHotkey === "r") {
          const angle = -dy * Math.PI * 2;
          const axis = hotkeyAxisLock ?? "y";
          const origQ = new THREE.Quaternion().setFromEuler(hotkeyOrigRot);
          const axVec =
            axis === "x" ? new THREE.Vector3(1, 0, 0) :
            axis === "z" ? new THREE.Vector3(0, 0, 1) :
                           new THREE.Vector3(0, 1, 0);
          const deltaQ = new THREE.Quaternion().setFromAxisAngle(axVec, angle);
          const result = deltaQ.multiply(origQ);
          obj.quaternion.copy(result);
          obj.rotation.setFromQuaternion(result, obj.rotation.order);
          if (selectedType === "camera") syncCameraFromGizmo();
        } else if (activeHotkey === "s") {
          const factor = 1 + dx * 2;
          const scl = hotkeyOrigScl.clone();
          const axis = hotkeyAxisLock;
          if (!axis) scl.multiplyScalar(factor);
          else {
            if (axis === "x") scl.x *= factor;
            if (axis === "y") scl.y *= factor;
            if (axis === "z") scl.z *= factor;
          }
          obj.scale.copy(scl);
        }
      };

      const endHotkeyDrag = (commit: boolean) => {
        if (commit && selectedType === "light") syncLightPos();
        if (commit && selectedType === "camera") syncCameraFromGizmo();
        activeHotkey = null;
        hotkeyAxisLock = null;
        hotkeyDragging = false;
        transformControls.enabled = true;
        orbitControls.enabled = true;
        resetAxisLock();
        setHotkeyState(null, null);
      };

      window.addEventListener("mousedown", onMouseDown);
      window.addEventListener("mouseup", onMouseUp);
      renderer.domElement.addEventListener("mousemove", onMouseMove);
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);

      // ── Initial light position: stored natural-scale × SCALE ──────────────────
      const initLx = cfg.lightX * SCALE;
      const initLy = cfg.lightY * SCALE;
      const initLz = cfg.lightZ * SCALE;
      lightSphere.position.set(initLx, initLy, initLz);
      shadowLight.position.set(initLx, initLy, initLz);
      shadowLight.shadow.camera.updateProjectionMatrix();

      // ── Render loop ───────────────────────────────────────────────────────────
      // Preview is captured by rendering from recordingCam into the same renderer
      // (within one rAF callback — browser composites only the final godCam render).
      let lastPreviewMs = 0;

      simObj = {
        renderer, scene, camera, orbitControls, transformControls,
        shadowLight, lightSphere, cameraGizmo, recordingCam, camHelper,
        modelClone, floorBase, wallBase, lShapeShadow,
        animFrameId: null, isDisposed: false,
      };

      const animate = () => {
        if (simObj!.isDisposed) return;
        simObj!.animFrameId = requestAnimationFrame(animate);
        orbitControls.update();

        // Throttle preview capture to ~5fps (every 200ms)
        const now = performance.now();
        if (now - lastPreviewMs > 200) {
          lastPreviewMs = now;
          // Render from recordingCam (1:1 aspect) for the 2D preview panel
          renderer.render(scene, recordingCam);
          try {
            setPreviewUrlRef.current(renderer.domElement.toDataURL("image/jpeg", 0.88));
          } catch { /* ignore tainted canvas */ }
        }

        // Always render main god-camera view last — this is what the user sees
        renderer.render(scene, camera);
      };
      animate();

      simRef.current = simObj;

      const resizeObserver = new ResizeObserver(() => {
        if (!simObj || simObj.isDisposed) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      });
      resizeObserver.observe(container);

      const evtCleanup = () => {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mouseup", onMouseUp);
        renderer.domElement.removeEventListener("mousemove", onMouseMove);
      };
      (simObj as SimScene & { _resizeObs: ResizeObserver; _evtCleanup: () => void })._resizeObs =
        resizeObserver;
      (simObj as SimScene & { _resizeObs: ResizeObserver; _evtCleanup: () => void })._evtCleanup =
        evtCleanup;
    };

    // rAF retry until dialog container has real dimensions
    let retries = 0;
    const tryInit = () => {
      if (cancelled) return;
      const container = simContainerRef.current;
      if (!container || simRef.current) return;
      if (container.clientWidth === 0 || container.clientHeight === 0) {
        if (retries < 30) { retries++; rafId = requestAnimationFrame(tryInit); return; }
      }
      doInit(container);
    };
    rafId = requestAnimationFrame(tryInit);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (simObj) {
        const s = simObj as SimScene & { _resizeObs?: ResizeObserver; _evtCleanup?: () => void };
        s._resizeObs?.disconnect();
        s._evtCleanup?.();
        s.isDisposed = true;
        if (s.animFrameId !== null) cancelAnimationFrame(s.animFrameId);
        s.transformControls.detach();
        s.orbitControls.dispose();
        s.transformControls.dispose();
        s.renderer.dispose();
        const c = simContainerRef.current;
        if (c && c.contains(s.renderer.domElement)) c.removeChild(s.renderer.domElement);
        simRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Sync blur to sim scene when slider changes
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.shadowLight.shadow.radius = localCfg.blur;
  }, [localCfg.blur]);

  // Sync shadow intensity to L-shaped shadow mesh
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    (sim.lShapeShadow.material as THREE.ShadowMaterial).opacity = localCfg.intensity;
  }, [localCfg.intensity]);

  // Sync wall/floor color to sim scene
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    applyStudioColor(sim.floorBase.material as THREE.MeshBasicMaterial, localCfg.wallColor ?? "#ffffff", localCfg.wallGradientEnd);
    applyStudioColor(sim.wallBase.material as THREE.MeshBasicMaterial, localCfg.wallColor ?? "#ffffff", localCfg.wallGradientEnd);
  }, [localCfg.wallColor, localCfg.wallGradientEnd]);

  // Preview is now captured live from recordingCam inside the animate loop.
  // Clear preview when dialog closes.
  useEffect(() => {
    if (!open) setPreviewUrl(null);
  }, [open]);

  // ─── Handlers ────────────────────────────────────────────────────────────────
  const handleSlider = (field: keyof CueShadowConfig, value: number) => {
    setLocalCfg(prev => {
      const next = { ...prev, [field]: value };
      onConfigChangeRef.current(next);
      return next;
    });
  };

  const handleWallColor = (color: string) => {
    setLocalCfg(prev => {
      const next = { ...prev, wallColor: color };
      onConfigChangeRef.current(next);
      return next;
    });
  };

  const handleGradientEnd = (color: string) => {
    setLocalCfg(prev => {
      const next = { ...prev, wallGradientEnd: color };
      onConfigChangeRef.current(next);
      return next;
    });
  };

  const toggleGradient = () => {
    setShowGradient(prev => {
      const next = !prev;
      if (!next) {
        setLocalCfg(p => {
          const updated = { ...p, wallGradientEnd: undefined };
          onConfigChangeRef.current(updated);
          return updated;
        });
      } else {
        setLocalCfg(p => {
          const updated = { ...p, wallGradientEnd: "#e0e0e0" };
          onConfigChangeRef.current(updated);
          return updated;
        });
      }
      return next;
    });
  };

  const handleSave = () => { onSave(localCfg); };

  // ─── Render ───────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[92vw] w-[1200px] h-[84vh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="px-5 py-3.5 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="w-4 h-4 text-yellow-400 fill-yellow-400/30" />
            Studio Shadow Simulator — 3D
            {activeSelect && (
              <span className="ml-2 text-[11px] font-normal px-2 py-0.5 rounded-full bg-yellow-400/20 text-yellow-600 border border-yellow-400/40">
                {activeSelect === "light" ? "💡 Light" : activeSelect === "camera" ? "📷 Camera" : "🎯 Cue"} selected
              </span>
            )}
            {activeHotkeyText && (
              <span className={`text-[11px] font-normal px-2 py-0.5 rounded-full border ${
                activeHotkeyAxis === "x"
                  ? "bg-red-500/20 text-red-500 border-red-400/40"
                  : activeHotkeyAxis === "y"
                  ? "bg-green-500/20 text-green-500 border-green-400/40"
                  : activeHotkeyAxis === "z"
                  ? "bg-blue-500/20 text-blue-500 border-blue-400/40"
                  : "bg-white/20 text-foreground border-border/40"
              }`}>
                {activeHotkeyText}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 min-h-0">
          {/* 3D simulation canvas */}
          <div
            ref={simContainerRef}
            className="flex-1 min-w-0 min-h-0 bg-white relative"
          >
            <div className="absolute bottom-3 left-3 pointer-events-none select-none space-y-1 z-10">
              <p className="text-[10px] bg-black/40 text-white/85 px-2 py-0.5 rounded-full backdrop-blur-sm">
                🖱 Click object to select · right-click/scroll to orbit/zoom
              </p>
              <p className="text-[10px] bg-black/40 text-white/85 px-2 py-0.5 rounded-full backdrop-blur-sm">
                ⌨ G=grab · R=rotate · S=scale · then X/Y/Z to lock axis · Esc=cancel
              </p>
            </div>
          </div>

          {/* Right panel */}
          <div className="w-[268px] shrink-0 flex flex-col border-l bg-background overflow-y-auto">
            {/* 2D preview */}
            <div className="p-3 border-b shrink-0">
              <div className="mb-1.5">
                <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Cue Frame Result
                </Label>
              </div>
              <div className="aspect-square bg-muted/40 rounded-md overflow-hidden border">
                {previewUrl ? (
                  <img src={previewUrl} alt="Shadow preview" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground">
                    Loading…
                  </div>
                )}
              </div>
            </div>

            {/* Controls */}
            <div className="p-3 space-y-5">
              <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Shadow Settings
              </Label>

              {/* Intensity */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Intensity</Label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {Math.round(localCfg.intensity * 100)}%
                  </span>
                </div>
                <Slider value={[localCfg.intensity]} onValueChange={([v]) => handleSlider("intensity", v)}
                  min={0} max={1} step={0.01} className="w-full" />
              </div>

              {/* Blur */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Blur</Label>
                  <span className="text-xs tabular-nums text-muted-foreground">{localCfg.blur.toFixed(0)}</span>
                </div>
                <Slider value={[localCfg.blur]} onValueChange={([v]) => handleSlider("blur", v)}
                  min={0} max={20} step={0.5} className="w-full" />
              </div>

              {/* Light position readout */}
              <div className="rounded-md bg-muted/50 p-2.5 space-y-1">
                <Label className="text-[10px] text-muted-foreground/70 uppercase tracking-wide">
                  Light Position
                </Label>
                <div className="grid grid-cols-3 gap-1 text-[11px] font-mono">
                  <span className="text-red-400">X {localCfg.lightX.toFixed(1)}</span>
                  <span className="text-green-400">Y {localCfg.lightY.toFixed(1)}</span>
                  <span className="text-blue-400">Z {localCfg.lightZ.toFixed(1)}</span>
                </div>
              </div>

              {/* Wall / Floor color */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Palette className="w-3 h-3" /> Wall &amp; Floor Color
                  </Label>
                  <button
                    onClick={toggleGradient}
                    className="text-[10px] text-primary hover:underline"
                  >
                    {showGradient ? "Solid" : "Gradient"}
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={localCfg.wallColor ?? "#ffffff"}
                    onChange={(e) => handleWallColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer border border-border p-0.5"
                    title="Wall color"
                  />
                  <span className="text-[11px] text-muted-foreground font-mono">
                    {localCfg.wallColor ?? "#ffffff"}
                  </span>
                </div>

                {showGradient && (
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={localCfg.wallGradientEnd ?? "#e0e0e0"}
                      onChange={(e) => handleGradientEnd(e.target.value)}
                      className="w-7 h-7 rounded cursor-pointer border border-border p-0.5"
                      title="Gradient end color"
                    />
                    <span className="text-[11px] text-muted-foreground font-mono">
                      {localCfg.wallGradientEnd ?? "#e0e0e0"}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 ml-auto">↓ bottom</span>
                  </div>
                )}

                {/* Gradient preview swatch */}
                {showGradient && (
                  <div
                    className="h-5 w-full rounded border border-border"
                    style={{
                      background: `linear-gradient(to bottom, ${localCfg.wallColor ?? "#ffffff"}, ${localCfg.wallGradientEnd ?? "#e0e0e0"})`,
                    }}
                  />
                )}
              </div>

              <div className="text-[10px] text-muted-foreground/60 space-y-0.5 leading-relaxed">
                <p>⚙ Gizmo: Red·X · Green·Y · Blue·Z</p>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="px-5 py-3 border-t shrink-0 flex justify-between sm:justify-between">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} className="gap-1.5">
            <Save className="w-3.5 h-3.5" />
            Save Shadow Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

