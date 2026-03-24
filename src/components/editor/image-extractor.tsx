"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Camera, Download, Save, Loader2 } from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { FrameCanvas, CANVAS_SIZE } from "./frame-canvas";
import { FrameControlsPanel } from "./frame-controls-panel";
import type { ExtractorFrame, ExtractorReference, TemplateKey } from "@/types/extractor";
import { createDefaultFrame, FRAME_TEMPLATES } from "@/types/extractor";

interface ImageExtractorProps {
  sceneManager: SceneManager | null;
  productName: string;
  onClose: () => void;
  open: boolean;
}

export function ImageExtractor({ sceneManager, productName, onClose, open }: ImageExtractorProps) {
  // State
  const [frames, setFrames] = useState<ExtractorFrame[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  const [references, setReferences] = useState<ExtractorReference[]>([]);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string | null>(null);
  const [gap, setGap] = useState(20);
  
  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Load references on open
  useEffect(() => {
    if (!open) return;
    loadReferences();
  }, [open]);

  const loadReferences = async () => {
    try {
      const res = await fetch("/api/extractor-references");
      if (res.ok) {
        const data = await res.json();
        setReferences(data);
      }
    } catch (err) {
      console.error("Failed to load references:", err);
    }
  };

  const loadReference = async (id: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/extractor-references/${id}`);
      if (res.ok) {
        const data: ExtractorReference = await res.json();
        setFrames(data.frames);
        setSelectedReferenceId(id);
        setSelectedFrameId(null);
      }
    } catch (err) {
      setError("Failed to load reference");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectReference = (id: string | null) => {
    if (id) {
      loadReference(id);
    } else {
      // New layout - clear frames
      setFrames([]);
      setSelectedReferenceId(null);
      setSelectedFrameId(null);
    }
  };

  const handleApplyTemplate = (key: TemplateKey) => {
    const template = FRAME_TEMPLATES[key];
    // Deep clone frames with new IDs
    const newFrames = template.frames.map((f, idx) => ({
      ...f,
      id: crypto.randomUUID(),
      order: idx,
      transform: { ...f.transform },
      cue: { ...f.cue },
    }));
    setFrames(newFrames);
    setSelectedReferenceId(null);
    setSelectedFrameId(null);
  };

  const handleAddFrame = () => {
    const newFrame = createDefaultFrame(undefined, frames.length);
    // Offset new frame slightly to avoid overlap
    newFrame.transform.x = 524 + (frames.length * 50);
    newFrame.transform.y = 524 + (frames.length * 50);
    setFrames([...frames, newFrame]);
    setSelectedFrameId(newFrame.id);
  };

  const handleFrameChange = useCallback((updatedFrame: ExtractorFrame) => {
    setFrames(prev => prev.map(f => f.id === updatedFrame.id ? updatedFrame : f));
  }, []);

  const handleDeleteFrame = (id: string) => {
    setFrames(prev => prev.filter(f => f.id !== id));
    if (selectedFrameId === id) {
      setSelectedFrameId(null);
    }
  };

  const handleAlignFrames = () => {
    if (frames.length === 0) return;
    
    // Auto-distribute frames horizontally with gap, preserving rotation
    const totalWidth = frames.reduce((sum, f) => sum + f.transform.width, 0);
    const totalGaps = (frames.length - 1) * gap;
    const startX = (CANVAS_SIZE - totalWidth - totalGaps) / 2;
    
    let currentX = startX;
    const alignedFrames = frames.map((f) => {
      const aligned = {
        ...f,
        transform: {
          ...f.transform,
          x: currentX,
          y: (CANVAS_SIZE - f.transform.height) / 2, // Center vertically
          // Keep existing rotation - don't reset
        },
      };
      currentX += f.transform.width + gap;
      return aligned;
    });
    
    setFrames(alignedFrames);
  };

  const handleSave = async () => {
    if (!saveName.trim() || frames.length === 0) return;
    
    setIsSaving(true);
    try {
      const res = await fetch("/api/extractor-references", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), frames }),
      });
      
      if (res.ok) {
        const data = await res.json();
        setSelectedReferenceId(data.id);
        setShowSaveDialog(false);
        setSaveName("");
        loadReferences(); // Refresh list
      } else {
        throw new Error("Save failed");
      }
    } catch (err) {
      setError("Failed to save reference");
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleExport = async () => {
    if (!sceneManager || frames.length === 0) return;
    
    setIsExporting(true);
    setError(null);

    try {
      // Create composite canvas
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_SIZE;
      canvas.height = CANVAS_SIZE;
      const ctx = canvas.getContext('2d')!;
      
      // Clear with transparency
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Get model and HDRI from main scene
      const model = sceneManager.getModelForClone();
      const hdriUrl = sceneManager.getCurrentHdriUrl();

      // Render each frame
      for (const frame of frames) {
        const extractor = new ExtractorSceneManager(
          Math.round(frame.transform.width),
          Math.round(frame.transform.height)
        );

        if (model) extractor.setModel(model);
        await extractor.loadHDRI(hdriUrl);
        extractor.setTransparentBackground(true);
        extractor.setCameraOrbit(frame.cue.orbitX, frame.cue.orbitY, 2, 0);
        extractor.setCameraZoom(frame.cue.zoom);
        extractor.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);
        extractor.setDirectionalLight(frame.cue.lightAngle);

        // Capture frame
        const frameDataUrl = extractor.captureFrame('png');
        const img = new Image();
        img.src = frameDataUrl;
        await new Promise(r => img.onload = r);

        // Draw with rotation
        ctx.save();
        const centerX = frame.transform.x + frame.transform.width / 2;
        const centerY = frame.transform.y + frame.transform.height / 2;
        ctx.translate(centerX, centerY);
        ctx.rotate((frame.transform.rotation * Math.PI) / 180);
        
        // Clip to canvas bounds
        ctx.beginPath();
        ctx.rect(-centerX, -centerY, CANVAS_SIZE, CANVAS_SIZE);
        ctx.clip();
        
        ctx.drawImage(
          img,
          -frame.transform.width / 2,
          -frame.transform.height / 2,
          frame.transform.width,
          frame.transform.height
        );
        ctx.restore();

        extractor.dispose();
      }

      // Download
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `${productName.replace(/\s+/g, '-')}-cue-extract.png`;
      link.click();
    } catch (err) {
      setError("Export failed");
      console.error(err);
    } finally {
      setIsExporting(false);
    }
  };

  const selectedFrame = frames.find(f => f.id === selectedFrameId) || null;

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent className="max-w-6xl max-h-[95vh] overflow-hidden flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2">
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              Image Extractor
            </DialogTitle>
            <DialogDescription>
              Create custom frame layouts • Drag to move • Handles to resize • Top circle to rotate
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : (
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Canvas Area */}
              <FrameCanvas
                frames={frames}
                selectedFrameId={selectedFrameId}
                onSelectFrame={setSelectedFrameId}
                onFrameChange={handleFrameChange}
                sceneManager={sceneManager}
              />

              {/* Controls Panel */}
              <FrameControlsPanel
                references={references}
                selectedReferenceId={selectedReferenceId}
                onSelectReference={handleSelectReference}
                frames={frames}
                selectedFrame={selectedFrame}
                onFrameChange={handleFrameChange}
                onDeleteFrame={handleDeleteFrame}
                onAddFrame={handleAddFrame}
                onApplyTemplate={handleApplyTemplate}
                onAlignFrames={handleAlignFrames}
                gap={gap}
                onGapChange={setGap}
              />
            </div>
          )}

          {error && (
            <div className="px-6 py-2 text-sm text-destructive">{error}</div>
          )}

          <DialogFooter className="px-6 py-4 border-t flex justify-between sm:justify-between">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setShowSaveDialog(true)}
                disabled={frames.length === 0}
              >
                <Save className="h-4 w-4 mr-2" />
                Save Reference
              </Button>
              <Button
                onClick={handleExport}
                disabled={isExporting || frames.length === 0 || !sceneManager}
              >
                {isExporting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Exporting...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2" />
                    Download PNG
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save Reference Dialog */}
      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save Reference</DialogTitle>
            <DialogDescription>
              Give your layout a name to reuse it later
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="ref-name">Reference Name</Label>
            <Input
              id="ref-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="e.g., 3 Part Diagonal"
              className="mt-2"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!saveName.trim() || isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
