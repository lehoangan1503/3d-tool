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
import { Save, Lightbulb, RefreshCw, Palette } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SimScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  shadowLight: THREE.DirectionalLight;
  lightSphere: THREE.Mesh;
  floorBase: THREE.Mesh;
  wallBase: THREE.Mesh;
  floorShadow: THREE.Mesh;
  wallShadow: THREE.Mesh;
  animFrameId: number | null;
  isDisposed: boolean;
}

interface ShadowSimulateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shadowConfig: CueShadowConfig;
  onConfigChange: (cfg: CueShadowConfig) => void;
  onSave: (cfg: CueShadowConfig) => void;
  extractorRef: React.MutableRefObject<ExtractorSceneManager | null>;
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

// ─── Main Component ───────────────────────────────────────────────────────────

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

  const onConfigChangeRef = useRef(onConfigChange);
  useEffect(() => { onConfigChangeRef.current = onConfigChange; }, [onConfigChange]);

  const [localCfg, setLocalCfg] = useState<CueShadowConfig>(() => ({ ...shadowConfig }));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showGradient, setShowGradient] = useState(false);

  // Sync localCfg when dialog opens
  useEffect(() => {
    if (open) {
      setLocalCfg({ ...shadowConfig });
      setShowGradient(!!shadowConfig.wallGradientEnd);
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

      // Renderer
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(W, H);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.3;
      renderer.setClearColor(0xffffff);
      renderer.domElement.style.cssText =
        "display:block;position:absolute;top:0;left:0;width:100%;height:100%;";
      container.appendChild(renderer.domElement);

      // Scene — white background
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xffffff);

      // Camera — slightly elevated front view
      const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 200);
      camera.position.set(0, 2, 9);
      camera.lookAt(0, 0.5, 0);

      // OrbitControls
      const orbitControls = new OrbitControls(camera, renderer.domElement);
      orbitControls.target.set(0, 0.5, 0);
      orbitControls.enableDamping = true;
      orbitControls.dampingFactor = 0.12;
      orbitControls.minDistance = 3;
      orbitControls.maxDistance = 30;
      orbitControls.maxPolarAngle = Math.PI * 0.82;

      // ── Lighting ─────────────────────────────────────────────────────────────
      // Hemisphere gives the cue decent ambient shading without HDRI
      const hemi = new THREE.HemisphereLight(0xffffff, 0xcccccc, 1.8);
      scene.add(hemi);

      // Shadow-casting directional light (no visible color contribution from it, just shadow)
      const shadowLight = new THREE.DirectionalLight(0xfffdf5, 0);
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

      // ── White studio surfaces (true-white, MeshBasicMaterial) ───────────────
      const cfg = shadowConfig;
      const wallColor = cfg.wallColor ?? "#ffffff";
      const wallGradientEnd = cfg.wallGradientEnd;

      // Floor base — unlit white plane
      const floorBase = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 30),
        makeStudioMat(wallColor, wallGradientEnd)
      );
      floorBase.rotation.x = -Math.PI / 2;
      floorBase.position.y = -1.182;
      scene.add(floorBase);

      // Shadow overlay on floor
      const floorShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 30),
        new THREE.ShadowMaterial({ opacity: cfg.intensity, transparent: true, depthWrite: false })
      );
      floorShadow.rotation.x = -Math.PI / 2;
      floorShadow.position.y = -1.18;
      floorShadow.receiveShadow = true;
      scene.add(floorShadow);

      // Back wall base — unlit white plane
      const wallBase = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 20),
        makeStudioMat(wallColor, wallGradientEnd)
      );
      wallBase.position.set(0, 4.8, -3);
      scene.add(wallBase);

      // Shadow overlay on back wall
      const wallShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 20),
        new THREE.ShadowMaterial({ opacity: cfg.intensity, transparent: true, depthWrite: false })
      );
      wallShadow.position.set(0, 4.8, -2.99);
      wallShadow.receiveShadow = true;
      scene.add(wallShadow);

      // ── Load actual cue model ─────────────────────────────────────────────
      const modelClone = extractorRef.current?.getModelClone?.();
      if (modelClone) {
        modelClone.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = false;
          }
        });
        scene.add(modelClone);
      }

      // ── Light sphere (draggable indicator) ──────────────────────────────
      const sphereMat = new THREE.MeshStandardMaterial({
        color: 0xffcc00,
        emissive: 0xff8800,
        emissiveIntensity: 1.2,
        roughness: 0.2,
        metalness: 0.1,
      });
      const lightSphere = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 24), sphereMat);
      lightSphere.name = "lightSphere";
      scene.add(lightSphere);

      // Glow halo
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0xffcc00, transparent: true, opacity: 0.18, side: THREE.DoubleSide,
      });
      const halo = new THREE.Mesh(new THREE.SphereGeometry(0.52, 16, 16), haloMat);
      lightSphere.add(halo);

      // Drop-line guide
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, -30, 0),
      ]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.3 });
      lightSphere.add(new THREE.Line(lineGeo, lineMat));

      // ── TransformControls ────────────────────────────────────────────────
      const transformControls = new TransformControls(camera, renderer.domElement);
      transformControls.setMode("translate");
      transformControls.setSize(0.65);
      transformControls.attach(lightSphere);
      scene.add(transformControls.getHelper());

      transformControls.addEventListener("dragging-changed", (event: { value: unknown }) => {
        orbitControls.enabled = !event.value;
      });

      transformControls.addEventListener("objectChange", () => {
        const { x, y, z } = lightSphere.position;
        const cx = Math.max(-12, Math.min(12, x));
        const cy = Math.max(0.5, Math.min(22, y));
        const cz = Math.max(-12, Math.min(12, z));
        if (cx !== x || cy !== y || cz !== z) lightSphere.position.set(cx, cy, cz);
        shadowLight.position.set(cx, cy, cz);
        shadowLight.shadow.camera.updateProjectionMatrix();
        setLocalCfg(prev => {
          const next = { ...prev, lightX: cx, lightY: cy, lightZ: cz };
          setTimeout(() => onConfigChangeRef.current(next), 0);
          return next;
        });
      });

      // ── Initial light position ────────────────────────────────────────
      lightSphere.position.set(cfg.lightX, cfg.lightY, cfg.lightZ);
      shadowLight.position.set(cfg.lightX, cfg.lightY, cfg.lightZ);
      shadowLight.shadow.radius = cfg.blur;

      // ── Render loop ───────────────────────────────────────────────────
      simObj = {
        renderer, scene, camera, orbitControls, transformControls,
        shadowLight, lightSphere, floorBase, wallBase, floorShadow, wallShadow,
        animFrameId: null, isDisposed: false,
      };

      const animate = () => {
        if (simObj!.isDisposed) return;
        simObj!.animFrameId = requestAnimationFrame(animate);
        orbitControls.update();
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
      (simObj as SimScene & { _resizeObs: ResizeObserver })._resizeObs = resizeObserver;
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
        const s = simObj as SimScene & { _resizeObs?: ResizeObserver };
        s._resizeObs?.disconnect();
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

  // Sync shadow intensity to sim scene overlay planes
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    (sim.floorShadow.material as THREE.ShadowMaterial).opacity = localCfg.intensity;
    (sim.wallShadow.material as THREE.ShadowMaterial).opacity = localCfg.intensity;
  }, [localCfg.intensity]);

  // Sync wall/floor color to sim scene
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    applyStudioColor(sim.floorBase.material as THREE.MeshBasicMaterial, localCfg.wallColor ?? "#ffffff", localCfg.wallGradientEnd);
    applyStudioColor(sim.wallBase.material as THREE.MeshBasicMaterial, localCfg.wallColor ?? "#ffffff", localCfg.wallGradientEnd);
  }, [localCfg.wallColor, localCfg.wallGradientEnd]);

  // ─── 2D preview capture ──────────────────────────────────────────────────────
  const capturePreview = useCallback(() => {
    try {
      const canvas = extractorRef.current?.getCanvas();
      if (!canvas) return;
      setPreviewUrl(canvas.toDataURL("image/jpeg", 0.88));
    } catch { /* cross-origin taint — ignore */ }
  }, [extractorRef]);

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(capturePreview, 200);
    return () => clearTimeout(id);
  }, [open, localCfg, capturePreview]);

  useEffect(() => {
    if (open) {
      const id = setTimeout(capturePreview, 450);
      return () => clearTimeout(id);
    }
  }, [open, capturePreview]);

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
                💡 Drag the yellow sphere to move the studio light
              </p>
              <p className="text-[10px] bg-black/40 text-white/85 px-2 py-0.5 rounded-full backdrop-blur-sm">
                🖱 Right-click / scroll to orbit / zoom camera
              </p>
            </div>
          </div>

          {/* Right panel */}
          <div className="w-[268px] shrink-0 flex flex-col border-l bg-background overflow-y-auto">
            {/* 2D preview */}
            <div className="p-3 border-b shrink-0">
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Cue Frame Result
                </Label>
                <button
                  onClick={capturePreview}
                  title="Refresh preview"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
              <div className="aspect-square bg-muted/40 rounded-md overflow-hidden border">
                {previewUrl ? (
                  <img src={previewUrl} alt="Shadow preview" className="w-full h-full object-contain" />
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

