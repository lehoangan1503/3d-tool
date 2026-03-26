"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Camera, Download, Save, Loader2, HelpCircle, ChevronDown } from "lucide-react";
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

  // Screenshot cache for static frames
  const [frameScreenshots, setFrameScreenshots] = useState<Record<string, string>>({});

  // Shared extractor (ONE instance for all frames)
  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const [extractorReady, setExtractorReady] = useState(false);

  // HDRI state - matches main preview
  const [hdriOptions, setHdriOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [currentHdriType, setCurrentHdriType] = useState<string>("");

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveMode, setSaveMode] = useState<'new' | 'update' | 'choose'>('new');
  const [error, setError] = useState<string | null>(null);

  // Load HDRI options (same as editor-client)
  useEffect(() => {
    if (!open) return;

    const fallback = [
      { id: "bloem_train_track_clear_2k.hdr", label: "Bloem Train Track Clear 2k" },
      { id: "church_museum_2k.hdr", label: "Church Museum 2k" },
      { id: "church_stairway_2k.hdr", label: "Church Stairway 2k" },
      { id: "ferndale_studio_07_2k.hdr", label: "Ferndale Studio 07 2k" },
    ];

    async function loadHdris() {
      try {
        const res = await fetch("/api/hdri");
        const data = (await res.json()) as { options?: Array<{ id: string; label: string }> };
        const options = Array.isArray(data?.options) ? data.options : [];
        setHdriOptions(options.length ? options : fallback);
      } catch {
        setHdriOptions(fallback);
      }
    }

    loadHdris();
  }, [open]);

  // Initialize shared extractor when dialog opens
  useEffect(() => {
    if (!open || !sceneManager) return;

    // Create ONE shared extractor at max resolution (2048x2048)
    // Will be resized per frame but maintains quality
    const extractor = new ExtractorSceneManager(2048, 2048);
    extractorRef.current = extractor;

    // Load model from main scene (already in memory!)
    const model = sceneManager.getModelForClone();
    if (model) {
      extractor.setModel(model);
    }

    // Load HDRI from main scene (same environment)
    const hdriUrl = sceneManager.getCurrentHdriUrl();
    // Extract just the filename from URL for state
    const hdriFilename = hdriUrl.split("/").pop() || "bloem_train_track_clear_2k.hdr";
    setCurrentHdriType(hdriFilename);

    extractor.loadHDRI(hdriUrl).then(() => {
      extractor.setTransparentBackground(true);
      // Start continuous animation loop for live preview
      extractor.startLivePreview();
      setExtractorReady(true);
    });

    return () => {
      if (extractorRef.current) {
        extractorRef.current.dispose();
        extractorRef.current = null;
      }
      setExtractorReady(false);
      setFrameScreenshots({});
    };
  }, [open, sceneManager]);

  // Handle HDRI type change
  const handleHdriTypeChange = useCallback(async (hdriType: string) => {
    setCurrentHdriType(hdriType);
    if (extractorRef.current) {
      const hdriUrl = `/hdri/${encodeURIComponent(hdriType)}`;
      await extractorRef.current.loadHDRI(hdriUrl);
    }
  }, []);

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
      // New layout - clear frames and screenshots
      setFrames([]);
      setFrameScreenshots({});
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
    setFrameScreenshots({}); // Clear old screenshots
    setSelectedReferenceId(null);
    setSelectedFrameId(null);
  };

  const handleScreenshotCapture = useCallback((frameId: string, dataUrl: string) => {
    setFrameScreenshots((prev) => ({ ...prev, [frameId]: dataUrl }));
  }, []);

  const handleAddFrame = () => {
    const newFrame = createDefaultFrame(undefined, frames.length);
    // Offset new frame slightly to avoid overlap
    newFrame.transform.x = 524 + frames.length * 50;
    newFrame.transform.y = 524 + frames.length * 50;
    setFrames([...frames, newFrame]);
    setSelectedFrameId(newFrame.id);
  };

  const handleFrameChange = useCallback((updatedFrame: ExtractorFrame) => {
    setFrames((prev) => prev.map((f) => (f.id === updatedFrame.id ? updatedFrame : f)));
  }, []);

  const handleDeleteFrame = (id: string) => {
    setFrames((prev) => prev.filter((f) => f.id !== id));
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

  const handleSave = async (mode: 'new' | 'update') => {
    if (mode === 'new' && !saveName.trim()) return;
    if (mode === 'update' && !selectedReferenceId) return;
    if (frames.length === 0) return;

    setIsSaving(true);
    try {
      if (mode === 'update' && selectedReferenceId) {
        // Update existing reference
        const currentRef = references.find(r => r.id === selectedReferenceId);
        const res = await fetch(`/api/extractor-references/${selectedReferenceId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            name: currentRef?.name || saveName.trim(), 
            frames 
          }),
        });

        if (res.ok) {
          setShowSaveDialog(false);
          setSaveName("");
          setSaveMode('new');
          loadReferences(); // Refresh list
        } else {
          throw new Error("Update failed");
        }
      } else {
        // Create new reference
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
          setSaveMode('new');
          loadReferences(); // Refresh list
        } else {
          throw new Error("Save failed");
        }
      }
    } catch (err) {
      setError(mode === 'update' ? "Failed to update reference" : "Failed to save reference");
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const openSaveDialog = () => {
    // If using a loaded reference, ask whether to update or create new
    if (selectedReferenceId) {
      setSaveMode('choose');
    } else {
      setSaveMode('new');
    }
    setShowSaveDialog(true);
  };

  const handleExport = async () => {
    if (!sceneManager || frames.length === 0) return;

    setIsExporting(true);
    setError(null);

    try {
      // Create composite canvas
      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_SIZE;
      canvas.height = CANVAS_SIZE;
      const ctx = canvas.getContext("2d")!;

      // Clear with transparency
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Get model from main scene
      const model = sceneManager.getModelForClone();

      // Create ONE extractor for export (full resolution)
      const exportExtractor = new ExtractorSceneManager(2048, 2048);
      if (model) exportExtractor.setModel(model);

      // Load a default HDRI first (will be overridden per frame)
      const defaultHdriUrl = `/hdri/${encodeURIComponent("bloem_train_track_clear_2k.hdr")}`;
      await exportExtractor.loadHDRI(defaultHdriUrl);
      exportExtractor.setTransparentBackground(true);

      // Render each frame sequentially using the same extractor
      for (const frame of frames) {
        // Resize extractor for this frame's dimensions
        exportExtractor.resize(Math.round(frame.transform.width), Math.round(frame.transform.height));

        // Apply frame's cue settings (new control scheme)
        exportExtractor.setModelRotation(frame.cue.spinY);
        exportExtractor.setCameraPhi(frame.cue.phi, 2);
        exportExtractor.setCameraZoom(frame.cue.zoom);
        exportExtractor.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);

        // Apply HDRI layers (new multi-HDRI system)
        if (frame.cue.hdriLayers && frame.cue.hdriLayers.length > 0) {
          await exportExtractor.setHdriLayers(frame.cue.hdriLayers);
        } else if (frame.cue.lightAngle !== undefined) {
          // Legacy fallback
          exportExtractor.setHdriRotation(frame.cue.lightAngle);
        }

        // Capture frame
        const frameDataUrl = exportExtractor.captureFrame("png");
        const img = new Image();
        img.src = frameDataUrl;
        await new Promise((r) => (img.onload = r));

        // Draw with rotation
        ctx.save();
        const centerX = frame.transform.x + frame.transform.width / 2;
        const centerY = frame.transform.y + frame.transform.height / 2;
        ctx.translate(centerX, centerY);
        ctx.rotate((frame.transform.rotation * Math.PI) / 180);

        ctx.drawImage(img, -frame.transform.width / 2, -frame.transform.height / 2, frame.transform.width, frame.transform.height);
        ctx.restore();
      }

      // Clean up export extractor
      exportExtractor.dispose();

      // Download
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = `${productName.replace(/\s+/g, "-")}-cue-extract.png`;
      link.click();
    } catch (err) {
      setError("Export failed");
      console.error(err);
    } finally {
      setIsExporting(false);
    }
  };

  const selectedFrame = frames.find((f) => f.id === selectedFrameId) || null;
  const [showHelp, setShowHelp] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent className="max-w-6xl max-h-[95vh] overflow-hidden flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2">
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5" />
                Image Extractor
              </DialogTitle>

              {/* How to use dropdown */}
              <div className="relative mr-4">
                <Button variant="ghost" size="sm" onClick={() => setShowHelp(!showHelp)} className="text-muted-foreground hover:text-foreground">
                  <HelpCircle className="h-4 w-4 mr-1" />
                  How to use
                  <ChevronDown className={`h-3 w-3 ml-1 transition-transform ${showHelp ? "rotate-180" : ""}`} />
                </Button>

                {showHelp && (
                  <div className="absolute right-0 top-full mt-2 w-[420px] bg-popover border rounded-lg shadow-lg p-4 z-50">
                    {/* Overview */}
                    <p className="text-sm text-muted-foreground mb-4">Create custom frame layouts and save as templates, or load from saved references.</p>

                    {/* Frame Control Diagram */}
                    <div className="text-xs font-medium mb-2">Frame Controls</div>
                    <div className="relative bg-muted/50 rounded-lg p-3 mb-3">
                      {/* Frame diagram */}
                      <div className="relative w-full aspect-square max-w-[200px] mx-auto">
                        {/* Outer frame border - Move area */}
                        <div className="absolute inset-0 border-2 border-blue-500 rounded-lg">
                          {/* Inner 3D control area */}
                          <div className="absolute inset-3 border-2 border-dashed border-green-500 rounded flex items-center justify-center">
                            <span className="text-[10px] text-green-500">3D Control</span>
                          </div>
                        </div>

                        {/* Rotation handle */}
                        <div className="absolute -top-4 left-1/2 -translate-x-1/2 w-5 h-5 bg-purple-500 rounded-full flex items-center justify-center">
                          <span className="text-[8px] text-white">↻</span>
                        </div>

                        {/* Resize handles */}
                        <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-orange-500 rounded-sm" />
                        <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-orange-500 rounded-sm" />
                        <div className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-2.5 h-2.5 bg-orange-500 rounded-sm" />
                        <div className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-2.5 h-2.5 bg-orange-500 rounded-sm" />
                        <div className="absolute -top-1.5 -left-1.5 w-2.5 h-2.5 bg-orange-500 rounded-sm" />
                        <div className="absolute -top-1.5 -right-1.5 w-2.5 h-2.5 bg-orange-500 rounded-sm" />
                        <div className="absolute -bottom-1.5 -left-1.5 w-2.5 h-2.5 bg-orange-500 rounded-sm" />
                        <div className="absolute -bottom-1.5 -right-1.5 w-2.5 h-2.5 bg-orange-500 rounded-sm" />

                        {/* Axis lines preview */}
                        <div className="absolute top-1/2 left-0 right-0 h-[1px] bg-red-500/50" />
                        <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-green-500/50" />
                      </div>

                      {/* Legend */}
                      <div className="mt-4 grid grid-cols-2 gap-2 text-[10px]">
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-3 border-2 border-blue-500 rounded" />
                          <span>Border: Move frame</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-3 border-2 border-dashed border-green-500 rounded" />
                          <span>Center: 3D control</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-3 bg-purple-500 rounded-full" />
                          <span>Circle: Rotate</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-3 bg-orange-500 rounded-sm" />
                          <span>Squares: Resize</span>
                        </div>
                      </div>
                    </div>

                    {/* Axis constraint tip */}
                    <div className="bg-muted/50 rounded-lg p-3">
                      <div className="text-xs font-medium mb-2">Axis-Locked Movement</div>
                      <div className="flex gap-4 text-[11px] text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px] font-mono">X</kbd>
                          <span>+ drag</span>
                          <div className="w-4 h-[2px] bg-red-500 rounded" />
                          <span>horizontal</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px] font-mono">Y</kbd>
                          <span>+ drag</span>
                          <div className="w-[2px] h-4 bg-green-500 rounded" />
                          <span>vertical</span>
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground/70 mt-2">Follows frame&apos;s own axes (works with rotated frames)</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <DialogDescription className="sr-only">Create and export custom frame layouts</DialogDescription>
          </DialogHeader>

          {isLoading || !extractorReady ? (
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
                frameScreenshots={frameScreenshots}
                onScreenshotCapture={handleScreenshotCapture}
                extractorRef={extractorRef}
                extractorReady={extractorReady}
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
                onDeselectFrame={() => setSelectedFrameId(null)}
                onAlignFrames={handleAlignFrames}
                gap={gap}
                onGapChange={setGap}
                hdriOptions={hdriOptions}
              />
            </div>
          )}

          {error && <div className="px-6 py-2 text-sm text-destructive">{error}</div>}

          <DialogFooter className="px-6 py-4 border-t flex justify-end">
            <div className="flex gap-2">
              <Button variant="outline" onClick={openSaveDialog} disabled={frames.length === 0}>
                <Save className="h-4 w-4 mr-2" />
                Save Reference
              </Button>
              <Button onClick={handleExport} disabled={isExporting || frames.length === 0 || !sceneManager}>
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
      <Dialog open={showSaveDialog} onOpenChange={(open) => {
        setShowSaveDialog(open);
        if (!open) {
          setSaveMode('new');
          setSaveName('');
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {saveMode === 'choose' ? 'Save Reference' : saveMode === 'update' ? 'Update Reference' : 'Save as New Reference'}
            </DialogTitle>
            <DialogDescription>
              {saveMode === 'choose' 
                ? 'Update the existing reference or save as a new one?' 
                : saveMode === 'update'
                ? `Update "${references.find(r => r.id === selectedReferenceId)?.name}" with current layout`
                : 'Give your layout a name to reuse it later'}
            </DialogDescription>
          </DialogHeader>
          
          {saveMode === 'choose' ? (
            // Choice mode - update or new
            <div className="py-4 space-y-3">
              <Button 
                variant="outline" 
                className="w-full justify-start h-auto py-3"
                onClick={() => {
                  handleSave('update');
                }}
                disabled={isSaving}
              >
                <div className="text-left">
                  <div className="font-medium">Update existing</div>
                  <div className="text-xs text-muted-foreground">
                    Save changes to &quot;{references.find(r => r.id === selectedReferenceId)?.name}&quot;
                  </div>
                </div>
              </Button>
              <Button 
                variant="outline" 
                className="w-full justify-start h-auto py-3"
                onClick={() => setSaveMode('new')}
              >
                <div className="text-left">
                  <div className="font-medium">Save as new</div>
                  <div className="text-xs text-muted-foreground">
                    Create a new reference with a different name
                  </div>
                </div>
              </Button>
            </div>
          ) : (
            // New reference mode - show name input
            <div className="py-4">
              <Label htmlFor="ref-name">Reference Name</Label>
              <Input 
                id="ref-name" 
                value={saveName} 
                onChange={(e) => setSaveName(e.target.value)} 
                placeholder="e.g., 3 Part Diagonal" 
                className="mt-2"
                autoFocus
              />
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveDialog(false)}>
              Cancel
            </Button>
            {saveMode !== 'choose' && (
              <Button onClick={() => handleSave('new')} disabled={!saveName.trim() || isSaving}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
