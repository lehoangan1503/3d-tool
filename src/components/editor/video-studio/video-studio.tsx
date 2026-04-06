"use client";

import * as THREE from "three";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
} from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import {
  ExtractorSceneManager,
  HDRI_OPTIONS_FALLBACK,
} from "@/lib/three/extractor-scene-manager";
import type { VideoStudioConfig, CameraKeyframe } from "@/types/video-studio";
import {
  DEFAULT_STUDIO_CONFIG,
  computeVideoDuration,
} from "@/types/video-studio";
import { CameraControlsPanel } from "./camera-controls-panel";
import { CueSetupPanel } from "./cue-setup-panel";
import { BackgroundPanel } from "./background-panel";
import { StudioTemplateSelector } from "./studio-template-selector";
import { SceneViewControls, type SelectionInfo } from "./scene-view-controls";

/** Inline editable number field for transform values */
function TransformInput({
  label,
  value,
  onChange,
  suffix = "",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
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

export function VideoStudio({
  sceneManager,
  productName,
  productId,
  onClose,
  open,
}: VideoStudioProps) {
  const [config, setConfig] = useState<VideoStudioConfig>(() =>
    structuredClone(DEFAULT_STUDIO_CONFIG)
  );
  const [isRecording, setIsRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [viewMode, setViewMode] = useState<"scene" | "camera">("camera");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo>({ type: null });
  const [transformValues, setTransformValues] = useState<{
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
  } | null>(null);
  const [transformMode, setTransformMode] = useState<"translate" | "rotate" | "scale">("translate");
  // Track which section was auto-opened by selection (so we can close it on deselect)
  const autoExpandedSectionRef = useRef<string | null>(null);

  // Undo/redo history
  const configHistoryRef = useRef<VideoStudioConfig[]>([]);
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

  // Keep a ref to config so SceneViewControls callback always reads latest
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
    // Debounced history push: batch rapid changes (sliders) into one entry
    if (!isUndoRedoRef.current && !isDraggingRef.current) {
      if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current);
      historyDebounceRef.current = setTimeout(() => {
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
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
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

  const updateConfig = useCallback(
    <K extends keyof VideoStudioConfig>(key: K, value: VideoStudioConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const toggleSection = useCallback((id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const applyTransformValue = useCallback((
    axis: "x" | "y" | "z",
    prop: "position" | "rotation" | "scale",
    value: number
  ) => {
    if (!transformValues || !sceneViewControlsRef.current) return;
    const newValues = structuredClone(transformValues);
    newValues[prop][axis] = value;
    setTransformValues(newValues);

    const pos = new THREE.Vector3(newValues.position.x, newValues.position.y, newValues.position.z);
    const rot = new THREE.Euler(
      THREE.MathUtils.degToRad(newValues.rotation.x),
      THREE.MathUtils.degToRad(newValues.rotation.y),
      THREE.MathUtils.degToRad(newValues.rotation.z)
    );
    const scl = new THREE.Vector3(newValues.scale.x, newValues.scale.y, newValues.scale.z);
    sceneViewControlsRef.current.applyTransform(pos, rot, scl);
  }, [transformValues]);

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
                const kf = extractorRef.current.getCameraKeyframeFromPosition(configRef.current.cueConfig);
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
                const frames = prev.wallSurface.frames.map((f) =>
                  f.id === info.frameId
                    ? { ...f, x: position.x / 34 + 0.5, y: 0.5 - position.y / 24 }
                    : f
                );
                return { ...prev, wallSurface: { ...prev.wallSurface, frames } };
              });
            } else if (info.type === "tableFrame" && info.frameId) {
              setConfig((prev) => {
                const frames = prev.tableSurface.frames.map((f) =>
                  f.id === info.frameId
                    ? { ...f, x: position.x / 34 + 0.5, y: position.z / 12 + 0.5 }
                    : f
                );
                return { ...prev, tableSurface: { ...prev.tableSurface, frames } };
              });
            }
          },
          // Transform mode change (G/R/S keys)
          (mode) => {
            setTransformMode(mode);
          },
          // Drag start: suppress history pushes during drag
          () => { isDraggingRef.current = true; },
          // Drag end: commit final state to history
          () => {
            isDraggingRef.current = false;
            if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current);
            configHistoryRef.current = [...configHistoryRef.current.slice(-4), configRef.current];
            configFutureRef.current = [];
          }
        );
      }

      await extractor.setupStudioFromStudioConfig(config);
      extractor.startStudioVideoPreview(config);

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
    // Cancel pending lightweight update — rebuild supersedes it
    if (updateTimerRef.current) { clearTimeout(updateTimerRef.current); updateTimerRef.current = null; }
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(() => {
      rebuildScene();
      rebuildTimerRef.current = null;
    }, 500);
    return () => {
      if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.wallSurface, config.tableSurface, config.hdriFile, config.shadow.enabled, config.cueConfig.instances.length, open]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, []);

  const handleSetStart = useCallback(() => {
    if (!extractorRef.current) return;
    const kf = extractorRef.current.getCameraKeyframeFromPosition(config.cueConfig);
    setConfig((prev) => ({ ...prev, cameraStart: kf }));
  }, [config.cueConfig]);

  const handleSetEnd = useCallback(() => {
    if (!extractorRef.current) return;
    const kf = extractorRef.current.getCameraKeyframeFromPosition(config.cueConfig);
    setConfig((prev) => ({ ...prev, cameraEnd: kf }));
  }, [config.cueConfig]);

  const handleRecord = async () => {
    if (!extractorRef.current) return;
    setIsRecording(true);
    setProgress(0);
    setError(null);
    setVideoUrl(null);
    sceneViewControlsRef.current?.setEnabled(false);

    try {
      const blob = await extractorRef.current.startStudioRecording(config, (p) =>
        setProgress(p)
      );
      const url = URL.createObjectURL(blob);
      blobUrlsRef.current.push(url);
      videoUrlRef.current = url;
      setVideoUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed");
    } finally {
      setIsRecording(false);
      sceneViewControlsRef.current?.setEnabled(true);
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
    const a = document.createElement("a");
    a.href = videoUrl;
    a.download = `${productName}-studio-video.webm`;
    a.click();
  };

  const handleReset = () => {
    setConfig(structuredClone(DEFAULT_STUDIO_CONFIG));
    setVideoUrl(null);
    setError(null);
  };

  const duration = computeVideoDuration(
    config.cameraStart,
    config.cameraEnd,
    config.cameraSpeed
  );

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
          <DialogTitle className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <Video className="h-5 w-5" /> Video Studio
            </div>
            <div className="flex-1 flex items-center justify-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={undo}
                title="Undo (Ctrl+Z)"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={redo}
                title="Redo (Ctrl+Shift+Z)"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant={viewMode === "camera" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setViewMode("camera")}
              >
                <Camera className="h-3 w-3 mr-1" /> Camera
              </Button>
              <Button
                variant={viewMode === "scene" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setViewMode("scene")}
              >
                <Eye className="h-3 w-3 mr-1" /> Scene
              </Button>
            </div>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Create cinematic videos of {productName}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* Left: Preview */}
          <div className="flex-1 flex flex-col p-4 min-w-0">
            <div
              ref={previewContainerRef}
              className="flex-1 bg-black rounded-lg overflow-hidden relative"
            >
              {isRebuilding && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
                  <Loader2 className="h-6 w-6 animate-spin text-white" />
                </div>
              )}
            </div>

            {/* Key hints for scene view */}
            {viewMode === "scene" && (
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground px-1 flex-wrap">
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">G</span>
                <span>Move</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">R</span>
                <span>Rotate</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">S</span>
                <span>Scale</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">Esc</span>
                <span>Deselect</span>
                <span className="text-muted-foreground/60">— click to select, drag to orbit</span>
              </div>
            )}

            {/* Progress bar during recording */}
            {isRecording && (
              <div className="mt-2">
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1 text-center">
                  Recording... {progress}%
                </p>
              </div>
            )}

            {/* Video playback */}
            {videoUrl && !isRecording && (
              <div className="mt-2">
                <video
                  src={videoUrl}
                  controls
                  className="w-full rounded-lg max-h-24"
                />
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
          <div className="w-80 shrink-0 border-l border-border overflow-y-auto p-4 space-y-3">
            {/* Camera minimap — live preview, fixed at top */}
            {viewMode === "scene" && (
              <div className="relative rounded-lg overflow-hidden border border-border/50 bg-black">
                <canvas
                  ref={minimapCanvasRef}
                  width={576}
                  height={324}
                  className="w-full h-auto block"
                />
                <span className="absolute top-1.5 left-2 text-[9px] text-white/70 font-medium bg-black/40 px-1.5 py-0.5 rounded">
                  Camera View
                </span>
              </div>
            )}

            {/* Template selector — always visible at top */}
            <StudioTemplateSelector
              productId={productId}
              currentConfig={config}
              onLoadConfig={(c) => setConfig(c)}
            />

            {/* Quality & Duration — always visible */}
            <div className="flex items-center gap-2 text-xs">
              <Select
                value={config.quality}
                onValueChange={(v) =>
                  updateConfig("quality", v as VideoStudioConfig["quality"])
                }
              >
                <SelectTrigger className="h-7 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hd">HD 1080p</SelectItem>
                  <SelectItem value="2k">2K 1440p</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-muted-foreground">·</span>
              <span className="font-mono text-muted-foreground">{duration.toFixed(1)}s</span>
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
                  {expandedSections.has("transform") ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                </button>
                {expandedSections.has("transform") && (
                  <div className="px-3 pb-3 pt-2 border-t border-blue-600/30 space-y-3">
                    {/* Mode buttons */}
                    <div className="flex gap-1">
                      <Button
                        variant={transformMode === "translate" ? "secondary" : "ghost"}
                        size="sm"
                        className="flex-1 h-7 text-xs"
                        onClick={() => { sceneViewControlsRef.current?.setTransformMode("translate"); setTransformMode("translate"); }}
                      >
                        <Move className="h-3 w-3 mr-1" /> Move
                      </Button>
                      <Button
                        variant={transformMode === "rotate" ? "secondary" : "ghost"}
                        size="sm"
                        className="flex-1 h-7 text-xs"
                        onClick={() => { sceneViewControlsRef.current?.setTransformMode("rotate"); setTransformMode("rotate"); }}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" /> Rotate
                      </Button>
                      <Button
                        variant={transformMode === "scale" ? "secondary" : "ghost"}
                        size="sm"
                        className="flex-1 h-7 text-xs"
                        onClick={() => { sceneViewControlsRef.current?.setTransformMode("scale"); setTransformMode("scale"); }}
                      >
                        <Maximize2 className="h-3 w-3 mr-1" /> Scale
                      </Button>
                    </div>
                    {/* Editable value inputs */}
                    {transformValues && (
                      <div className="space-y-2">
                        <div className="space-y-1">
                          <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Position</Label>
                          <div className="grid grid-cols-3 gap-1.5">
                            <TransformInput label="X" value={transformValues.position.x} onChange={(v) => applyTransformValue("x", "position", v)} />
                            <TransformInput label="Y" value={transformValues.position.y} onChange={(v) => applyTransformValue("y", "position", v)} />
                            <TransformInput label="Z" value={transformValues.position.z} onChange={(v) => applyTransformValue("z", "position", v)} />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Rotation</Label>
                          <div className="grid grid-cols-3 gap-1.5">
                            <TransformInput label="X" value={transformValues.rotation.x} onChange={(v) => applyTransformValue("x", "rotation", v)} suffix="°" />
                            <TransformInput label="Y" value={transformValues.rotation.y} onChange={(v) => applyTransformValue("y", "rotation", v)} suffix="°" />
                            <TransformInput label="Z" value={transformValues.rotation.z} onChange={(v) => applyTransformValue("z", "rotation", v)} suffix="°" />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Scale</Label>
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
              const defaultOrder = ["cue", "camera", "hdri", "background", "shadow"] as const;
              const active = autoExpandedSectionRef.current;
              const ordered = active
                ? [active, ...defaultOrder.filter((s) => s !== active)]
                : [...defaultOrder];

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
                          <span>Cue Setup</span>
                          <span className="flex-1" />
                          {expandedSections.has("cue") ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                        </button>
                        {expandedSections.has("cue") && (
                          <div className="px-3 pb-3 pt-2 border-t border-border/30">
                            <CueSetupPanel
                              cueConfig={config.cueConfig}
                              onChange={(cueConfig) => updateConfig("cueConfig", cueConfig)}
                            />
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
                          <span>Camera</span>
                          <span className="flex-1" />
                          {expandedSections.has("camera") ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                        </button>
                        {expandedSections.has("camera") && (
                          <div className="px-3 pb-3 pt-2 border-t border-border/30">
                            <CameraControlsPanel
                              cameraDirection={config.cameraDirection}
                              cameraStart={config.cameraStart}
                              cameraEnd={config.cameraEnd}
                              cameraSpeed={config.cameraSpeed}
                              lockDistance={config.lockDistance}
                              easing={config.easing}
                              onDirectionChange={(d) => updateConfig("cameraDirection", d)}
                              onStartChange={(s) => updateConfig("cameraStart", s)}
                              onEndChange={(e) => updateConfig("cameraEnd", e)}
                              onSpeedChange={(s) => updateConfig("cameraSpeed", s)}
                              onLockDistanceChange={(l) => updateConfig("lockDistance", l)}
                              onEasingChange={(e) => updateConfig("easing", e)}
                              onSetStart={handleSetStart}
                              onSetEnd={handleSetEnd}
                            />
                          </div>
                        )}
                      </div>
                    );
                  case "hdri":
                    return (
                      <div key="hdri" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                          onClick={() => toggleSection("hdri")}
                        >
                          <Sun className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>HDRI Lighting</span>
                          <span className="flex-1" />
                          {expandedSections.has("hdri") ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                        </button>
                        {expandedSections.has("hdri") && (
                          <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Environment
                              </Label>
                              <Select
                                value={config.hdriFile}
                                onValueChange={(v) => updateConfig("hdriFile", v)}
                              >
                                <SelectTrigger className="h-8">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {HDRI_OPTIONS_FALLBACK.map((h) => (
                                    <SelectItem key={h.id} value={h.id}>
                                      {h.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Rotation X — {config.hdriConfig.layers[0]?.rotationX ?? 0}°
                              </Label>
                              <Slider
                                value={[config.hdriConfig.layers[0]?.rotationX ?? 0]}
                                onValueChange={([v]) => {
                                  const layers = [...config.hdriConfig.layers];
                                  if (layers[0]) layers[0] = { ...layers[0], rotationX: v };
                                  updateConfig("hdriConfig", { layers });
                                }}
                                min={0} max={360} step={1}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Rotation Y — {config.hdriConfig.layers[0]?.rotationY ?? 0}°
                              </Label>
                              <Slider
                                value={[config.hdriConfig.layers[0]?.rotationY ?? 0]}
                                onValueChange={([v]) => {
                                  const layers = [...config.hdriConfig.layers];
                                  if (layers[0]) layers[0] = { ...layers[0], rotationY: v };
                                  updateConfig("hdriConfig", { layers });
                                }}
                                min={0} max={360} step={1}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Intensity — {((config.hdriIntensity ?? 1.0) * 100).toFixed(0)}%
                              </Label>
                              <Slider
                                value={[config.hdriIntensity ?? 1.0]}
                                onValueChange={([v]) => updateConfig("hdriIntensity", v)}
                                min={0} max={3} step={0.05}
                              />
                            </div>
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
                          <span>Background</span>
                          <span className="flex-1" />
                          {expandedSections.has("background") ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                        </button>
                        {expandedSections.has("background") && (
                          <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                            <BackgroundPanel
                              wallSurface={config.wallSurface}
                              tableSurface={config.tableSurface}
                              onWallSurfaceChange={(s) => updateConfig("wallSurface", s)}
                              onTableSurfaceChange={(s) => updateConfig("tableSurface", s)}
                            />
                            {/* Surface HDRI */}
                            <div className="rounded-md border border-border/30 p-2 space-y-2">
                              <div className="flex items-center gap-2">
                                <Checkbox
                                  checked={config.surfaceHdri?.enabled ?? false}
                                  onCheckedChange={(checked) =>
                                    updateConfig("surfaceHdri", {
                                      ...(config.surfaceHdri ?? { enabled: false, hdriFile: config.hdriFile, rotationX: 0, rotationY: 0, intensity: 0.3 }),
                                      enabled: checked === true,
                                    })
                                  }
                                  className="h-3.5 w-3.5"
                                />
                                <Label className="text-xs text-muted-foreground">Surface HDRI</Label>
                              </div>
                              {config.surfaceHdri?.enabled && (
                                <div className="space-y-2 pl-1">
                                  <div className="space-y-1">
                                    <Label className="text-[10px] text-muted-foreground">Environment</Label>
                                    <Select
                                      value={config.surfaceHdri.hdriFile}
                                      onValueChange={(v) =>
                                        updateConfig("surfaceHdri", { ...config.surfaceHdri, hdriFile: v })
                                      }
                                    >
                                      <SelectTrigger className="h-7 text-[10px]">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {HDRI_OPTIONS_FALLBACK.map((h) => (
                                          <SelectItem key={h.id} value={h.id}>
                                            {h.label}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-[10px] text-muted-foreground">
                                      Intensity — {((config.surfaceHdri.intensity ?? 0.3) * 100).toFixed(0)}%
                                    </Label>
                                    <Slider
                                      value={[config.surfaceHdri.intensity ?? 0.3]}
                                      onValueChange={([v]) =>
                                        updateConfig("surfaceHdri", { ...config.surfaceHdri, intensity: v })
                                      }
                                      min={0} max={2} step={0.05}
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-[10px] text-muted-foreground">
                                      Rotation X — {config.surfaceHdri.rotationX ?? 0}°
                                    </Label>
                                    <Slider
                                      value={[config.surfaceHdri.rotationX ?? 0]}
                                      onValueChange={([v]) =>
                                        updateConfig("surfaceHdri", { ...config.surfaceHdri, rotationX: v })
                                      }
                                      min={0} max={360} step={1}
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-[10px] text-muted-foreground">
                                      Rotation Y — {config.surfaceHdri.rotationY ?? 0}°
                                    </Label>
                                    <Slider
                                      value={[config.surfaceHdri.rotationY ?? 0]}
                                      onValueChange={([v]) =>
                                        updateConfig("surfaceHdri", { ...config.surfaceHdri, rotationY: v })
                                      }
                                      min={0} max={360} step={1}
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
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
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection("shadow"); } }}
                        >
                          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>Shadow</span>
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
                          {expandedSections.has("shadow") ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                        </div>
                        {expandedSections.has("shadow") && config.shadow.enabled && (
                          <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Intensity — {Math.round(config.shadow.intensity * 100)}%
                              </Label>
                              <Slider
                                value={[config.shadow.intensity]}
                                onValueChange={([v]) =>
                                  updateConfig("shadow", { ...config.shadow, intensity: v })
                                }
                                min={0} max={1} step={0.05}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Blur — {config.shadow.blur ?? 3}
                              </Label>
                              <Slider
                                value={[config.shadow.blur ?? 3]}
                                onValueChange={([v]) =>
                                  updateConfig("shadow", { ...config.shadow, blur: v })
                                }
                                min={0} max={10} step={0.5}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Softness — {((config.shadow.softness ?? 0.45) * 100).toFixed(0)}%
                              </Label>
                              <Slider
                                value={[config.shadow.softness ?? 0.45]}
                                onValueChange={([v]) =>
                                  updateConfig("shadow", { ...config.shadow, softness: v })
                                }
                                min={0} max={1} step={0.05}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Offset X — {(config.shadow.offsetX ?? 0).toFixed(1)}
                              </Label>
                              <Slider
                                value={[config.shadow.offsetX ?? 0]}
                                onValueChange={([v]) =>
                                  updateConfig("shadow", { ...config.shadow, offsetX: v })
                                }
                                min={-5} max={5} step={0.2}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Offset Y — {(config.shadow.offsetY ?? 0).toFixed(1)}
                              </Label>
                              <Slider
                                value={[config.shadow.offsetY ?? 0]}
                                onValueChange={([v]) =>
                                  updateConfig("shadow", { ...config.shadow, offsetY: v })
                                }
                                min={-5} max={5} step={0.2}
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

        {/* Footer */}
        <DialogFooter className="px-6 py-4 border-t border-border">
          <div className="flex items-center gap-2 w-full">
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={isRecording}
            >
              <RotateCcw className="h-4 w-4 mr-1" /> Reset
            </Button>
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={isRecording}
            >
              Cancel
            </Button>
            {isRecording ? (
              <Button variant="destructive" size="sm" onClick={handleStop}>
                <Square className="h-4 w-4 mr-1" /> Stop
              </Button>
            ) : videoUrl ? (
              <Button size="sm" onClick={handleDownload}>
                <Download className="h-4 w-4 mr-1" /> Download
              </Button>
            ) : (
              <Button size="sm" onClick={handleRecord}>
                <Video className="h-4 w-4 mr-1" /> Record
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
