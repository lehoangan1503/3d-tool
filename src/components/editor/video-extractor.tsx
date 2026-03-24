// src/components/editor/video-extractor.tsx

"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Video, Download, Play, Square, RefreshCw, Settings } from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import type { VideoExtractorConfig, ExtractorQuality } from "@/types/extractor";
import { DEFAULT_VIDEO_CONFIG, QUALITY_PRESETS } from "@/types/extractor";

interface VideoExtractorProps {
  sceneManager: SceneManager | null;
  productName: string;
  onClose: () => void;
  open: boolean;
}

export function VideoExtractor({ sceneManager, productName, onClose, open }: VideoExtractorProps) {
  const [config, setConfig] = useState<VideoExtractorConfig>(DEFAULT_VIDEO_CONFIG);
  const [quality, setQuality] = useState<ExtractorQuality>("hd");
  const [isRecording, setIsRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const videoUrlRef = useRef<string | null>(null);

  // Initialize extractor when dialog opens
  useEffect(() => {
    if (!open || !sceneManager) return;

    const initExtractor = async () => {
      try {
        setError(null);
        const extractor = new ExtractorSceneManager(640, 360); // Preview size
        extractorRef.current = extractor;

        // Clone model
        const model = sceneManager.getModelForClone();
        if (model) {
          extractor.setModel(model);
        }

        // Load HDRI
        const hdriUrl = sceneManager.getCurrentHdriUrl();
        await extractor.loadHDRI(hdriUrl);

        // Setup studio lighting for preview
        extractor.setupStudioLighting(config);

        // Mount canvas for preview
        if (previewContainerRef.current) {
          const canvas = extractor.getCanvas();
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.objectFit = "contain";
          previewContainerRef.current.innerHTML = '';
          previewContainerRef.current.appendChild(canvas);
        }
      } catch (err) {
        setError("Failed to initialize video extractor");
        console.error(err);
      }
    };

    initExtractor();

    return () => {
      if (extractorRef.current) {
        extractorRef.current.dispose();
        extractorRef.current = null;
      }
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
    };
  }, [open, sceneManager]);

  // Update config when quality changes
  useEffect(() => {
    const preset = QUALITY_PRESETS[quality];
    setConfig(prev => ({ ...prev, ...preset }));
  }, [quality]);

  const handleStartRecording = async () => {
    if (!extractorRef.current) return;

    setIsRecording(true);
    setProgress(0);
    setError(null);

    try {
      // Resize for recording
      extractorRef.current.resize(config.width, config.height);

      const blob = await extractorRef.current.startVideoRecording(
        config,
        (p) => setProgress(p)
      );

      // Create URL for download/preview
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
      }
      const url = URL.createObjectURL(blob);
      videoUrlRef.current = url;
      setVideoUrl(url);
    } catch (err) {
      setError("Recording failed. Try reducing quality or duration.");
      console.error(err);
    } finally {
      setIsRecording(false);
      // Restore preview size
      if (extractorRef.current) {
        extractorRef.current.resize(640, 360);
      }
    }
  };

  const handleStopRecording = () => {
    if (extractorRef.current) {
      extractorRef.current.stopRecording();
    }
  };

  const handleDownload = () => {
    if (!videoUrl) return;

    const link = document.createElement("a");
    link.href = videoUrl;
    const ext = config.format === 'mp4' ? 'mp4' : 'webm';
    link.download = `${productName.replace(/\s+/g, "-")}-cue-video.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleReset = () => {
    setConfig(DEFAULT_VIDEO_CONFIG);
    setQuality("hd");
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
      setVideoUrl(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !isRecording && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="h-5 w-5" />
            Video Extractor
          </DialogTitle>
          <DialogDescription>
            Generate a studio-quality video of your cue rotating with shadow effects
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
          {/* Preview Panel */}
          <div className="flex-1 flex flex-col min-w-0">
            <div
              ref={previewContainerRef}
              className="flex-1 bg-black rounded-lg overflow-hidden relative"
              style={{ minHeight: 360 }}
            >
              {isRecording && (
                <div className="absolute top-2 left-2 flex items-center gap-2 bg-red-600 text-white px-2 py-1 rounded text-sm z-10">
                  <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                  Recording...
                </div>
              )}
              {videoUrl && !isRecording && (
                <video
                  src={videoUrl}
                  controls
                  className="absolute inset-0 w-full h-full object-contain"
                />
              )}
              {error && (
                <div className="absolute inset-0 flex items-center justify-center text-destructive bg-background/80">
                  {error}
                </div>
              )}
            </div>

            {isRecording && (
              <div className="mt-2">
                <Progress value={progress} className="h-2" />
                <p className="text-xs text-muted-foreground mt-1 text-center">
                  Recording: {progress}%
                </p>
              </div>
            )}
          </div>

          {/* Controls Panel */}
          <div className="w-72 flex flex-col gap-4 overflow-y-auto">
            {/* Quality Preset */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Quality Preset
              </h4>
              
              <Select value={quality} onValueChange={(v) => setQuality(v as ExtractorQuality)} disabled={isRecording}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hd">HD (1920×1080)</SelectItem>
                  <SelectItem value="2k">2K (2560×1440)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Video Settings */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Video Settings</h4>
              
              <div>
                <Label className="text-xs">Duration (seconds)</Label>
                <Slider
                  value={[config.duration]}
                  min={5}
                  max={30}
                  step={1}
                  onValueChange={([v]) => setConfig(prev => ({ ...prev, duration: v }))}
                  className="mt-1"
                  disabled={isRecording}
                />
                <span className="text-xs text-muted-foreground">{config.duration}s</span>
              </div>

              <div>
                <Label className="text-xs">Rotation Speed</Label>
                <Slider
                  value={[config.rotationSpeed]}
                  min={0.5}
                  max={3}
                  step={0.1}
                  onValueChange={([v]) => setConfig(prev => ({ ...prev, rotationSpeed: v }))}
                  className="mt-1"
                  disabled={isRecording}
                />
                <span className="text-xs text-muted-foreground">{config.rotationSpeed.toFixed(1)} rad/s</span>
              </div>

              <div>
                <Label className="text-xs">Cue Angle</Label>
                <Slider
                  value={[config.cueAngle * (180 / Math.PI)]}
                  min={0}
                  max={45}
                  step={5}
                  onValueChange={([v]) => setConfig(prev => ({ ...prev, cueAngle: v * (Math.PI / 180) }))}
                  className="mt-1"
                  disabled={isRecording}
                />
                <span className="text-xs text-muted-foreground">{Math.round(config.cueAngle * (180 / Math.PI))}°</span>
              </div>
            </div>

            {/* Background Settings */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Background</h4>
              
              <div>
                <Label className="text-xs">Background Color</Label>
                <div className="flex gap-2 items-center mt-1">
                  <input
                    type="color"
                    value={config.backgroundColor}
                    onChange={(e) => setConfig(prev => ({ ...prev, backgroundColor: e.target.value }))}
                    className="w-8 h-8 rounded border cursor-pointer"
                    disabled={isRecording}
                  />
                  <span className="text-xs text-muted-foreground">{config.backgroundColor}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="enableShadow"
                  checked={config.enableShadow}
                  onChange={(e) => setConfig(prev => ({ ...prev, enableShadow: e.target.checked }))}
                  disabled={isRecording}
                />
                <Label htmlFor="enableShadow" className="text-xs">Enable Shadow</Label>
              </div>

              {config.enableShadow && (
                <div>
                  <Label className="text-xs">Shadow Intensity</Label>
                  <Slider
                    value={[config.shadowIntensity]}
                    min={0.1}
                    max={1}
                    step={0.1}
                    onValueChange={([v]) => setConfig(prev => ({ ...prev, shadowIntensity: v }))}
                    className="mt-1"
                    disabled={isRecording}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button variant="outline" onClick={handleReset} size="sm" disabled={isRecording}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Reset
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} size="sm" disabled={isRecording}>
              Cancel
            </Button>
            {isRecording ? (
              <Button onClick={handleStopRecording} variant="destructive" size="sm">
                <Square className="h-4 w-4 mr-1" />
                Stop
              </Button>
            ) : videoUrl ? (
              <Button onClick={handleDownload} size="sm">
                <Download className="h-4 w-4 mr-1" />
                Download
              </Button>
            ) : (
              <Button onClick={handleStartRecording} size="sm">
                <Play className="h-4 w-4 mr-1" />
                Start Recording
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
