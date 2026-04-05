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

  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const videoUrlRef = useRef<string | null>(null);
  const blobUrlsRef = useRef<string[]>([]);
  const sceneViewControlsRef = useRef<SceneViewControls | null>(null);

  // Keep a ref to config so SceneViewControls callback always reads latest
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

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
          // Selection change → update selection info + auto-expand matching section
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
            } else {
              setTransformValues(null);
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
                  };
                }
                return { ...prev, cueConfig: { ...prev.cueConfig, instances } };
              });
            } else if (info.type === "wallFrame" && info.frameId) {
              setConfig((prev) => {
                const frames = prev.wallSurface.frames.map((f) =>
                  f.id === info.frameId
                    ? { ...f, x: position.x / 34 + 0.5, y: 0.5 - position.y / 22 }
                    : f
                );
                return { ...prev, wallSurface: { ...prev.wallSurface, frames } };
              });
            } else if (info.type === "tableFrame" && info.frameId) {
              setConfig((prev) => {
                const frames = prev.tableSurface.frames.map((f) =>
                  f.id === info.frameId
                    ? { ...f, x: position.x / 28 + 0.5, y: position.z / 5 + 0.5 }
                    : f
                );
                return { ...prev, tableSurface: { ...prev.tableSurface, frames } };
              });
            }
          },
          // Transform mode change (G/R/S keys)
          (mode) => {
            setTransformMode(mode);
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

  // Sync view mode to extractor
  useEffect(() => {
    if (!extractorRef.current) return;
    extractorRef.current.setViewMode(viewMode);
  }, [viewMode]);

  // Debounced preview updates on config change
  useEffect(() => {
    if (!extractorRef.current || !open) return;
    const timer = setTimeout(() => {
      extractorRef.current?.updateStudioPreviewConfig(config);
    }, 100);
    return () => clearTimeout(timer);
  }, [config, open]);

  // Rebuild scene for expensive changes (backgrounds, HDRI, shadow, instance count)
  const rebuildScene = useCallback(async () => {
    if (!extractorRef.current) return;
    setIsRebuilding(true);
    try {
      extractorRef.current.stopVideoPreview();
      await extractorRef.current.setupStudioFromStudioConfig(config);
      extractorRef.current.startStudioVideoPreview(config);
    } finally {
      setIsRebuilding(false);
    }
  }, [config]);

  useEffect(() => {
    if (!extractorRef.current || !open) return;
    const timer = setTimeout(() => {
      rebuildScene();
    }, 500);
    return () => clearTimeout(timer);
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
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <Video className="h-5 w-5" /> Video Studio
          </DialogTitle>
          <DialogDescription>
            Create cinematic videos of {productName}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* Left: Preview */}
          <div className="flex-1 flex flex-col p-4 min-w-0">
            {/* View Mode Toggle */}
            <div className="flex items-center gap-2 px-4 pb-2">
              <Button
                variant={viewMode === "camera" ? "secondary" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setViewMode("camera")}
              >
                <Camera className="h-3 w-3 mr-1" /> Camera View
              </Button>
              <Button
                variant={viewMode === "scene" ? "secondary" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setViewMode("scene")}
              >
                <Eye className="h-3 w-3 mr-1" /> Scene View
              </Button>
            </div>

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
              <div className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                  onClick={() => toggleSection("transform")}
                >
                  <Move className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>Transform — {selectionInfo.type}</span>
                  <span className="flex-1" />
                  {expandedSections.has("transform") ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                </button>
                {expandedSections.has("transform") && (
                  <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-2">
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
                    {/* Value readouts */}
                    {transformValues && (
                      <div className="space-y-1.5 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Position</span>
                          <span className="font-mono tabular-nums">
                            {transformValues.position.x.toFixed(2)}, {transformValues.position.y.toFixed(2)}, {transformValues.position.z.toFixed(2)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Rotation</span>
                          <span className="font-mono tabular-nums">
                            {transformValues.rotation.x.toFixed(1)}°, {transformValues.rotation.y.toFixed(1)}°, {transformValues.rotation.z.toFixed(1)}°
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Scale</span>
                          <span className="font-mono tabular-nums">
                            {transformValues.scale.x.toFixed(2)}, {transformValues.scale.y.toFixed(2)}, {transformValues.scale.z.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Cue Setup */}
            <div className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
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

            {/* Camera Controls */}
            <div className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
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

            {/* HDRI Lighting */}
            <div className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
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
                <div className="px-3 pb-3 pt-2 border-t border-border/30">
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
                </div>
              )}
            </div>

            {/* Background */}
            <div className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
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
                <div className="px-3 pb-3 pt-2 border-t border-border/30">
                  <BackgroundPanel
                    wallSurface={config.wallSurface}
                    tableSurface={config.tableSurface}
                    onWallSurfaceChange={(s) => updateConfig("wallSurface", s)}
                    onTableSurfaceChange={(s) => updateConfig("tableSurface", s)}
                  />
                </div>
              )}
            </div>

            {/* Shadow */}
            <div className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                onClick={() => toggleSection("shadow")}
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
              </button>
              {expandedSections.has("shadow") && config.shadow.enabled && (
                <div className="px-3 pb-3 pt-2 border-t border-border/30">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Intensity — {Math.round(config.shadow.intensity * 100)}%
                    </Label>
                    <Slider
                      value={[config.shadow.intensity]}
                      onValueChange={([v]) =>
                        updateConfig("shadow", {
                          ...config.shadow,
                          intensity: v,
                        })
                      }
                      min={0}
                      max={1}
                      step={0.05}
                    />
                  </div>
                </div>
              )}
            </div>
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
