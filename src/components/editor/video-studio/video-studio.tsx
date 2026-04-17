"use client";

import * as THREE from "three";
import { useState, useEffect, useRef, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Video,
  Download,
  Square,
  Loader2,
  AlertCircle,
  RotateCcw,
  Eye,
  Camera,
  ChevronDown,
  ChevronUp,
  Box,
  Move,
  Maximize2,
  Sun,
  Image as ImageIcon,
  Sparkles,
  Undo2,
  Redo2,
  Save,
  RefreshCw,
  Lightbulb,
  Plus,
  Trash2,
} from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager, HDRI_OPTIONS_FALLBACK } from "@/lib/three/extractor-scene-manager";
import type { VideoStudioConfig, CameraKeyframe, CueHdriConfig } from "@/types/video-studio";
import { DEFAULT_STUDIO_CONFIG, DEFAULT_CUE_HDRI, VIDEO_QUALITY_PRESETS, ensureFullConfig, migrateVideoStudioConfig, computeVideoDuration } from "@/types/video-studio";
import { createDefaultHdriLayer, STUDIO_WHITE_HDRI } from "@/types/extractor";
import { CameraControlsPanel } from "./camera-controls-panel";
import { CueSetupPanel } from "./cue-setup-panel";
import { BackgroundPanel } from "./background-panel";
import { StudioTemplateSelector, type StudioTemplateSelectorHandle } from "./studio-template-selector";
import { SceneViewControls, type SelectionInfo } from "./scene-view-controls";

/** Inline editable number field for transform values */
function TransformInput({ label, value, onChange, suffix = "" }: { label: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground w-3 shrink-0">{label}</span>
      <input
        type="number"
        step="0.1"
        value={parseFloat(value.toFixed(2))}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(v);
        }}
        className="h-6 w-full rounded border border-border/50 bg-muted/30 px-1.5 text-xs font-mono tabular-nums text-foreground outline-none focus:border-blue-500/50"
      />
      {suffix && <span className="text-[10px] text-muted-foreground shrink-0">{suffix}</span>}
    </div>
  );
}

interface VideoStudioProps {
  sceneManager: SceneManager | null;
  productName: string;
  productId: string;
  onClose: () => void;
  open: boolean;
}

const SELECTION_LABELS_VN: Record<string, string> = {
  camera: "Camera",
  cue: "Mô hình",
  wall: "Tường",
  table: "Bàn",
  wallFrame: "Khung tường",
  tableFrame: "Khung bàn",
  hdriLight: "Đèn",
};

const MODE_LABELS_VN: Record<string, string> = {
  translate: "Di chuyển",
  rotate: "Xoay",
  scale: "Tỷ lệ",
};

export function VideoStudio({ sceneManager, productName, productId, onClose, open }: VideoStudioProps) {
  const [config, setConfig] = useState<VideoStudioConfig>(() => structuredClone(DEFAULT_STUDIO_CONFIG));
  const [isRecording, setIsRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [viewMode, setViewMode] = useState<"scene" | "camera">("camera");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo>({ type: null });
  const [transformValues, setTransformValues] = useState<{
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
  } | null>(null);
  const [transformMode, setTransformMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [hotkeyAxis, setHotkeyAxis] = useState<"x" | "y" | "z" | null>(null);
  // Track which section was auto-opened by selection (so we can close it on deselect)
  const autoExpandedSectionRef = useRef<string | null>(null);

  // Undo/redo history — seed with initial config so first undo always has a target
  const configHistoryRef = useRef<VideoStudioConfig[]>([structuredClone(config)]);
  const configFutureRef = useRef<VideoStudioConfig[]>([]);
  const isUndoRedoRef = useRef(false);
  const isDraggingRef = useRef(false);
  const historyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoUrlRef = useRef<string | null>(null);
  const blobUrlsRef = useRef<string[]>([]);
  const sceneViewControlsRef = useRef<SceneViewControls | null>(null);
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const templateSelectorRef = useRef<StudioTemplateSelectorHandle>(null);

  // Keep a ref to config so SceneViewControls callback always reads latest
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
    // Always cancel pending debounce first — prevents stale timer from
    // clearing the redo stack after undo/redo fires
    if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current);
    // Debounced history push: batch rapid changes (sliders) into one entry
    if (!isUndoRedoRef.current && !isDraggingRef.current) {
      historyDebounceRef.current = setTimeout(() => {
        historyDebounceRef.current = null;
        configHistoryRef.current = [...configHistoryRef.current.slice(-4), configRef.current];
        configFutureRef.current = [];
      }, 600);
    }
    isUndoRedoRef.current = false;
  }, [config]);

  const undo = useCallback(() => {
    if (configHistoryRef.current.length <= 1) return;
    const current = configHistoryRef.current.pop()!;
    configFutureRef.current.push(current);
    const prev = configHistoryRef.current[configHistoryRef.current.length - 1];
    if (prev) {
      isUndoRedoRef.current = true;
      setConfig(structuredClone(prev));
    }
  }, []);

  const redo = useCallback(() => {
    if (configFutureRef.current.length === 0) return;
    const next = configFutureRef.current.pop()!;
    isUndoRedoRef.current = true;
    configHistoryRef.current.push(next);
    setConfig(structuredClone(next));
  }, []);

  // Ctrl+Z / Ctrl+Shift+Z keyboard handler
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, undo, redo]);

  // Minimap: register/unregister the canvas with ESM (it handles rendering internally)
  useEffect(() => {
    const esm = extractorRef.current;
    const canvas = minimapCanvasRef.current;
    if (!open || viewMode !== "scene" || !esm || !canvas) {
      esm?.setMinimapCanvas(null);
      return;
    }
    esm.setMinimapCanvas(canvas);
    return () => esm.setMinimapCanvas(null);
  }, [open, viewMode]);

  const updateConfig = useCallback(<K extends keyof VideoStudioConfig>(key: K, value: VideoStudioConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleSection = useCallback((id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const applyTransformValue = useCallback(
    (axis: "x" | "y" | "z", prop: "position" | "rotation" | "scale", value: number) => {
      if (!transformValues || !sceneViewControlsRef.current) return;
      const newValues = structuredClone(transformValues);
      newValues[prop][axis] = value;
      setTransformValues(newValues);

      const pos = new THREE.Vector3(newValues.position.x, newValues.position.y, newValues.position.z);
      const rot = new THREE.Euler(THREE.MathUtils.degToRad(newValues.rotation.x), THREE.MathUtils.degToRad(newValues.rotation.y), THREE.MathUtils.degToRad(newValues.rotation.z));
      const scl = new THREE.Vector3(newValues.scale.x, newValues.scale.y, newValues.scale.z);
      sceneViewControlsRef.current.applyTransform(pos, rot, scl);
    },
    [transformValues]
  );

  // Setup ExtractorSceneManager when dialog opens
  useEffect(() => {
    if (!open || !sceneManager) return;

    let sceneViewAnimId: number | null = null;

    const setup = async () => {
      sceneManager.pauseAnimation();
      const model = sceneManager.getModelForClone();
      const hdriUrl = sceneManager.getCurrentHdriUrl();
      if (!model) return;

      const extractor = new ExtractorSceneManager();
      extractorRef.current = extractor;

      if (model) await extractor.setModel(model);
      if (hdriUrl) {
        try {
          await extractor.loadHDRI(hdriUrl);
        } catch {
          // HDRI load failure is non-critical
        }
      }

      const canvas = extractor.getCanvas();
      if (previewContainerRef.current && canvas) {
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.objectFit = "contain";
        previewContainerRef.current.innerHTML = "";
        previewContainerRef.current.appendChild(canvas);
        const rect = previewContainerRef.current.getBoundingClientRect();
        extractor.resize(rect.width, rect.height);

        // Initialize scene view and controls
        extractor.initSceneView();
        sceneViewControlsRef.current = new SceneViewControls(
          extractor,
          canvas,
          (kf: CameraKeyframe) => {
            setConfig((prev) => ({ ...prev, cameraStart: kf }));
          },
          () => configRef.current.cueConfig,
          // Selection change → update selection info + auto-expand transform + matching section
          (info) => {
            setSelectionInfo(info);
            if (info.type && info.object) {
              const obj = info.object;
              setTransformValues({
                position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
                rotation: {
                  x: THREE.MathUtils.radToDeg(obj.rotation.x),
                  y: THREE.MathUtils.radToDeg(obj.rotation.y),
                  z: THREE.MathUtils.radToDeg(obj.rotation.z),
                },
                scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
              });
              // Map selection type → section ID
              const sectionMap: Record<string, string> = {
                cue: "cue",
                camera: "camera",
                wall: "background",
                table: "background",
                wallFrame: "background",
                tableFrame: "background",
                hdriLight: "lights",
              };
              const matchedSection = sectionMap[info.type];
              setExpandedSections((prev) => {
                const next = new Set(prev);
                // Close previously auto-expanded section
                const prevAutoSection = autoExpandedSectionRef.current;
                if (prevAutoSection && prevAutoSection !== matchedSection) {
                  next.delete(prevAutoSection);
                }
                next.add("transform");
                if (matchedSection) next.add(matchedSection);
                return next;
              });
              autoExpandedSectionRef.current = matchedSection ?? null;
            } else {
              setTransformValues(null);
              setHotkeyAxis(null);
              setExpandedSections((prev) => {
                const next = new Set(prev);
                next.delete("transform");
                // Close the section that was auto-expanded by selection
                const prevAutoSection = autoExpandedSectionRef.current;
                if (prevAutoSection) next.delete(prevAutoSection);
                return next;
              });
              autoExpandedSectionRef.current = null;
            }
          },
          // Object transform → sync 3D position back to config
          (info, position, rotation, scale) => {
            setTransformValues({
              position: { x: position.x, y: position.y, z: position.z },
              rotation: {
                x: THREE.MathUtils.radToDeg(rotation.x),
                y: THREE.MathUtils.radToDeg(rotation.y),
                z: THREE.MathUtils.radToDeg(rotation.z),
              },
              scale: { x: scale.x, y: scale.y, z: scale.z },
            });
            if (info.type === "camera") {
              if (extractorRef.current) {
                const kf = extractorRef.current.getCameraKeyframeFromPosition();
                setConfig((prev) => ({ ...prev, cameraStart: kf }));
              }
            } else if (info.type === "cue") {
              setConfig((prev) => {
                const instances = [...prev.cueConfig.instances];
                if (instances[0]) {
                  instances[0] = {
                    ...instances[0],
                    positionX: position.x,
                    positionY: position.y,
                    positionZ: position.z,
                    scale: scale.x,
                  };
                }
                return {
                  ...prev,
                  cueConfig: {
                    ...prev.cueConfig,
                    instances,
                    spinX: rotation.x,
                    spinY: rotation.y,
                    spinZ: rotation.z,
                  },
                };
              });
            } else if (info.type === "wallFrame" && info.frameId) {
              setConfig((prev) => {
                const frames = prev.wallSurface.frames.map((f) => (f.id === info.frameId ? { ...f, x: position.x / 34 + 0.5, y: 0.5 - position.y / 24 } : f));
                return { ...prev, wallSurface: { ...prev.wallSurface, frames } };
              });
            } else if (info.type === "tableFrame" && info.frameId) {
              setConfig((prev) => {
                const frames = prev.tableSurface.frames.map((f) => (f.id === info.frameId ? { ...f, x: position.x / 34 + 0.5, y: position.z / 12 + 0.5 } : f));
                return { ...prev, tableSurface: { ...prev.tableSurface, frames } };
              });
            } else if (info.type === "hdriLight" && info.layerId != null) {
              const extractor = extractorRef.current;
              if (extractor) {
                const { rotationX: rotX, rotationY: rotY } = extractor.positionToHdriRotation(position);
                // Scale maps to intensity (uniform scale, clamp 0.1–3)
                const avgScale = (scale.x + scale.y + scale.z) / 3;
                const newIntensity = Math.max(0.1, Math.min(3, avgScale));
                setConfig((prev) => {
                  const layers = [...prev.hdriConfig.layers];
                  const idx = layers.findIndex((l) => l.id === info.layerId);
                  if (idx >= 0) {
                    layers[idx] = {
                      ...layers[idx],
                      rotationX: rotX,
                      rotationY: rotY,
                      intensity: newIntensity,
                    };
                  }
                  return { ...prev, hdriConfig: { layers } };
                });
              }
            }
          },
          // Transform mode change (G/R/S keys)
          (mode) => {
            setTransformMode(mode);
            const hs = sceneViewControlsRef.current?.getHotkeyState();
            setHotkeyAxis(hs?.axis ?? null);
          },
          // Drag start: suppress history pushes during drag
          () => {
            isDraggingRef.current = true;
          },
          // Drag end: commit final state to history
          () => {
            isDraggingRef.current = false;
            setHotkeyAxis(null);
            if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current);
            configHistoryRef.current = [...configHistoryRef.current.slice(-4), configRef.current];
            configFutureRef.current = [];
          }
        );
      }

      await extractor.setupStudioFromStudioConfig(config);
      extractor.startStudioVideoPreview(config);
      setSceneReady(true);

      // Animation loop for scene view controls damping
      const sceneViewAnimate = () => {
        if (!extractorRef.current) return;
        sceneViewControlsRef.current?.update();
        sceneViewAnimId = requestAnimationFrame(sceneViewAnimate);
      };
      sceneViewAnimate();
    };

    setup();

    return () => {
      setSceneReady(false);
      if (sceneViewAnimId) cancelAnimationFrame(sceneViewAnimId);
      sceneViewControlsRef.current?.dispose();
      sceneViewControlsRef.current = null;
      extractorRef.current?.stopVideoPreview();
      extractorRef.current?.dispose();
      extractorRef.current = null;
      sceneManager?.resumeAnimation();
    };
    // Only re-run on open/close, not on config changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sceneManager]);

  // Sync view mode to extractor + enable/disable scene view controls
  useEffect(() => {
    if (!extractorRef.current) return;
    extractorRef.current.setViewMode(viewMode);
    if (sceneViewControlsRef.current) {
      sceneViewControlsRef.current.setEnabled(viewMode === "scene");
    }
  }, [viewMode]);

  // Debounced preview updates on config change
  useEffect(() => {
    if (!extractorRef.current || !open) return;
    if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    updateTimerRef.current = setTimeout(() => {
      extractorRef.current?.updateStudioPreviewConfig(config);
      updateTimerRef.current = null;
    }, 100);
    return () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    };
  }, [config, open]);

  // Rebuild scene for expensive changes (backgrounds, HDRI, shadow, instance count)
  const rebuildScene = useCallback(async () => {
    if (!extractorRef.current) return;
    setIsRebuilding(true);
    try {
      // Detach TransformControls before clearing scene — prevents
      // "attached 3D object must be a part of the scene graph" error
      sceneViewControlsRef.current?.deselect();
      extractorRef.current.stopVideoPreview();
      await extractorRef.current.setupStudioFromStudioConfig(config);
      extractorRef.current.startStudioVideoPreview(config);
    } finally {
      setIsRebuilding(false);
    }
  }, [config]);

  useEffect(() => {
    if (!extractorRef.current || !open) return;
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(() => {
      rebuildScene();
      rebuildTimerRef.current = null;
    }, 500);
    return () => {
      if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config.wallSurface.texturePreset,
    config.tableSurface.texturePreset,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(config.wallSurface.frames),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(config.tableSurface.frames),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(config.hdriConfig.layers.map((l) => l.hdriType)),
    config.shadow.enabled,
    config.cueConfig.instances.length,
    config.hdriConfig.layers.length,
    open,
  ]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, []);

  const handleSetStart = useCallback(() => {
    if (!extractorRef.current) return;
    const kf = extractorRef.current.getCameraKeyframeFromPosition();
    setConfig((prev) => ({ ...prev, cameraStart: kf }));
  }, []);

  const handleSetEnd = useCallback(() => {
    if (!extractorRef.current) return;
    const kf = extractorRef.current.getCameraKeyframeFromPosition();
    setConfig((prev) => ({ ...prev, cameraEnd: kf }));
  }, []);

  const handleRecord = async () => {
    if (!extractorRef.current) return;
    setIsRecording(true);
    setProgress(0);
    setError(null);
    setVideoUrl(null);
    sceneViewControlsRef.current?.setEnabled(false);

    // Cancel any pending debounced preview/rebuild updates so they don't
    // interfere with the recording pipeline's own setup.
    if (updateTimerRef.current) { clearTimeout(updateTimerRef.current); updateTimerRef.current = null; }
    if (rebuildTimerRef.current) { clearTimeout(rebuildTimerRef.current); rebuildTimerRef.current = null; }

    // Force camera view during recording so user sees the camera path animation
    const prevViewMode = viewMode;
    if (viewMode !== "camera") {
      setViewMode("camera");
      extractorRef.current.setViewMode("camera");
    }

    try {
      const blob = await extractorRef.current.startStudioRecording(config, (p) => setProgress(p));
      const url = URL.createObjectURL(blob);
      blobUrlsRef.current.push(url);
      videoUrlRef.current = url;
      setVideoUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed");
    } finally {
      setIsRecording(false);
      // Restore previous view mode
      setViewMode(prevViewMode);
      sceneViewControlsRef.current?.setEnabled(prevViewMode === "scene");
      // Restart preview at container size
      if (extractorRef.current && previewContainerRef.current) {
        const rect = previewContainerRef.current.getBoundingClientRect();
        extractorRef.current.resize(rect.width, rect.height);
        extractorRef.current.startStudioVideoPreview(config);
      }
    }
  };

  const handleStop = () => {
    extractorRef.current?.stopRecording();
    setIsRecording(false);
  };

  const handleDownload = () => {
    if (!videoUrl) return;
    const preset = VIDEO_QUALITY_PRESETS[config.quality];
    const qualityLabel = `2k-${preset.fps}fps`;
    const safeName = productName
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const a = document.createElement("a");
    a.href = videoUrl;
    a.download = `${safeName}-studio-${qualityLabel}.webm`;
    a.click();
  };

  const handleReset = () => {
    setConfig(structuredClone(DEFAULT_STUDIO_CONFIG));
    setVideoUrl(null);
    setError(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!isRecording && !o) onClose();
      }}
    >
      <DialogContent
        className="w-screen h-screen max-w-none rounded-none flex flex-col p-0 gap-0"
        onEscapeKeyDown={(e) => {
          // In scene view, Esc deselects — don't close dialog
          if (viewMode === "scene") {
            e.preventDefault();
            sceneViewControlsRef.current?.deselect();
          }
        }}
      >
        <DialogHeader className="px-6 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Video className="h-5 w-5" /> Video Studio
            </div>
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={undo} title="Hoàn tác (Ctrl+Z)">
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={redo} title="Làm lại (Ctrl+Shift+Z)">
                <Redo2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {/* Selection & transform info badges — visible in scene view when an object is selected */}
            {viewMode === "scene" && selectionInfo.type && (
              <span className="ml-1 text-[11px] font-normal px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-400/40">
                {SELECTION_LABELS_VN[selectionInfo.type] ?? selectionInfo.type}
              </span>
            )}
            {viewMode === "scene" && selectionInfo.type && (
              <span
                className={`text-[11px] font-normal px-2 py-0.5 rounded-full border ${
                  hotkeyAxis === "x"
                    ? "bg-red-500/15 text-red-400 border-red-400/40"
                    : hotkeyAxis === "y"
                    ? "bg-green-500/15 text-green-400 border-green-400/40"
                    : hotkeyAxis === "z"
                    ? "bg-blue-500/15 text-blue-400 border-blue-400/40"
                    : transformMode === "translate"
                    ? "bg-emerald-500/15 text-emerald-400 border-emerald-400/40"
                    : transformMode === "rotate"
                    ? "bg-orange-500/15 text-orange-400 border-orange-400/40"
                    : "bg-violet-500/15 text-violet-400 border-violet-400/40"
                }`}
              >
                {(() => {
                  const label = MODE_LABELS_VN[transformMode] ?? transformMode;
                  return hotkeyAxis ? `${label} (trục ${hotkeyAxis.toUpperCase()})` : label;
                })()}
              </span>
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-1">
              <Button variant={viewMode === "camera" ? "secondary" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setViewMode("camera")}>
                <Camera className="h-3 w-3 mr-1" /> Góc nhìn máy quay
              </Button>
              <Button variant={viewMode === "scene" ? "secondary" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setViewMode("scene")}>
                <Eye className="h-3 w-3 mr-1" /> Quay phim
              </Button>
            </div>
          </DialogTitle>
          <DialogDescription className="sr-only">Tạo video điện ảnh cho {productName}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* Left: Preview */}
          <div className="flex-1 flex flex-col p-4 min-w-0">
            <div ref={previewContainerRef} className="flex-1 bg-black rounded-lg overflow-hidden relative">
              <div
                className={`absolute inset-0 flex items-center justify-center bg-black/40 z-10 transition-opacity duration-500 pointer-events-none ${
                  !sceneReady || isRebuilding ? "opacity-100" : "opacity-0"
                }`}
              >
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="h-8 w-8 animate-spin text-white/70" />
                  <span className="text-xs text-white/50">{!sceneReady ? "Đang thiết lập cảnh…" : "Đang cập nhật…"}</span>
                </div>
              </div>
            </div>

            {/* Key hints for scene view */}
            {viewMode === "scene" && (
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground px-1 flex-wrap">
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">G</span>
                <span>Di chuyển</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">R</span>
                <span>Xoay</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">S</span>
                <span>Tỷ lệ</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">Esc</span>
                <span>Bỏ chọn</span>
                <span className="text-muted-foreground/60">— nhấp để chọn, kéo để xoay quanh</span>
              </div>
            )}

            {/* Progress bar during recording */}
            {isRecording && (
              <div className="mt-2">
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
                </div>
                <p className="text-xs text-muted-foreground mt-1 text-center">
                  {(() => {
                    const total = computeVideoDuration(config.cameraStart, config.cameraEnd, config.cameraSpeed, config.cameraDirection);
                    const elapsed = (progress / 100) * total;
                    const fmt = (s: number) => {
                      const m = Math.floor(s / 60);
                      const sec = Math.round(s % 60);
                      return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${s.toFixed(0)}s`;
                    };
                    return `Đang ghi… ${fmt(elapsed)} / ${fmt(total)}`;
                  })()}
                </p>
              </div>
            )}

            {/* Video playback */}
            {videoUrl && !isRecording && (
              <div className="mt-2">
                <video src={videoUrl} controls className="w-full rounded-lg max-h-24" />
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mt-2 flex items-center gap-2 text-destructive text-sm">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
          </div>

          {/* Right: Controls */}
          <div className="w-80 shrink-0 border-l border-border flex flex-col">
            {/* Camera minimap — fixed at top (doesn't scroll with controls) */}
            {viewMode === "scene" && (
              <div className="shrink-0 p-4 pb-2 border-b border-border/30">
                <div className="relative rounded-lg overflow-hidden border border-border/50 bg-black">
                  <canvas ref={minimapCanvasRef} width={576} height={324} className="w-full h-auto block" />
                  <span className="absolute top-1.5 left-2 text-[9px] text-white/70 font-medium bg-black/40 px-1.5 py-0.5 rounded">Góc nhìn máy quay</span>
                </div>
              </div>
            )}

            {/* Scrollable controls area */}
            <div className="overflow-y-auto p-4 space-y-3 flex-1">
              {/* Template selector — always visible at top */}
              <StudioTemplateSelector
                ref={templateSelectorRef}
                productId={productId}
                currentConfig={config}
                onLoadConfig={(c) => {
                  const migrated = migrateVideoStudioConfig(ensureFullConfig(c));
                  setConfig(migrated);
                }}
                onNewTemplate={() => {
                  setConfig(structuredClone(DEFAULT_STUDIO_CONFIG));
                }}
              />

              {/* Quality — always visible */}
              <div className="flex items-center gap-2 text-xs">
                <Select value={config.quality} onValueChange={(v) => updateConfig("quality", v as VideoStudioConfig["quality"])}>
                  <SelectTrigger className="h-7 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2k">2K 60fps</SelectItem>
                    <SelectItem value="2k120">2K 120fps</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Transform controls — shown when object selected in scene view */}
              {viewMode === "scene" && selectionInfo.type && (
                <div className="rounded-lg border-2 border-blue-600/60 bg-card/30 overflow-hidden">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                    onClick={() => toggleSection("transform")}
                  >
                    <Move className="h-3.5 w-3.5 text-blue-400" />
                    <span className="text-blue-300">{selectionInfo.type}</span>
                    <span className="flex-1" />
                    {expandedSections.has("transform") ? (
                      <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                  {expandedSections.has("transform") && (
                    <div className="px-3 pb-3 pt-2 border-t border-blue-600/30 space-y-3">
                      {/* Mode buttons */}
                      <div className="flex gap-1">
                        <Button
                          variant={transformMode === "translate" ? "secondary" : "ghost"}
                          size="sm"
                          className="flex-1 h-7 text-xs"
                          onClick={() => {
                            sceneViewControlsRef.current?.setTransformMode("translate");
                            setTransformMode("translate");
                          }}
                        >
                          <Move className="h-3 w-3 mr-1" /> Di chuyển
                        </Button>
                        <Button
                          variant={transformMode === "rotate" ? "secondary" : "ghost"}
                          size="sm"
                          className="flex-1 h-7 text-xs"
                          onClick={() => {
                            sceneViewControlsRef.current?.setTransformMode("rotate");
                            setTransformMode("rotate");
                          }}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" /> Xoay
                        </Button>
                        <Button
                          variant={transformMode === "scale" ? "secondary" : "ghost"}
                          size="sm"
                          className="flex-1 h-7 text-xs"
                          onClick={() => {
                            sceneViewControlsRef.current?.setTransformMode("scale");
                            setTransformMode("scale");
                          }}
                        >
                          <Maximize2 className="h-3 w-3 mr-1" /> Tỷ lệ
                        </Button>
                      </div>
                      {/* Editable value inputs */}
                      {transformValues && (
                        <div className="space-y-2">
                          <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Vị trí</Label>
                            <div className="grid grid-cols-3 gap-1.5">
                              <TransformInput label="X" value={transformValues.position.x} onChange={(v) => applyTransformValue("x", "position", v)} />
                              <TransformInput label="Y" value={transformValues.position.y} onChange={(v) => applyTransformValue("y", "position", v)} />
                              <TransformInput label="Z" value={transformValues.position.z} onChange={(v) => applyTransformValue("z", "position", v)} />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Xoay</Label>
                            <div className="grid grid-cols-3 gap-1.5">
                              <TransformInput label="X" value={transformValues.rotation.x} onChange={(v) => applyTransformValue("x", "rotation", v)} suffix="°" />
                              <TransformInput label="Y" value={transformValues.rotation.y} onChange={(v) => applyTransformValue("y", "rotation", v)} suffix="°" />
                              <TransformInput label="Z" value={transformValues.rotation.z} onChange={(v) => applyTransformValue("z", "rotation", v)} suffix="°" />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Tỷ lệ</Label>
                            <div className="grid grid-cols-3 gap-1.5">
                              <TransformInput label="X" value={transformValues.scale.x} onChange={(v) => applyTransformValue("x", "scale", v)} />
                              <TransformInput label="Y" value={transformValues.scale.y} onChange={(v) => applyTransformValue("y", "scale", v)} />
                              <TransformInput label="Z" value={transformValues.scale.z} onChange={(v) => applyTransformValue("z", "scale", v)} />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ---- Dynamic section cards ---- */}
              {(() => {
                // The active (auto-expanded by selection) section renders first, rest in default order
                const defaultOrder = ["cue", "camera", "cue-hdri", "lights", "background", "shadow"] as const;
                const active = autoExpandedSectionRef.current;
                const ordered = active ? [active, ...defaultOrder.filter((s) => s !== active)] : [...defaultOrder];

                return ordered.map((sectionId) => {
                  switch (sectionId) {
                    case "cue":
                      return (
                        <div key="cue" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                            onClick={() => toggleSection("cue")}
                          >
                            <Box className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>Thiết lập Cơ</span>
                            <span className="flex-1" />
                            {expandedSections.has("cue") ? (
                              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </button>
                          {expandedSections.has("cue") && (
                            <div className="px-3 pb-3 pt-2 border-t border-border/30">
                              <CueSetupPanel cueConfig={config.cueConfig} onChange={(cueConfig) => updateConfig("cueConfig", cueConfig)} />
                            </div>
                          )}
                        </div>
                      );
                    case "camera":
                      return (
                        <div key="camera" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                            onClick={() => toggleSection("camera")}
                          >
                            <Camera className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>Máy ảnh</span>
                            <span className="flex-1" />
                            {expandedSections.has("camera") ? (
                              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </button>
                          {expandedSections.has("camera") && (
                            <div className="px-3 pb-3 pt-2 border-t border-border/30">
                              <CameraControlsPanel
                                cameraDirection={config.cameraDirection}
                                cameraStart={config.cameraStart}
                                cameraEnd={config.cameraEnd}
                                cameraSpeed={config.cameraSpeed}
                                easing={config.easing}
                                onDirectionChange={(d) => updateConfig("cameraDirection", d)}
                                onStartChange={(s) => updateConfig("cameraStart", s)}
                                onEndChange={(e) => updateConfig("cameraEnd", e)}
                                onSpeedChange={(s) => updateConfig("cameraSpeed", s)}
                                onEasingChange={(e) => updateConfig("easing", e)}
                                onSetStart={handleSetStart}
                                onSetEnd={handleSetEnd}
                              />
                            </div>
                          )}
                        </div>
                      );
                    case "background":
                      return (
                        <div key="background" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                            onClick={() => toggleSection("background")}
                          >
                            <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>Nền</span>
                            <span className="flex-1" />
                            {expandedSections.has("background") ? (
                              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </button>
                          {expandedSections.has("background") && (
                            <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                              <BackgroundPanel
                                wallSurface={config.wallSurface}
                                tableSurface={config.tableSurface}
                                onWallSurfaceChange={(s) => updateConfig("wallSurface", s)}
                                onTableSurfaceChange={(s) => updateConfig("tableSurface", s)}
                              />
                            </div>
                          )}
                        </div>
                      );
                    case "cue-hdri":
                      return (
                        <div key="cue-hdri" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                            onClick={() => toggleSection("cue-hdri")}
                          >
                            <Sun className="h-3.5 w-3.5 text-yellow-400" />
                            <span>HDRI Cơ</span>
                            <span className="flex-1" />
                            {expandedSections.has("cue-hdri") ? (
                              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </button>
                          {expandedSections.has("cue-hdri") && (
                            <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                              <p className="text-[10px] text-muted-foreground">Môi trường HDRI chỉ áp dụng cho cơ (không áp dụng cho bề mặt studio).</p>
                              {/* HDRI Type */}
                              <div className="space-y-0.5">
                                <Label className="text-[10px] text-muted-foreground">Môi trường</Label>
                                <Select
                                  value={config.cueHdri?.hdriType ?? DEFAULT_CUE_HDRI.hdriType}
                                  onValueChange={(v) => {
                                    setConfig((prev) => ({
                                      ...prev,
                                      cueHdri: { ...(prev.cueHdri ?? DEFAULT_CUE_HDRI), hdriType: v },
                                    }));
                                  }}
                                >
                                  <SelectTrigger className="h-6 text-[10px]">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {HDRI_OPTIONS_FALLBACK.filter((h) => h.id !== STUDIO_WHITE_HDRI).map((h) => (
                                      <SelectItem key={h.id} value={h.id}>
                                        {h.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              {/* Rotation Y (Horizontal) */}
                              <div className="space-y-0.5">
                                <Label className="text-[10px] text-muted-foreground">Ngang — {(config.cueHdri?.rotationY ?? DEFAULT_CUE_HDRI.rotationY).toFixed(0)}°</Label>
                                <Slider
                                  value={[config.cueHdri?.rotationY ?? DEFAULT_CUE_HDRI.rotationY]}
                                  onValueChange={([v]) => {
                                    setConfig((prev) => ({
                                      ...prev,
                                      cueHdri: { ...(prev.cueHdri ?? DEFAULT_CUE_HDRI), rotationY: v },
                                    }));
                                  }}
                                  min={0}
                                  max={360}
                                  step={1}
                                />
                              </div>
                              {/* Rotation X (Vertical) */}
                              <div className="space-y-0.5">
                                <Label className="text-[10px] text-muted-foreground">Dọc — {(config.cueHdri?.rotationX ?? DEFAULT_CUE_HDRI.rotationX).toFixed(0)}°</Label>
                                <Slider
                                  value={[config.cueHdri?.rotationX ?? DEFAULT_CUE_HDRI.rotationX]}
                                  onValueChange={([v]) => {
                                    setConfig((prev) => ({
                                      ...prev,
                                      cueHdri: { ...(prev.cueHdri ?? DEFAULT_CUE_HDRI), rotationX: v },
                                    }));
                                  }}
                                  min={0}
                                  max={360}
                                  step={1}
                                />
                              </div>
                              {/* Intensity */}
                              <div className="space-y-0.5">
                                <Label className="text-[10px] text-muted-foreground">
                                  Cường độ — {((config.cueHdri?.intensity ?? DEFAULT_CUE_HDRI.intensity) * 100).toFixed(0)}%
                                </Label>
                                <Slider
                                  value={[config.cueHdri?.intensity ?? DEFAULT_CUE_HDRI.intensity]}
                                  onValueChange={([v]) => {
                                    setConfig((prev) => ({
                                      ...prev,
                                      cueHdri: { ...(prev.cueHdri ?? DEFAULT_CUE_HDRI), intensity: v },
                                    }));
                                  }}
                                  min={0}
                                  max={3}
                                  step={0.05}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    case "lights":
                      return (
                        <div key="lights" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                          <div className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors">
                            <div
                              role="button"
                              tabIndex={0}
                              className="flex items-center gap-2 flex-1 cursor-pointer"
                              onClick={() => toggleSection("lights")}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggleSection("lights");
                                }
                              }}
                            >
                              <Lightbulb className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>Đèn Studio</span>
                              <span className="ml-1 text-muted-foreground/60">
                                ({config.hdriConfig.layers.filter((l) => l.enabled !== false).length}/{config.hdriConfig.layers.length})
                              </span>
                            </div>
                            {config.hdriConfig.layers.length < 3 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 p-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const layers = [...config.hdriConfig.layers];
                                  const newLayer = createDefaultHdriLayer();
                                  // Offset rotation for each new layer
                                  newLayer.rotationY = (layers.length * 120) % 360;
                                  newLayer.intensity = 0.5;
                                  layers.push(newLayer);
                                  setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                }}
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                            )}
                            <div
                              role="button"
                              tabIndex={0}
                              className="cursor-pointer"
                              onClick={() => toggleSection("lights")}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggleSection("lights");
                                }
                              }}
                            >
                              {expandedSections.has("lights") ? (
                                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </div>
                          </div>
                          {expandedSections.has("lights") && (
                            <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                              <p className="text-[10px] text-muted-foreground">Đèn studio kiểm soát hướng bóng và ánh sáng bề mặt. Nhấn G để di chuyển, S để thu phóng.</p>
                              {config.hdriConfig.layers.map((layer, idx) => (
                                <div key={layer.id} className="rounded-md border border-border/40 bg-background/30 p-2 space-y-2">
                                  {/* Header */}
                                  <div className="flex items-center gap-1.5">
                                    <Checkbox
                                      checked={layer.enabled !== false}
                                      onCheckedChange={(checked) => {
                                        const layers = [...config.hdriConfig.layers];
                                        layers[idx] = { ...layers[idx], enabled: checked === true };
                                        setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                      }}
                                      className="h-3 w-3"
                                    />
                                    <Sun className="h-3 w-3 text-green-400" />
                                    <span className="text-[10px] font-medium flex-1">Đèn Studio {idx + 1}</span>
                                    {config.hdriConfig.layers.length > 1 && (
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                                        onClick={() => {
                                          const layers = config.hdriConfig.layers.filter((_, i) => i !== idx);
                                          setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                        }}
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </Button>
                                    )}
                                  </div>
                                  {/* Studio lights are always Studio White — no HDRI dropdown */}
                                  <div className="space-y-0.5">
                                    <Label className="text-[10px] text-muted-foreground">Môi trường</Label>
                                    <div className="h-6 px-2 flex items-center rounded-md border border-border/40 bg-muted/30 text-[10px] text-muted-foreground">Studio White</div>
                                  </div>
                                  {/* Light Color */}
                                  <div className="space-y-0.5">
                                    <Label className="text-[10px] text-muted-foreground">Màu đèn</Label>
                                    <div className="flex items-center gap-1.5">
                                      <input
                                        type="color"
                                        value={layer.lightColor ?? "#ffffff"}
                                        onChange={(e) => {
                                          const layers = [...config.hdriConfig.layers];
                                          layers[idx] = { ...layers[idx], lightColor: e.target.value };
                                          setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                        }}
                                        className="w-6 h-6 rounded cursor-pointer border border-border/50 p-0"
                                      />
                                      <span className="text-[10px] text-muted-foreground font-mono">{(layer.lightColor ?? "#ffffff").toUpperCase()}</span>
                                    </div>
                                  </div>
                                  {/* Intensity */}
                                  <div className="space-y-0.5">
                                    <Label className="text-[10px] text-muted-foreground">Cường độ — {((layer.intensity ?? 1) * 100).toFixed(0)}%</Label>
                                    <Slider
                                      value={[layer.intensity ?? 1]}
                                      onValueChange={([v]) => {
                                        const layers = [...config.hdriConfig.layers];
                                        layers[idx] = { ...layers[idx], intensity: v };
                                        setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                      }}
                                      min={0}
                                      max={3}
                                      step={0.05}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    case "shadow":
                      return (
                        <div key="shadow" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                          <div
                            role="button"
                            tabIndex={0}
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors cursor-pointer"
                            onClick={() => toggleSection("shadow")}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggleSection("shadow");
                              }
                            }}
                          >
                            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>Bóng</span>
                            <span className="flex-1" />
                            <Checkbox
                              checked={config.shadow.enabled}
                              onCheckedChange={(checked) => {
                                updateConfig("shadow", {
                                  ...config.shadow,
                                  enabled: checked === true,
                                });
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="h-3.5 w-3.5"
                            />
                            {expandedSections.has("shadow") ? (
                              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </div>
                          {expandedSections.has("shadow") && config.shadow.enabled && (
                            <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                              <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground">Cường độ — {Math.round(config.shadow.intensity * 100)}%</Label>
                                <Slider
                                  value={[config.shadow.intensity]}
                                  onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, intensity: v })}
                                  min={0}
                                  max={1}
                                  step={0.05}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground">Làm mờ — {config.shadow.blur ?? 3}</Label>
                                <Slider
                                  value={[config.shadow.blur ?? 3]}
                                  onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, blur: v })}
                                  min={0}
                                  max={10}
                                  step={0.5}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground">Độ mềm — {((config.shadow.softness ?? 0.45) * 100).toFixed(0)}%</Label>
                                <Slider
                                  value={[config.shadow.softness ?? 0.45]}
                                  onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, softness: v })}
                                  min={0}
                                  max={1}
                                  step={0.05}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground">Bù X — {(config.shadow.offsetX ?? 0).toFixed(1)}</Label>
                                <Slider
                                  value={[config.shadow.offsetX ?? 0]}
                                  onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, offsetX: v })}
                                  min={-5}
                                  max={5}
                                  step={0.2}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground">Bù Y — {(config.shadow.offsetY ?? 0).toFixed(1)}</Label>
                                <Slider
                                  value={[config.shadow.offsetY ?? 0]}
                                  onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, offsetY: v })}
                                  min={-5}
                                  max={5}
                                  step={0.2}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    default:
                      return null;
                  }
                });
              })()}
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-6 py-4 border-t border-border">
          <div className="flex items-center gap-2 w-full">
            <Button variant="outline" size="sm" onClick={handleReset} disabled={isRecording}>
              <RotateCcw className="h-4 w-4 mr-1" /> Đặt lại
            </Button>
            <div className="flex-1" />
            {isRecording ? (
              <Button variant="destructive" size="sm" onClick={handleStop}>
                <Square className="h-4 w-4 mr-1" /> Dừng
              </Button>
            ) : videoUrl ? (
              <>
                <Button variant="outline" size="sm" onClick={handleRecord}>
                  <RefreshCw className="h-4 w-4 mr-1" /> Ghi lại
                </Button>
                <Button size="sm" onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-1" /> Tải xuống
                </Button>
              </>
            ) : (
              <>
                {(() => {
                  const sec = computeVideoDuration(config.cameraStart, config.cameraEnd, config.cameraSpeed, config.cameraDirection);
                  const m = Math.floor(sec / 60);
                  const s = Math.round(sec % 60);
                  const label = m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${sec.toFixed(1)}s`;
                  return <span className="text-xs text-muted-foreground tabular-nums">{label}</span>;
                })()}
                <Button size="sm" onClick={handleRecord}>
                  <Video className="h-4 w-4 mr-1" /> Ghi
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" onClick={() => templateSelectorRef.current?.triggerSave()} disabled={isRecording}>
              <Save className="h-4 w-4 mr-1" /> Lưu Mẫu
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
