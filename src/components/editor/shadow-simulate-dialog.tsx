"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import type { CueShadowConfig } from "@/types/extractor";
import type { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { Save, Lightbulb, RefreshCw } from "lucide-react";

interface SimScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  shadowLight: THREE.DirectionalLight;
  lightSphere: THREE.Mesh;
  animFrameId: number | null;
  isDisposed: boolean;
}

interface ShadowSimulateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current saved shadow config (source of truth from frame state) */
  shadowConfig: CueShadowConfig;
  /** Live update main extractor scene while interacting */
  onConfigChange: (cfg: CueShadowConfig) => void;
  /** Commit + close */
  onSave: (cfg: CueShadowConfig) => void;
  extractorRef: React.MutableRefObject<ExtractorSceneManager | null>;
}

export function ShadowSimulateDialog({
  open,
  onOpenChange,
  shadowConfig,
  onConfigChange,
  onSave,
  extractorRef,
}: ShadowSimulateDialogProps) {
  const simContainerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<SimScene | null>(null);

  // Keep onConfigChange stable inside effects via ref
  const onConfigChangeRef = useRef(onConfigChange);
  useEffect(() => { onConfigChangeRef.current = onConfigChange; }, [onConfigChange]);

  // Working copy — decoupled from prop so sliders are smooth
  const [localCfg, setLocalCfg] = useState<CueShadowConfig>(() => ({ ...shadowConfig }));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Sync localCfg when dialog opens (pick up the latest saved state)
  useEffect(() => {
    if (open) setLocalCfg({ ...shadowConfig });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ─── Build / destroy Three.js simulation scene ───────────────────────────
  useEffect(() => {
    if (!open || !simContainerRef.current) return;
    const container = simContainerRef.current;

    // Ensure main extractor is rendering so the 2D preview is fresh
    extractorRef.current?.startLivePreview?.();

    const W = container.clientWidth || 640;
    const H = container.clientHeight || 520;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0xdfe4ea);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // Scene
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xdfe4ea, 30, 60);

    // Camera
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 200);
    camera.position.set(8, 10, 16);
    camera.lookAt(0, 1.5, 0);

    // Orbit controls
    const orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.target.set(0, 1.5, 0);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.12;
    orbitControls.minDistance = 4;
    orbitControls.maxDistance = 40;
    orbitControls.maxPolarAngle = Math.PI * 0.85;

    // ── Lighting ────────────────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);

    const shadowLight = new THREE.DirectionalLight(0xfffdf5, 2.2);
    shadowLight.castShadow = true;
    shadowLight.shadow.mapSize.set(2048, 2048);
    shadowLight.shadow.camera.near = 0.1;
    shadowLight.shadow.camera.far = 80;
    shadowLight.shadow.camera.left = -16;
    shadowLight.shadow.camera.right = 16;
    shadowLight.shadow.camera.top = 16;
    shadowLight.shadow.camera.bottom = -16;
    shadowLight.shadow.bias = 0.0001;
    shadowLight.shadow.normalBias = 0.02;
    shadowLight.target.position.set(0, 0, 0);
    scene.add(shadowLight);
    scene.add(shadowLight.target);

    // ── Studio room geometry ──────────────────────────────────────────────
    const roomMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.9, side: THREE.FrontSide });

    // Floor
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(32, 32), roomMat.clone());
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Back wall
    const backWall = new THREE.Mesh(new THREE.PlaneGeometry(32, 18), roomMat.clone());
    backWall.position.set(0, 9, -11);
    backWall.receiveShadow = true;
    scene.add(backWall);

    // Left wall (faint, helps with depth)
    const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(22, 18), roomMat.clone());
    leftWall.position.set(-11, 9, 0);
    leftWall.rotation.y = Math.PI / 2;
    leftWall.receiveShadow = true;
    scene.add(leftWall);

    // ── Cue placeholder box ───────────────────────────────────────────────
    const cueMat = new THREE.MeshStandardMaterial({ color: 0xc8cdd5, roughness: 0.5, metalness: 0.1 });
    const cueBody = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3.2, 0.45), cueMat);
    cueBody.position.set(0, 1.6, 0);
    cueBody.castShadow = true;
    scene.add(cueBody);

    // Small base
    const cueBase = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.18, 24), cueMat.clone());
    cueBase.position.set(0, 0.09, 0);
    cueBase.castShadow = true;
    scene.add(cueBase);

    // ── Light sphere (draggable indicator) ────────────────────────────────
    const sphereMat = new THREE.MeshStandardMaterial({
      color: 0xffcc00,
      emissive: 0xff9900,
      emissiveIntensity: 0.9,
      roughness: 0.2,
    });
    const lightSphere = new THREE.Mesh(new THREE.SphereGeometry(0.38, 24, 24), sphereMat);
    lightSphere.name = "lightSphere";
    scene.add(lightSphere);

    // Glow halo (sprite-like ring behind sphere)
    const haloMat = new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 16), haloMat);
    lightSphere.add(halo);

    // Dashed vertical line from sphere to floor (visual guide)
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -20, 0), // will be clipped by floor
    ]);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.35 });
    const dropLine = new THREE.Line(lineGeo, lineMat);
    lightSphere.add(dropLine);

    // ── TransformControls ─────────────────────────────────────────────────
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode("translate");
    transformControls.setSize(0.75);
    transformControls.attach(lightSphere);
    scene.add(transformControls.getHelper());

    transformControls.addEventListener("dragging-changed", (event: { value: unknown }) => {
      orbitControls.enabled = !event.value;
    });

    transformControls.addEventListener("objectChange", () => {
      const { x, y, z } = lightSphere.position;
      // Clamp to allowed ranges
      const cx = Math.max(-10, Math.min(10, x));
      const cy = Math.max(1, Math.min(20, y));
      const cz = Math.max(-10, Math.min(10, z));
      if (cx !== x || cy !== y || cz !== z) {
        lightSphere.position.set(cx, cy, cz);
      }
      shadowLight.position.set(cx, cy, cz);
      shadowLight.shadow.camera.updateProjectionMatrix();

      setLocalCfg(prev => {
        const next = { ...prev, lightX: cx, lightY: cy, lightZ: cz };
        // Propagate to main extractor scene after state schedules
        setTimeout(() => onConfigChangeRef.current(next), 0);
        return next;
      });
    });

    // ── Set initial light position ────────────────────────────────────────
    const initCfg = shadowConfig; // captured at mount
    lightSphere.position.set(initCfg.lightX, initCfg.lightY, initCfg.lightZ);
    shadowLight.position.set(initCfg.lightX, initCfg.lightY, initCfg.lightZ);
    shadowLight.shadow.radius = initCfg.blur;

    // ── Animation loop ────────────────────────────────────────────────────
    const simObj: SimScene = {
      renderer,
      scene,
      camera,
      orbitControls,
      transformControls,
      shadowLight,
      lightSphere,
      animFrameId: null,
      isDisposed: false,
    };

    const animate = () => {
      if (simObj.isDisposed) return;
      simObj.animFrameId = requestAnimationFrame(animate);
      orbitControls.update();
      renderer.render(scene, camera);
    };
    animate();

    simRef.current = simObj;

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (simObj.isDisposed || !container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      simObj.isDisposed = true;
      if (simObj.animFrameId !== null) cancelAnimationFrame(simObj.animFrameId);
      transformControls.detach();
      orbitControls.dispose();
      transformControls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      simRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Sync sim scene when slider-driven fields change (intensity/blur don't move sphere)
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.shadowLight.shadow.radius = localCfg.blur;
  }, [localCfg.blur]);

  // ─── 2D preview capture ───────────────────────────────────────────────────
  const capturePreview = useCallback(() => {
    try {
      const canvas = extractorRef.current?.getCanvas();
      if (!canvas) return;
      setPreviewUrl(canvas.toDataURL("image/jpeg", 0.88));
    } catch {
      // canvas may be cross-origin tainted in some envs — ignore
    }
  }, [extractorRef]);

  // Refresh preview 200ms after config changes
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(capturePreview, 200);
    return () => clearTimeout(id);
  }, [open, localCfg, capturePreview]);

  // First capture shortly after dialog opens
  useEffect(() => {
    if (open) {
      const id = setTimeout(capturePreview, 400);
      return () => clearTimeout(id);
    }
  }, [open, capturePreview]);

  // ─── Slider handlers ──────────────────────────────────────────────────────
  const handleSlider = (field: keyof CueShadowConfig, value: number) => {
    setLocalCfg(prev => {
      const next = { ...prev, [field]: value };
      onConfigChangeRef.current(next);
      return next;
    });
  };

  const handleSave = () => {
    onSave(localCfg);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[92vw] w-[1180px] h-[82vh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="px-5 py-3.5 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="w-4 h-4 text-yellow-400 fill-yellow-400/30" />
            Studio Shadow Simulator — 3D
          </DialogTitle>
        </DialogHeader>

        {/* Main area */}
        <div className="flex flex-1 min-h-0">
          {/* Left: 3D simulation canvas */}
          <div
            ref={simContainerRef}
            className="flex-1 min-w-0 min-h-0 bg-[#dfe4ea] relative"
            style={{ cursor: "default" }}
          >
            {/* Hint overlay */}
            <div className="absolute bottom-3 left-3 pointer-events-none select-none space-y-1 z-10">
              <p className="text-[10px] bg-black/40 text-white/80 px-2 py-0.5 rounded-full backdrop-blur-sm">
                💡 Kéo hình cầu vàng để di chuyển đèn studio
              </p>
              <p className="text-[10px] bg-black/40 text-white/80 px-2 py-0.5 rounded-full backdrop-blur-sm">
                🖱 Chuột phải / cuộn để xoay / zoom góc nhìn
              </p>
            </div>
          </div>

          {/* Right: preview + sliders */}
          <div className="w-[260px] shrink-0 flex flex-col border-l bg-background overflow-y-auto">
            {/* 2D preview */}
            <div className="p-3 border-b shrink-0">
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Kết quả Cue Frame
                </Label>
                <button
                  onClick={capturePreview}
                  title="Làm mới"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
              <div className="aspect-square bg-muted/50 rounded-md overflow-hidden border">
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt="Shadow preview"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground">
                    Đang tải…
                  </div>
                )}
              </div>
            </div>

            {/* Sliders */}
            <div className="p-3 space-y-5">
              <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Điều chỉnh bóng
              </Label>

              {/* Intensity */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Cường độ</Label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {Math.round(localCfg.intensity * 100)}%
                  </span>
                </div>
                <Slider
                  value={[localCfg.intensity]}
                  onValueChange={([v]) => handleSlider("intensity", v)}
                  min={0}
                  max={1}
                  step={0.01}
                  className="w-full"
                />
              </div>

              {/* Blur */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Làm mờ</Label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {localCfg.blur.toFixed(0)}
                  </span>
                </div>
                <Slider
                  value={[localCfg.blur]}
                  onValueChange={([v]) => handleSlider("blur", v)}
                  min={0}
                  max={20}
                  step={0.5}
                  className="w-full"
                />
              </div>

              {/* Current coords readout */}
              <div className="rounded-md bg-muted/50 p-2.5 space-y-1">
                <Label className="text-[10px] text-muted-foreground/70 uppercase tracking-wide">
                  Vị trí đèn
                </Label>
                <div className="grid grid-cols-3 gap-1 text-[11px] font-mono">
                  <span className="text-red-400">X {localCfg.lightX.toFixed(1)}</span>
                  <span className="text-green-400">Y {localCfg.lightY.toFixed(1)}</span>
                  <span className="text-blue-400">Z {localCfg.lightZ.toFixed(1)}</span>
                </div>
              </div>

              <div className="text-[10px] text-muted-foreground/60 space-y-0.5 leading-relaxed">
                <p>⚙ Gizmo: Đỏ·X · Xanh lá·Y · Xanh·Z</p>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="px-5 py-3 border-t shrink-0 flex justify-between sm:justify-between">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button size="sm" onClick={handleSave} className="gap-1.5">
            <Save className="w-3.5 h-3.5" />
            Lưu cài đặt bóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
