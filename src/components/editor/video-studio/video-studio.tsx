"use client";

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
} from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import {
  ExtractorSceneManager,
  HDRI_OPTIONS_FALLBACK,
} from "@/lib/three/extractor-scene-manager";
import type { ExtractorQuality } from "@/types/extractor";
import type { VideoStudioConfig } from "@/types/video-studio";
import {
  DEFAULT_STUDIO_CONFIG,
  computeVideoDuration,
} from "@/types/video-studio";
import { CameraControlsPanel } from "./camera-controls-panel";
import { CueSetupPanel } from "./cue-setup-panel";
import { BackgroundPanel } from "./background-panel";
import { StudioTemplateSelector } from "./studio-template-selector";

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

  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const videoUrlRef = useRef<string | null>(null);
  const blobUrlsRef = useRef<string[]>([]);

  const updateConfig = useCallback(
    <K extends keyof VideoStudioConfig>(key: K, value: VideoStudioConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  // Setup ExtractorSceneManager when dialog opens
  useEffect(() => {
    if (!open || !sceneManager) return;

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
        previewContainerRef.current.innerHTML = "";
        previewContainerRef.current.appendChild(canvas);
        const rect = previewContainerRef.current.getBoundingClientRect();
        extractor.resize(rect.width, rect.height);
      }

      await extractor.setupStudioFromStudioConfig(config);
      extractor.startStudioVideoPreview(config);
    };

    setup();

    return () => {
      extractorRef.current?.stopVideoPreview();
      extractorRef.current?.dispose();
      extractorRef.current = null;
      sceneManager?.resumeAnimation();
    };
    // Only re-run on open/close, not on config changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sceneManager]);

  // Debounced preview updates on config change
  useEffect(() => {
    if (!extractorRef.current || !open) return;
    const timer = setTimeout(() => {
      extractorRef.current?.updateStudioPreviewConfig(config);
    }, 100);
    return () => clearTimeout(timer);
  }, [config, open]);

  // Rebuild scene for expensive changes (backgrounds, HDRI, shadow)
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
  }, [config.wallLayers, config.tableLayers, config.hdriFile, config.shadow.enabled, open]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, []);

  const handleRecord = async () => {
    if (!extractorRef.current) return;
    setIsRecording(true);
    setProgress(0);
    setError(null);
    setVideoUrl(null);

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
      <DialogContent className="max-w-6xl h-[85vh] flex flex-col p-0 gap-0">
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
          <div className="flex-1 flex flex-col p-4">
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
          <div className="w-80 border-l border-border overflow-y-auto p-4 space-y-4">
            {/* Template selector */}
            <StudioTemplateSelector
              productId={productId}
              currentConfig={config}
              onLoadConfig={(c) => setConfig(c)}
            />

            {/* Quality & Duration */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Quality</Label>
                <Select
                  value={config.quality}
                  onValueChange={(v) =>
                    updateConfig("quality", v as ExtractorQuality)
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hd">HD (1920×1080)</SelectItem>
                    <SelectItem value="2k">2K (2560×1440)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Estimated Duration
                </Label>
                <p className="text-sm font-mono">{duration.toFixed(1)}s</p>
              </div>
            </div>

            <div className="border-t border-border/50" />

            {/* Cue Setup */}
            <CueSetupPanel
              cuePosition={config.cuePosition}
              onChange={(pos) => updateConfig("cuePosition", pos)}
            />

            <div className="border-t border-border/50" />

            {/* Camera Controls */}
            <CameraControlsPanel
              cameraStart={config.cameraStart}
              cameraEnd={config.cameraEnd}
              cameraSpeed={config.cameraSpeed}
              easing={config.easing}
              onCameraStartChange={(s) => updateConfig("cameraStart", s)}
              onCameraEndChange={(e) => updateConfig("cameraEnd", e)}
              onCameraSpeedChange={(s) => updateConfig("cameraSpeed", s)}
              onEasingChange={(e) => updateConfig("easing", e)}
            />

            <div className="border-t border-border/50" />

            {/* HDRI Lighting */}
            <div className="space-y-3">
              <Label className="text-xs font-medium text-muted-foreground">
                HDRI Lighting
              </Label>
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

            <div className="border-t border-border/50" />

            {/* Background */}
            <BackgroundPanel
              wallLayers={config.wallLayers}
              tableLayers={config.tableLayers}
              onWallLayersChange={(layers) => updateConfig("wallLayers", layers)}
              onTableLayersChange={(layers) =>
                updateConfig("tableLayers", layers)
              }
            />

            <div className="border-t border-border/50" />

            {/* Shadow */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium text-muted-foreground">
                  Shadow
                </Label>
                <Checkbox
                  checked={config.shadow.enabled}
                  onCheckedChange={(checked) =>
                    updateConfig("shadow", {
                      ...config.shadow,
                      enabled: checked === true,
                    })
                  }
                />
              </div>
              {config.shadow.enabled && (
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
