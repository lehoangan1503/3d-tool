"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Camera, Download, RefreshCw, AlignCenter, Save, Loader2, Sun } from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { InteractiveFrame } from "@/components/editor/interactive-frame";
import type { FramePosition, FrameKey, ImageExtractorPreset } from "@/types/extractor";
import { DEFAULT_IMAGE_EXTRACTOR_PRESET, FRAME_LABELS } from "@/types/extractor";

interface ImageExtractorProps {
  sceneManager: SceneManager | null;
  productName: string;
  onClose: () => void;
  open: boolean;
}

const FRAME_SIZE = 280; // Size of each interactive frame in pixels

export function ImageExtractor({ sceneManager, productName, onClose, open }: ImageExtractorProps) {
  const [preset, setPreset] = useState<ImageExtractorPreset>(DEFAULT_IMAGE_EXTRACTOR_PRESET);
  const [selectedFrame, setSelectedFrame] = useState<FrameKey>("centerCue");
  const [isExporting, setIsExporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Refs for each frame's extractor (for composite capture)
  const extractorRefs = useRef<Record<FrameKey, ExtractorSceneManager | null>>({
    bottomBump: null,
    centerCue: null,
    topCap: null,
  });

  // Load saved preset on open
  useEffect(() => {
    if (!open) return;
    loadPreset();
  }, [open]);

  const loadPreset = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/extractor-presets");
      if (res.ok) {
        const data = await res.json();
        setPreset(data);
      }
    } catch (err) {
      console.error("Failed to load preset:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const savePreset = async () => {
    setIsSaving(true);
    try {
      const res = await fetch("/api/extractor-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preset),
      });
      if (!res.ok) throw new Error("Save failed");
    } catch (err) {
      setError("Failed to save preset");
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const resetPreset = () => {
    setPreset(DEFAULT_IMAGE_EXTRACTOR_PRESET);
  };

  const alignCenter = () => {
    // Reset model offsets and camera orbits to centered
    setPreset(prev => ({
      ...prev,
      frames: {
        bottomBump: { ...prev.frames.bottomBump, modelOffsetX: 0, modelOffsetY: 0, cameraOrbitX: 0 },
        centerCue: { ...prev.frames.centerCue, modelOffsetX: 0, modelOffsetY: 0, cameraOrbitX: 0 },
        topCap: { ...prev.frames.topCap, modelOffsetX: 0, modelOffsetY: 0, cameraOrbitX: 0 },
      },
    }));
  };

  const updateFramePosition = (frameKey: FrameKey, position: FramePosition) => {
    setPreset(prev => ({
      ...prev,
      frames: { ...prev.frames, [frameKey]: position },
    }));
  };

  const updateGap = (gap: number) => {
    setPreset(prev => ({ ...prev, gap: Math.max(0, Math.min(100, gap)) }));
  };

  const updateLightAngle = (angle: number) => {
    setPreset(prev => ({
      ...prev,
      frames: {
        ...prev.frames,
        [selectedFrame]: { ...prev.frames[selectedFrame], lightAngle: angle },
      },
    }));
  };

  const handleExport = async () => {
    if (!sceneManager) return;
    
    setIsExporting(true);
    setError(null);

    try {
      // Create high-res extractors for each frame
      const frameSize = Math.floor((2048 - preset.gap * 2) / 2);
      const extractors: Record<FrameKey, ExtractorSceneManager> = {
        bottomBump: new ExtractorSceneManager(frameSize, frameSize),
        centerCue: new ExtractorSceneManager(frameSize, Math.floor(frameSize * 1.4)),
        topCap: new ExtractorSceneManager(frameSize, frameSize),
      };

      // Setup each extractor
      const model = sceneManager.getModelForClone();
      const hdriUrl = sceneManager.getCurrentHdriUrl();
      
      for (const key of Object.keys(extractors) as FrameKey[]) {
        const extractor = extractors[key];
        const pos = preset.frames[key];
        
        if (model) extractor.setModel(model);
        await extractor.loadHDRI(hdriUrl);
        extractor.setTransparentBackground(true);
        
        const targetY = key === 'bottomBump' ? -1 : key === 'topCap' ? 1 : 0;
        extractor.setCameraOrbit(pos.cameraOrbitX, pos.cameraOrbitY, pos.cameraDistance, targetY);
        extractor.setCameraZoom(pos.zoom);
        extractor.setModelOffset(pos.modelOffsetX, pos.modelOffsetY);
        extractor.setDirectionalLight(pos.lightAngle);
      }

      // Create composite canvas
      const canvas = document.createElement('canvas');
      canvas.width = 2048;
      canvas.height = 2048;
      const ctx = canvas.getContext('2d')!;
      
      // Clear with transparency
      ctx.clearRect(0, 0, 2048, 2048);

      // Capture and draw each frame
      // Position: bottomBump (bottom-left), centerCue (center), topCap (top-right)
      const gap = preset.gap;
      
      // Bottom Bump - bottom left
      const bbImg = new Image();
      bbImg.src = extractors.bottomBump.captureFrame('png');
      await new Promise(r => bbImg.onload = r);
      ctx.drawImage(bbImg, 0, 2048 - frameSize, frameSize, frameSize);
      
      // Center Cue - center (taller frame)
      const ccImg = new Image();
      ccImg.src = extractors.centerCue.captureFrame('png');
      await new Promise(r => ccImg.onload = r);
      const ccHeight = Math.floor(frameSize * 1.4);
      ctx.drawImage(ccImg, frameSize / 2 + gap / 2, (2048 - ccHeight) / 2, frameSize, ccHeight);
      
      // Top Cap - top right
      const tcImg = new Image();
      tcImg.src = extractors.topCap.captureFrame('png');
      await new Promise(r => tcImg.onload = r);
      ctx.drawImage(tcImg, 2048 - frameSize, 0, frameSize, frameSize);

      // Download
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `${productName.replace(/\s+/g, '-')}-cue-parts.png`;
      link.click();

      // Cleanup
      Object.values(extractors).forEach(e => e.dispose());
    } catch (err) {
      setError("Export failed");
      console.error(err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-5xl max-h-[95vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            Image Extractor
          </DialogTitle>
          <DialogDescription>
            Click frames to select • Left-drag: orbit camera • Right-drag: move cue • Scroll: zoom
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : (
          <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
            {/* Frames Preview Area */}
            <div className="flex-1 relative bg-muted/30 rounded-lg p-4 overflow-auto">
              {/* Diagonal layout container */}
              <div className="relative" style={{ width: FRAME_SIZE * 2.5, height: FRAME_SIZE * 2.5, margin: '0 auto' }}>
                {/* Top Cap - top right */}
                <div className="absolute" style={{ top: 0, right: 0 }}>
                  <InteractiveFrame
                    frameKey="topCap"
                    position={preset.frames.topCap}
                    onPositionChange={(pos) => updateFramePosition('topCap', pos)}
                    sceneManager={sceneManager}
                    selected={selectedFrame === 'topCap'}
                    onSelect={() => setSelectedFrame('topCap')}
                    size={FRAME_SIZE}
                  />
                </div>
                
                {/* Center Cue - center */}
                <div className="absolute" style={{ top: FRAME_SIZE * 0.5, left: FRAME_SIZE * 0.75 }}>
                  <InteractiveFrame
                    frameKey="centerCue"
                    position={preset.frames.centerCue}
                    onPositionChange={(pos) => updateFramePosition('centerCue', pos)}
                    sceneManager={sceneManager}
                    selected={selectedFrame === 'centerCue'}
                    onSelect={() => setSelectedFrame('centerCue')}
                    size={FRAME_SIZE}
                  />
                </div>
                
                {/* Bottom Bump - bottom left */}
                <div className="absolute" style={{ bottom: 0, left: 0 }}>
                  <InteractiveFrame
                    frameKey="bottomBump"
                    position={preset.frames.bottomBump}
                    onPositionChange={(pos) => updateFramePosition('bottomBump', pos)}
                    sceneManager={sceneManager}
                    selected={selectedFrame === 'bottomBump'}
                    onSelect={() => setSelectedFrame('bottomBump')}
                    size={FRAME_SIZE}
                  />
                </div>
              </div>
            </div>

            {/* Controls Panel */}
            <div className="w-64 flex flex-col gap-4 overflow-y-auto">
              {/* Selected Frame Info */}
              <div className="p-3 bg-muted/50 rounded-lg">
                <h4 className="font-medium text-sm mb-2">Selected: {FRAME_LABELS[selectedFrame]}</h4>
                
                {/* Light Direction */}
                <div>
                  <Label className="text-xs flex items-center gap-1">
                    <Sun className="h-3 w-3" /> Light Direction
                  </Label>
                  <Slider
                    value={[preset.frames[selectedFrame].lightAngle]}
                    min={0}
                    max={360}
                    step={5}
                    onValueChange={([v]) => updateLightAngle(v)}
                    className="mt-1"
                  />
                  <span className="text-xs text-muted-foreground">{preset.frames[selectedFrame].lightAngle}°</span>
                </div>
              </div>

              {/* Layout Settings */}
              <div className="space-y-3">
                <h4 className="font-medium text-sm">Layout</h4>
                
                <div>
                  <Label className="text-xs">Gap (px)</Label>
                  <Input
                    type="number"
                    value={preset.gap}
                    onChange={(e) => updateGap(parseInt(e.target.value) || 0)}
                    className="h-8 text-sm"
                    min={0}
                    max={100}
                  />
                </div>

                <Button variant="outline" size="sm" onClick={alignCenter} className="w-full">
                  <AlignCenter className="h-4 w-4 mr-1" />
                  Align Center
                </Button>
              </div>

              {/* Preset Actions */}
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Presets</h4>
                
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={savePreset} 
                  disabled={isSaving}
                  className="w-full"
                >
                  {isSaving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                  Save as Default
                </Button>
                
                <Button variant="outline" size="sm" onClick={resetPreset} className="w-full">
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Reset to Default
                </Button>
              </div>

              {error && (
                <div className="text-sm text-destructive">{error}</div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button variant="outline" onClick={onClose} size="sm">
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !sceneManager} size="sm">
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-1" />
                Download 2048×2048
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
