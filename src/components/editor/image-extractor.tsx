// src/components/editor/image-extractor.tsx

"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Camera, Download, RefreshCw, ZoomIn, Move, RotateCcw, Loader2 } from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import type { ImageExtractorConfig, PartViewConfig } from "@/types/extractor";
import { DEFAULT_IMAGE_CONFIG } from "@/types/extractor";

interface ImageExtractorProps {
  sceneManager: SceneManager | null;
  productName: string;
  onClose: () => void;
  open: boolean;
}

type PartKey = "bottomBump" | "centerCue" | "topCap";

const PART_LABELS: Record<PartKey, string> = {
  bottomBump: "Bottom Bump",
  centerCue: "Full Cue",
  topCap: "Top Cap",
};

export function ImageExtractor({ sceneManager, productName, onClose, open }: ImageExtractorProps) {
  const [config, setConfig] = useState<ImageExtractorConfig>(DEFAULT_IMAGE_CONFIG);
  const [selectedPart, setSelectedPart] = useState<PartKey>("centerCue");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // Initialize extractor when dialog opens
  useEffect(() => {
    if (!open || !sceneManager) return;

    const initExtractor = async () => {
      try {
        setError(null);
        // Create extractor with preview size
        const extractor = new ExtractorSceneManager(800, 800);
        extractorRef.current = extractor;

        // Clone model from main scene
        const model = sceneManager.getModelForClone();
        if (model) {
          extractor.setModel(model);
        }

        // Load same HDRI
        const hdriUrl = sceneManager.getCurrentHdriUrl();
        await extractor.loadHDRI(hdriUrl);

        // Generate initial preview
        const url = await extractor.captureImageParts(config);
        setPreviewUrl(url);
      } catch (err) {
        setError("Failed to initialize extractor");
        console.error(err);
      }
    };

    initExtractor();

    return () => {
      if (extractorRef.current) {
        extractorRef.current.dispose();
        extractorRef.current = null;
      }
      setPreviewUrl(null);
    };
  }, [open, sceneManager]);

  // Update preview when config changes
  useEffect(() => {
    if (!extractorRef.current || !open) return;
    
    const updatePreview = async () => {
      try {
        const url = await extractorRef.current!.captureImageParts(config);
        setPreviewUrl(url);
      } catch (err) {
        console.error("Preview update failed:", err);
      }
    };
    
    updatePreview();
  }, [config, open]);

  const updatePartConfig = (part: PartKey, updates: Partial<PartViewConfig>) => {
    setConfig(prev => ({
      ...prev,
      parts: {
        ...prev.parts,
        [part]: { ...prev.parts[part], ...updates },
      },
    }));
  };

  const handleGenerate = async () => {
    if (!extractorRef.current) return;

    setIsGenerating(true);
    setError(null);

    try {
      const dataUrl = await extractorRef.current.captureImageParts({
        ...config,
        width: config.width,
        height: config.height,
      });
      setPreviewUrl(dataUrl);
    } catch (err) {
      setError("Failed to generate image");
      console.error(err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!previewUrl) return;

    const link = document.createElement("a");
    link.href = previewUrl;
    link.download = `${productName.replace(/\s+/g, "-")}-cue-parts.${config.format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleReset = () => {
    setConfig(DEFAULT_IMAGE_CONFIG);
  };

  const currentPart = config.parts[selectedPart];

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            Image Extractor
          </DialogTitle>
          <DialogDescription>
            Generate a 2048×2048 image with 3 views of your cue at 45° angle
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
          {/* Preview Panel */}
          <div className="flex-1 flex flex-col min-w-0">
            <div
              ref={previewContainerRef}
              className="flex-1 bg-muted rounded-lg overflow-hidden relative"
              style={{ minHeight: 400 }}
            >
              {previewUrl && (
                <img
                  src={previewUrl}
                  alt="Preview"
                  className="w-full h-full object-contain"
                />
              )}
              {isGenerating && (
                <div className="absolute inset-0 bg-background/80 flex items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              )}
              {error && (
                <div className="absolute inset-0 flex items-center justify-center text-destructive">
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* Controls Panel */}
          <div className="w-72 flex flex-col gap-4 overflow-y-auto">
            {/* Output Settings */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Output Settings</h4>
              
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Width</Label>
                  <Input
                    type="number"
                    value={config.width}
                    onChange={(e) => setConfig(prev => ({ ...prev, width: parseInt(e.target.value) || 2048 }))}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Height</Label>
                  <Input
                    type="number"
                    value={config.height}
                    onChange={(e) => setConfig(prev => ({ ...prev, height: parseInt(e.target.value) || 2048 }))}
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div>
                <Label className="text-xs">Format</Label>
                <Select
                  value={config.format}
                  onValueChange={(v) => setConfig(prev => ({ ...prev, format: v as "png" | "jpeg" | "webp" }))}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="png">PNG (lossless)</SelectItem>
                    <SelectItem value="jpeg">JPEG (smaller)</SelectItem>
                    <SelectItem value="webp">WebP (modern)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Part Selection */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Adjust Part View</h4>
              
              <div className="flex gap-1">
                {(Object.keys(PART_LABELS) as PartKey[]).map((part) => (
                  <Button
                    key={part}
                    variant={selectedPart === part ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedPart(part)}
                    className="flex-1 text-xs px-2"
                  >
                    {PART_LABELS[part]}
                  </Button>
                ))}
              </div>

              {/* Part Controls */}
              <div className="space-y-3 p-3 bg-muted/50 rounded-lg">
                <div>
                  <Label className="text-xs flex items-center gap-1">
                    <ZoomIn className="h-3 w-3" /> Zoom
                  </Label>
                  <Slider
                    value={[currentPart.zoom]}
                    min={0.5}
                    max={5}
                    step={0.1}
                    onValueChange={([v]) => updatePartConfig(selectedPart, { zoom: v })}
                    className="mt-1"
                  />
                  <span className="text-xs text-muted-foreground">{currentPart.zoom.toFixed(1)}x</span>
                </div>

                <div>
                  <Label className="text-xs flex items-center gap-1">
                    <Move className="h-3 w-3" /> Distance
                  </Label>
                  <Slider
                    value={[currentPart.cameraDistance]}
                    min={0.5}
                    max={5}
                    step={0.1}
                    onValueChange={([v]) => updatePartConfig(selectedPart, { cameraDistance: v })}
                    className="mt-1"
                  />
                  <span className="text-xs text-muted-foreground">{currentPart.cameraDistance.toFixed(1)}</span>
                </div>

                <div>
                  <Label className="text-xs flex items-center gap-1">
                    <RotateCcw className="h-3 w-3" /> Angle (Y)
                  </Label>
                  <Slider
                    value={[currentPart.cameraAngleY * (180 / Math.PI)]}
                    min={-90}
                    max={90}
                    step={5}
                    onValueChange={([v]) => updatePartConfig(selectedPart, { cameraAngleY: v * (Math.PI / 180) })}
                    className="mt-1"
                  />
                  <span className="text-xs text-muted-foreground">{Math.round(currentPart.cameraAngleY * (180 / Math.PI))}°</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button variant="outline" onClick={handleReset} size="sm">
            <RefreshCw className="h-4 w-4 mr-1" />
            Reset
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} size="sm">
              Cancel
            </Button>
            <Button onClick={handleDownload} disabled={!previewUrl || isGenerating} size="sm">
              <Download className="h-4 w-4 mr-1" />
              Download
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
