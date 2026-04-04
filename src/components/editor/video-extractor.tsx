// src/components/editor/video-extractor.tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
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
import { Video, Download, Play, Square, RefreshCw, Settings, Plus, Trash2, Upload, X } from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager, HDRI_OPTIONS_FALLBACK } from "@/lib/three/extractor-scene-manager";
import type { VideoExtractorConfig, ExtractorQuality, VideoBackgroundLayer } from "@/types/extractor";
import { DEFAULT_VIDEO_CONFIG, QUALITY_PRESETS } from "@/types/extractor";

interface VideoExtractorProps {
  sceneManager: SceneManager | null;
  productName: string;
  onClose: () => void;
  open: boolean;
}

let bgLayerCounter = 0;
const newLayerId = () => `bg-${++bgLayerCounter}`;

export function VideoExtractor({ sceneManager, productName, onClose, open }: VideoExtractorProps) {
  const [config, setConfig] = useState<VideoExtractorConfig>(DEFAULT_VIDEO_CONFIG);
  const [quality, setQuality] = useState<ExtractorQuality>("hd");
  const [isRecording, setIsRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);

  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const videoUrlRef = useRef<string | null>(null);
  const tableFileRef = useRef<HTMLInputElement>(null);
  const wallFileRef = useRef<HTMLInputElement>(null);
  const bgImageFileRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const blobUrlsRef = useRef<string[]>([]);

  const rebuildScene = useCallback(async (cfg: VideoExtractorConfig) => {
    const extractor = extractorRef.current;
    if (!extractor) return;
    setIsRebuilding(true);
    try {
      extractor.stopVideoPreview();
      await extractor.setupStudioLighting(cfg);
      extractor.startVideoPreview(cfg);
    } finally {
      setIsRebuilding(false);
    }
  }, []);

  // Initialize extractor when dialog opens
  useEffect(() => {
    if (!open || !sceneManager) return;
    sceneManager.pauseAnimation();

    const initExtractor = async () => {
      try {
        setError(null);
        const extractor = new ExtractorSceneManager(640, 360);
        extractorRef.current = extractor;

        const model = sceneManager.getModelForClone();
        if (model) extractor.setModel(model);

        const hdriUrl = sceneManager.getCurrentHdriUrl();
        await extractor.loadHDRI(hdriUrl);

        await extractor.setupStudioLighting(config);

        if (previewContainerRef.current) {
          const canvas = extractor.getCanvas();
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.objectFit = "contain";
          previewContainerRef.current.innerHTML = '';
          previewContainerRef.current.appendChild(canvas);
        }

        extractor.startVideoPreview(config);
      } catch (err) {
        setError("Failed to initialize video extractor");
        console.error(err);
      }
    };

    initExtractor();

    return () => {
      if (extractorRef.current) {
        extractorRef.current.stopVideoPreview();
        extractorRef.current.dispose();
        extractorRef.current = null;
      }
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
      for (const url of blobUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      blobUrlsRef.current = [];
      sceneManager?.resumeAnimation();
    };
  }, [open, sceneManager]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quality preset changes
  useEffect(() => {
    const preset = QUALITY_PRESETS[quality];
    setConfig(prev => ({ ...prev, ...preset }));
  }, [quality]);

  // Live-update cheap params (speed, scale) without rebuilding scene
  const updateConfigLive = (patch: Partial<VideoExtractorConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...patch };
      extractorRef.current?.updateVideoPreviewConfig(next);
      return next;
    });
  };

  // Expensive config change (textures, backgrounds) — rebuild scene
  const updateConfigAndRebuild = (patch: Partial<VideoExtractorConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...patch };
      rebuildScene(next);
      return next;
    });
  };

  const handleStartRecording = async () => {
    if (!extractorRef.current) return;
    setIsRecording(true);
    setProgress(0);
    setError(null);
    try {
      extractorRef.current.resize(config.width, config.height);
      const blob = await extractorRef.current.startVideoRecording(config, p => setProgress(p));
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      const url = URL.createObjectURL(blob);
      videoUrlRef.current = url;
      setVideoUrl(url);
    } catch (err) {
      setError("Recording failed. Try reducing quality or duration.");
      console.error(err);
    } finally {
      setIsRecording(false);
      if (extractorRef.current) {
        extractorRef.current.resize(640, 360);
        await extractorRef.current.setupStudioLighting(config);
        extractorRef.current.startVideoPreview(config);
      }
    }
  };

  const handleStopRecording = () => {
    extractorRef.current?.stopRecording();
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
    rebuildScene(DEFAULT_VIDEO_CONFIG);
  };

  const handleTableTextureUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    blobUrlsRef.current.push(url);
    updateConfigAndRebuild({ tableTextureUrl: url });
  };

  const handleWallTextureUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    blobUrlsRef.current.push(url);
    updateConfigAndRebuild({ wallTextureUrl: url });
  };

  const addBgLayer = () => {
    const newLayer: VideoBackgroundLayer = {
      id: newLayerId(),
      type: 'color',
      color: '#222222',
      imageUrl: null,
      opacity: 0.8,
      blendMode: 'normal',
      enabled: true,
    };
    updateConfigAndRebuild({ backgroundLayers: [...(config.backgroundLayers ?? []), newLayer] });
  };

  const removeBgLayer = (id: string) => {
    updateConfigAndRebuild({ backgroundLayers: (config.backgroundLayers ?? []).filter(l => l.id !== id) });
  };

  const updateBgLayer = (id: string, patch: Partial<VideoBackgroundLayer>, rebuild = true) => {
    const layers = (config.backgroundLayers ?? []).map(l => l.id === id ? { ...l, ...patch } : l);
    if (rebuild) {
      updateConfigAndRebuild({ backgroundLayers: layers });
    } else {
      setConfig(prev => ({ ...prev, backgroundLayers: layers }));
    }
  };

  const handleBgImageUpload = (id: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    blobUrlsRef.current.push(url);
    updateBgLayer(id, { type: 'image', imageUrl: url }, true);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !isRecording && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="h-5 w-5" />
            Video Extractor
          </DialogTitle>
          <DialogDescription>
            Studio product video — cue spins with cinematic Dutch-angle dolly shot
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
              {isRebuilding && !isRecording && (
                <div className="absolute top-2 right-2 bg-background/80 text-foreground px-2 py-1 rounded text-xs z-10">
                  Updating…
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
                <div className="absolute inset-0 flex items-center justify-center text-destructive bg-background/80 z-20">
                  {error}
                </div>
              )}
            </div>

            {isRecording && (
              <div className="mt-2">
                <Progress value={progress} className="h-2" />
                <p className="text-xs text-muted-foreground mt-1 text-center">Recording: {progress}%</p>
              </div>
            )}
          </div>

          {/* Controls Panel */}
          <div className="w-80 flex flex-col gap-4 overflow-y-auto pr-1">

            {/* Quality */}
            <div className="space-y-2">
              <h4 className="font-medium text-sm flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Quality
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
              <h4 className="font-medium text-sm">Video</h4>

              <div>
                <div className="flex justify-between">
                  <Label className="text-xs">Duration</Label>
                  <span className="text-xs text-muted-foreground">{config.duration}s</span>
                </div>
                <Slider value={[config.duration]} min={5} max={30} step={1}
                  onValueChange={([v]) => updateConfigLive({ duration: v })}
                  className="mt-1" disabled={isRecording} />
              </div>

              <div>
                <div className="flex justify-between">
                  <Label className="text-xs">Cue Spin Speed</Label>
                  <span className="text-xs text-muted-foreground">{config.rotationSpeed.toFixed(2)} rad/s</span>
                </div>
                <Slider value={[config.rotationSpeed]} min={0.1} max={1} step={0.05}
                  onValueChange={([v]) => updateConfigLive({ rotationSpeed: v })}
                  className="mt-1" disabled={isRecording} />
              </div>

              <div>
                <div className="flex justify-between">
                  <Label className="text-xs">Cue Scale</Label>
                  <span className="text-xs text-muted-foreground">{(config.modelScale ?? 7).toFixed(1)}×</span>
                </div>
                <Slider value={[config.modelScale ?? 7]} min={4} max={12} step={0.5}
                  onValueChange={([v]) => updateConfigLive({ modelScale: v })}
                  className="mt-1" disabled={isRecording} />
              </div>

              <div>
                <div className="flex justify-between">
                  <Label className="text-xs">Camera Pan Speed</Label>
                  <span className="text-xs text-muted-foreground">{((config.cameraDollySpeed ?? 0.15) * 100).toFixed(0)}%</span>
                </div>
                <Slider value={[config.cameraDollySpeed ?? 0.15]} min={0.05} max={1} step={0.05}
                  onValueChange={([v]) => updateConfigLive({ cameraDollySpeed: v })}
                  className="mt-1" disabled={isRecording} />
                <p className="text-xs text-muted-foreground mt-0.5">% of cue length covered per video</p>
              </div>
            </div>

            {/* HDRI */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Lighting (HDRI)</h4>

              <div>
                <Label className="text-xs">HDRI Environment</Label>
                <Select
                  value={config.hdriFile ?? 'ferndale_studio_07_2k.hdr'}
                  onValueChange={(v) => updateConfigAndRebuild({ hdriFile: v })}
                  disabled={isRecording}
                >
                  <SelectTrigger className="h-9 mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HDRI_OPTIONS_FALLBACK.map(h => (
                      <SelectItem key={h.id} value={h.id}>{h.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <div className="flex justify-between">
                  <Label className="text-xs">HDRI Rotation (Y)</Label>
                  <span className="text-xs text-muted-foreground">{config.hdriRotationY ?? 0}°</span>
                </div>
                <Slider
                  value={[config.hdriRotationY ?? 0]} min={0} max={360} step={5}
                  onValueChange={([v]) => {
                    updateConfigLive({ hdriRotationY: v });
                    extractorRef.current?.setHdriRotation(v);
                  }}
                  className="mt-1" disabled={isRecording} />
              </div>
            </div>

            {/* Background Layers */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-medium text-sm">Background Layers</h4>
                <Button size="sm" variant="outline" className="h-7 px-2" onClick={addBgLayer} disabled={isRecording}>
                  <Plus className="h-3 w-3 mr-1" /> Add
                </Button>
              </div>

              {(config.backgroundLayers ?? []).map((layer, idx) => (
                <div key={layer.id} className="border rounded-lg p-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">Layer {idx + 1}</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={layer.enabled}
                        onChange={(e) => updateBgLayer(layer.id, { enabled: e.target.checked })}
                        disabled={isRecording}
                        className="h-3 w-3"
                      />
                      {idx > 0 && (
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => removeBgLayer(layer.id)} disabled={isRecording}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Type selector */}
                  <div className="flex gap-1">
                    <Button
                      size="sm" variant={layer.type === 'color' ? 'default' : 'outline'}
                      className="h-6 text-xs flex-1"
                      onClick={() => updateBgLayer(layer.id, { type: 'color' })}
                      disabled={isRecording}
                    >Color</Button>
                    <Button
                      size="sm" variant={layer.type === 'image' ? 'default' : 'outline'}
                      className="h-6 text-xs flex-1"
                      onClick={() => {
                        updateBgLayer(layer.id, { type: 'image' }, false);
                        setTimeout(() => {
                          const el = bgImageFileRefs.current.get(layer.id);
                          el?.click();
                        }, 50);
                      }}
                      disabled={isRecording}
                    >Image</Button>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      ref={el => { if (el) bgImageFileRefs.current.set(layer.id, el); }}
                      onChange={(e) => handleBgImageUpload(layer.id, e)}
                    />
                  </div>

                  {layer.type === 'color' && (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={layer.color}
                        onChange={(e) => updateBgLayer(layer.id, { color: e.target.value })}
                        disabled={isRecording}
                        className="h-7 w-12 rounded cursor-pointer"
                      />
                      <span className="text-xs text-muted-foreground">{layer.color}</span>
                    </div>
                  )}

                  {layer.type === 'image' && layer.imageUrl && (
                    <div className="flex items-center gap-2">
                      <div className="w-10 h-7 rounded overflow-hidden bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={layer.imageUrl} alt="" className="w-full h-full object-cover" />
                      </div>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                        onClick={() => updateBgLayer(layer.id, { imageUrl: null, type: 'color' })}
                        disabled={isRecording}>
                        <X className="h-3 w-3 mr-1" /> Clear
                      </Button>
                    </div>
                  )}

                  {/* Opacity */}
                  <div>
                    <div className="flex justify-between">
                      <Label className="text-xs">Opacity</Label>
                      <span className="text-xs text-muted-foreground">{Math.round(layer.opacity * 100)}%</span>
                    </div>
                    <Slider value={[layer.opacity]} min={0} max={1} step={0.05}
                      onValueChange={([v]) => updateBgLayer(layer.id, { opacity: v })}
                      className="mt-1" disabled={isRecording} />
                  </div>

                  {/* Blend mode */}
                  <div>
                    <Label className="text-xs">Blend Mode</Label>
                    <Select value={layer.blendMode}
                      onValueChange={(v) => updateBgLayer(layer.id, { blendMode: v as VideoBackgroundLayer['blendMode'] })}
                      disabled={isRecording}>
                      <SelectTrigger className="h-7 mt-1 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="normal">Normal</SelectItem>
                        <SelectItem value="additive">Additive (Screen)</SelectItem>
                        <SelectItem value="multiply">Multiply</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>

            {/* Textures */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Textures</h4>

              <div>
                <Label className="text-xs">Table (Velvet)</Label>
                <div className="flex gap-1 mt-1">
                  <Button size="sm" variant="outline" className="h-7 flex-1 text-xs"
                    onClick={() => tableFileRef.current?.click()} disabled={isRecording}>
                    <Upload className="h-3 w-3 mr-1" />
                    {config.tableTextureUrl?.startsWith('blob:') ? 'Custom' : 'Upload'}
                  </Button>
                  {config.tableTextureUrl?.startsWith('blob:') && (
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                      onClick={() => updateConfigAndRebuild({ tableTextureUrl: '/textures/studio/velvet-black.jpg' })}
                      disabled={isRecording}>
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                <input ref={tableFileRef} type="file" accept="image/*" className="hidden" onChange={handleTableTextureUpload} />
              </div>

              <div>
                <Label className="text-xs">Wall (Cement)</Label>
                <div className="flex gap-1 mt-1">
                  <Button size="sm" variant="outline" className="h-7 flex-1 text-xs"
                    onClick={() => wallFileRef.current?.click()} disabled={isRecording}>
                    <Upload className="h-3 w-3 mr-1" />
                    {config.wallTextureUrl?.startsWith('blob:') ? 'Custom' : 'Upload'}
                  </Button>
                  {config.wallTextureUrl?.startsWith('blob:') && (
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                      onClick={() => updateConfigAndRebuild({ wallTextureUrl: '/textures/studio/cement-dark.jpg' })}
                      disabled={isRecording}>
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                <input ref={wallFileRef} type="file" accept="image/*" className="hidden" onChange={handleWallTextureUpload} />
              </div>
            </div>

            {/* Shadow */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Shadow</h4>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="enableShadow" checked={config.enableShadow}
                  onChange={(e) => updateConfigAndRebuild({ enableShadow: e.target.checked })}
                  disabled={isRecording} />
                <Label htmlFor="enableShadow" className="text-xs">Enable Shadow</Label>
              </div>
              {config.enableShadow && (
                <div>
                  <div className="flex justify-between">
                    <Label className="text-xs">Shadow Intensity</Label>
                    <span className="text-xs text-muted-foreground">{config.shadowIntensity}</span>
                  </div>
                  <Slider value={[config.shadowIntensity]} min={0.1} max={1} step={0.1}
                    onValueChange={([v]) => updateConfigAndRebuild({ shadowIntensity: v })}
                    className="mt-1" disabled={isRecording} />
                </div>
              )}
            </div>

          </div>
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button variant="outline" onClick={handleReset} size="sm" disabled={isRecording}>
            <RefreshCw className="h-4 w-4 mr-1" /> Reset
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} size="sm" disabled={isRecording}>Cancel</Button>
            {isRecording ? (
              <Button onClick={handleStopRecording} variant="destructive" size="sm">
                <Square className="h-4 w-4 mr-1" /> Stop
              </Button>
            ) : videoUrl ? (
              <>
                <Button variant="outline" size="sm" onClick={() => { setVideoUrl(null); if (videoUrlRef.current) { URL.revokeObjectURL(videoUrlRef.current); videoUrlRef.current = null; } rebuildScene(config); }}>
                  <RefreshCw className="h-4 w-4 mr-1" /> Re-record
                </Button>
                <Button onClick={handleDownload} size="sm">
                  <Download className="h-4 w-4 mr-1" /> Download
                </Button>
              </>
            ) : (
              <Button onClick={handleStartRecording} size="sm" disabled={isRebuilding}>
                <Play className="h-4 w-4 mr-1" /> Start Recording
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
