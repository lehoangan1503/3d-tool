"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Camera, Download, Save, Loader2, HelpCircle, ChevronDown, FolderDown, Undo2, Redo2, Eye, EyeOff } from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { FrameCanvas, CANVAS_SIZE } from "./frame-canvas";
import { FrameControlsPanel } from "./frame-controls-panel";
import { DownloadMultipleDialog } from "./download-multiple-dialog";
import type { ExtractorFrame, ExtractorReference, TemplateKey, CueFrame, ImageFrame, ImageGradient, HdriLayer } from "@/types/extractor";
import { createDefaultFrame, createDefaultImageFrame, FRAME_TEMPLATES, isCueFrame, isImageFrame, STUDIO_WHITE_HDRI } from "@/types/extractor";
import type { CueHdriConfig } from "@/types/video-studio";
import { DEFAULT_CUE_HDRI } from "@/types/video-studio";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";
import { useUndoable } from "@/hooks/use-undoable";

/** Convert an HdriLayer[] (used by Image Extractor frames) into a CueHdriConfig
 *  so that `setCueHdri()` can apply the HDRI environment map directly to cue
 *  materials.  Uses the first enabled non-studio-white layer, falling back to
 *  DEFAULT_CUE_HDRI. */
function hdriLayersToCueHdri(layers: HdriLayer[]): CueHdriConfig {
  const primary = layers.find(l => l.enabled && l.hdriType !== STUDIO_WHITE_HDRI);
  if (primary) {
    return {
      hdriType: primary.hdriType,
      rotationX: primary.rotationX,
      rotationY: primary.rotationY,
      intensity: primary.intensity,
    };
  }
  return { ...DEFAULT_CUE_HDRI };
}

/**
 * Draws an image onto a 2D canvas context respecting object-fit behaviour,
 * matching the CSS preview in StaticFrame.
/**
 * Create a CanvasGradient from an ImageGradient within a rect centred on (0,0).
 */
function createCanvasGradient(
  ctx: CanvasRenderingContext2D,
  g: ImageGradient,
  w: number,
  h: number,
): CanvasGradient {
  const rad = (g.angle * Math.PI) / 180;
  const halfDiag = Math.sqrt(w * w + h * h) / 2;
  const dx = Math.cos(rad) * halfDiag;
  const dy = Math.sin(rad) * halfDiag;
  const grad = ctx.createLinearGradient(-dx, -dy, dx, dy);
  g.colors.forEach((c, i) => grad.addColorStop(i / Math.max(g.colors.length - 1, 1), c));
  return grad;
}

/**
 * The destination rect is centred on (0, 0) — caller must translate first.
 */
function drawImageWithObjectFit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  destW: number,
  destH: number,
  fit: string = 'cover',
): void {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const x = -destW / 2;
  const y = -destH / 2;

  if (fit === 'cover') {
    const scale = Math.max(destW / iw, destH / ih);
    const sw = destW / scale;
    const sh = destH / scale;
    const sx = (iw - sw) / 2;
    const sy = (ih - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, x, y, destW, destH);
  } else if (fit === 'contain') {
    const scale = Math.min(destW / iw, destH / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, x + (destW - dw) / 2, y + (destH - dh) / 2, dw, dh);
  } else {
    // fill / stretch (default)
    ctx.drawImage(img, x, y, destW, destH);
  }
}

interface ImageExtractorProps {
  sceneManager: SceneManager | null;
  productName: string;
  onClose: () => void;
  open: boolean;
}

export function ImageExtractor({ sceneManager, productName, onClose, open }: ImageExtractorProps) {
  // Frames state with full undo/redo support
  const {
    value: frames,
    set: setFrames,        // discrete ops  → creates a history entry immediately
    setLive: setFramesLive, // continuous ops → no history; call commitFrames when done
    commit: commitFrames,  // flush a live interaction to a single history entry
    reset: resetFrames,    // load new state & wipe history (reference load / new layout)
    undo,
    redo,
    canUndo,
    canRedo,
  } = useUndoable<ExtractorFrame[]>([]);
  // Debounce for panel slider / input changes so rapid tweaks collapse into one undo step
  const commitDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedCommit = useCallback(() => {
    if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
    commitDebounceRef.current = setTimeout(commitFrames, 400);
  }, [commitFrames]);
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  const [references, setReferences] = useState<ExtractorReference[]>([]);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string | null>(null);
  const [gap, setGap] = useState(20);

  // Screenshot cache for static frames
  const [frameScreenshots, setFrameScreenshots] = useState<Record<string, string>>({});

  // Shared extractor (ONE instance for all frames)
  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const [extractorReady, setExtractorReady] = useState(false);

  // Shared extractor used during bulk export — reused across all references to avoid GPU OOM
  const bulkExportExtractorRef = useRef<ExtractorSceneManager | null>(null);

  // HDRI state - matches main preview
  const [hdriOptions, setHdriOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [currentHdriType, setCurrentHdriType] = useState<string>("");

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showDownloadMultipleDialog, setShowDownloadMultipleDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveMode, setSaveMode] = useState<'new' | 'update' | 'choose'>('new');
  const [error, setError] = useState<string | null>(null);
  const [hiddenFrameIds, setHiddenFrameIds] = useState<Set<string>>(new Set());
  const [previewMode, setPreviewMode] = useState(false);

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

    // Pause the main 3D preview — the extractor needs the GPU exclusively
    sceneManager.pauseAnimation();

    // Create shared live-preview extractor at 1024×1024 (display-quality, not export-quality).
    // A separate 2048×2048 extractor is created only for the actual export render.
    const extractor = new ExtractorSceneManager(1024, 1024);
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

    extractor.loadHDRI(hdriUrl).then(async () => {
      // Apply cue HDRI env map so materials get proper reflections
      await extractor.setCueHdri({ ...DEFAULT_CUE_HDRI, hdriType: hdriFilename });
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
      // Clean up bulk export extractor if dialog closes mid-export
      if (bulkExportExtractorRef.current) {
        bulkExportExtractorRef.current.dispose();
        bulkExportExtractorRef.current = null;
      }
      setExtractorReady(false);
      setFrameScreenshots({});
      setSelectedFrameId(null);
      // Resume main scene now that the extractor is fully gone
      sceneManager?.resumeAnimation();
    };
  }, [open, sceneManager]);

  // Re-render all cue frame screenshots when extractor becomes ready
  // (handles dialog reopen — extractor is re-created but screenshots were cleared)
  useEffect(() => {
    if (!extractorReady || frames.length === 0) return;
    const extractor = extractorRef.current;
    if (!extractor) return;

    const cueFrames = frames.filter(isCueFrame);
    if (cueFrames.length === 0) return;

    (async () => {
      extractor.stopLivePreview();
      const screenshots: Record<string, string> = {};
      for (const frame of cueFrames) {
        extractor.resize(Math.round(frame.transform.width), Math.round(frame.transform.height));
        extractor.setModelRotation(frame.cue.spinY);
        extractor.setCameraPhi(frame.cue.phi, 2);
        extractor.setCameraZoom(frame.cue.zoom);
        extractor.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);
        if (frame.cue.hdriLayers && frame.cue.hdriLayers.length > 0) {
          await extractor.setHdriLayers(frame.cue.hdriLayers, { applyCueEnv: true });
          await extractor.setCueHdri(hdriLayersToCueHdri(frame.cue.hdriLayers));
        } else if (frame.cue.lightAngle !== undefined) {
          extractor.setHdriRotation(frame.cue.lightAngle);
        }
        screenshots[frame.id] = extractor.captureFrame('png');
      }
      setFrameScreenshots(screenshots);
      extractor.startLivePreview();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractorReady]);

  // Handle HDRI type change
  const handleHdriTypeChange = useCallback(async (hdriType: string) => {
    setCurrentHdriType(hdriType);
    if (extractorRef.current) {
      const hdriUrl = `/hdri/${encodeURIComponent(hdriType)}`;
      await extractorRef.current.loadHDRI(hdriUrl);
      await extractorRef.current.setCueHdri({ ...DEFAULT_CUE_HDRI, hdriType });
    }
  }, []);

  // Load references on open
  useEffect(() => {
    if (!open) return;
    loadReferences();
  }, [open]);

  const loadReferences = async () => {
    try {
      const res = await fetch("/api/extractor-references?limit=40");
      if (res.ok) {
        const { items } = await res.json();
        setReferences(items);
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
        resetFrames(data.frames); // load → clear history
        setSelectedReferenceId(id);
        setSelectedFrameId(null);

        // Render all cue frames immediately so every frame shows real content
        const extractor = extractorRef.current;
        if (extractor && extractorReady) {
          extractor.stopLivePreview();
          const screenshots: Record<string, string> = {};
          for (const frame of data.frames) {
            if (!isCueFrame(frame)) continue;
            extractor.resize(Math.round(frame.transform.width), Math.round(frame.transform.height));
            extractor.setModelRotation(frame.cue.spinY);
            extractor.setCameraPhi(frame.cue.phi, 2);
            extractor.setCameraZoom(frame.cue.zoom);
            extractor.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);
            if (frame.cue.hdriLayers && frame.cue.hdriLayers.length > 0) {
              await extractor.setHdriLayers(frame.cue.hdriLayers, { applyCueEnv: true });
              await extractor.setCueHdri(hdriLayersToCueHdri(frame.cue.hdriLayers));
            } else if (frame.cue.lightAngle !== undefined) {
              extractor.setHdriRotation(frame.cue.lightAngle);
            }
            screenshots[frame.id] = extractor.captureFrame('png');
          }
          setFrameScreenshots(screenshots);
          extractor.startLivePreview();
        }
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
      resetFrames([]); // load → clear history
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
    setFrames(newFrames); // discrete — undoable
    setFrameScreenshots({});
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
    setFrames([...frames, newFrame]); // discrete — undoable
    setSelectedFrameId(newFrame.id);
  };

  const handleAddImageFrame = () => {
    const newFrame = createDefaultImageFrame(undefined, frames.length);
    // Offset new frame slightly to avoid overlap
    newFrame.transform.x = 524 + frames.length * 50;
    newFrame.transform.y = 524 + frames.length * 50;
    setFrames([...frames, newFrame]); // discrete — undoable
    setSelectedFrameId(newFrame.id);
  };

  // Called on every mousemove/slider tick — live update, no immediate history entry.
  // debouncedCommit collapses rapid panel changes into one undo step after 400 ms idle.
  const handleFrameChange = useCallback((updatedFrame: ExtractorFrame) => {
    setFramesLive((prev) => prev.map((f) => (f.id === updatedFrame.id ? updatedFrame : f)));
    debouncedCommit();
  }, [setFramesLive, debouncedCommit]);

  const handleDeleteFrame = (id: string) => {
    setFrames((prev) => prev.filter((f) => f.id !== id)); // discrete — undoable
    if (selectedFrameId === id) {
      setSelectedFrameId(null);
    }
    setHiddenFrameIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleToggleVisibility = (id: string) => {
    setHiddenFrameIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleReorderFrames = (reordered: ExtractorFrame[]) => {
    setFrames(reordered.map((f, idx) => ({ ...f, order: idx }))); // discrete — undoable
  };

  const handleAlignFrames = () => {
    if (frames.length === 0) return;

    // Only auto-align cue frames; image frames stay in their current position
    const cueFrames = frames.filter(isCueFrame);
    if (cueFrames.length === 0) return;

    const totalWidth = cueFrames.reduce((sum, f) => sum + f.transform.width, 0);
    const totalGaps = (cueFrames.length - 1) * gap;
    const startX = (CANVAS_SIZE - totalWidth - totalGaps) / 2;

    let currentX = startX;
    const alignedById = new Map<string, ExtractorFrame>();
    for (const f of cueFrames) {
      alignedById.set(f.id, {
        ...f,
        transform: {
          ...f.transform,
          x: currentX,
          y: (CANVAS_SIZE - f.transform.height) / 2,
        },
      });
      currentX += f.transform.width + gap;
    }

    // Merge: cue frames updated, image frames untouched
    const alignedFrames = frames.map((f) => alignedById.get(f.id) ?? f);
    setFrames(alignedFrames); // discrete — undoable
  };

  const handleRenameFrame = (id: string, name: string) => {
    setFrames((prev) =>
      prev.map((f) => (f.id === id ? { ...f, name: name || undefined } : f))
    );
  };

  const handleSave = async (mode: 'new' | 'update') => {
    if (mode === 'new' && !saveName.trim()) return;
    if (mode === 'update' && !selectedReferenceId) return;
    if (frames.length === 0) return;

    setIsSaving(true);
    try {
      // Upload any locally-loaded images (data URLs) before persisting
      const readyFrames = await Promise.all(
        frames.map(async (frame) => {
          if (isImageFrame(frame) && frame.imageSettings.imageUrl?.startsWith('data:')) {
            try {
              const blob = await fetch(frame.imageSettings.imageUrl).then((r) => r.blob());
              const fd = new FormData();
              fd.append('file', blob, 'overlay.png');
              const res = await fetch('/api/upload-overlay', { method: 'POST', body: fd });
              if (res.ok) {
                const { url } = await res.json();
                return { ...frame, imageSettings: { ...frame.imageSettings, imageUrl: url } };
              }
            } catch {
              // keep the data URL if upload fails
            }
          }
          return frame;
        })
      );

      // Render current canvas state at 2048 then downscale to 496×496 for thumbnail
      let thumbBlob: Blob | null = null;
      try {
        const refData: ExtractorReference = { id: '', name: '', frames: readyFrames };
        const fullBlob = await handleRenderReference(refData);
        const fullImg = new Image();
        fullImg.src = URL.createObjectURL(fullBlob);
        await new Promise((r) => { fullImg.onload = r; });
        const tc = document.createElement('canvas');
        tc.width = 496;
        tc.height = 496;
        tc.getContext('2d')!.drawImage(fullImg, 0, 0, 496, 496);
        URL.revokeObjectURL(fullImg.src);
        thumbBlob = await new Promise<Blob>((resolve, reject) => {
          tc.toBlob((b) => b ? resolve(b) : reject(new Error('Thumb blob failed')), 'image/png');
        });
      } catch (err) {
        console.error('Thumbnail capture failed:', err);
      }

      let savedRefId: string;

      if (mode === 'update' && selectedReferenceId) {
        const currentRef = references.find(r => r.id === selectedReferenceId);
        const res = await fetch(`/api/extractor-references/${selectedReferenceId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: currentRef?.name || saveName.trim(), frames: readyFrames }),
        });

        if (!res.ok) throw new Error("Update failed");
        setFrames(readyFrames);
        savedRefId = selectedReferenceId;
      } else {
        const res = await fetch("/api/extractor-references", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: saveName.trim(), frames: readyFrames }),
        });

        if (!res.ok) throw new Error("Save failed");
        const data = await res.json();
        setFrames(readyFrames);
        setSelectedReferenceId(data.id);
        savedRefId = data.id;
      }

      // Upload thumbnail
      if (thumbBlob) {
        try {
          const fd = new FormData();
          fd.append('file', thumbBlob, 'thumbnail.png');
          await fetch(`/api/extractor-references/${savedRefId}/thumbnail`, { method: 'POST', body: fd });
        } catch (err) {
          console.error('Thumbnail upload failed:', err);
        }
      }

      setShowSaveDialog(false);
      setSaveName("");
      setSaveMode('new');
      loadReferences();
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

  const handleRenameReference = async (id: string, newName: string) => {
    try {
      const res = await fetch(`/api/extractor-references/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) {
        loadReferences();
      }
    } catch (err) {
      console.error("Failed to rename reference:", err);
    }
  };

  const handleDeleteReference = async (id: string) => {
    try {
      const res = await fetch(`/api/extractor-references/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        if (selectedReferenceId === id) {
          setSelectedReferenceId(null);
          resetFrames([]); // load → clear history
          setFrameScreenshots({});
        }
        loadReferences();
      }
    } catch (err) {
      console.error("Failed to delete reference:", err);
    }
  };

  const handleExport = async () => {
    if (!sceneManager || frames.length === 0) return;

    setIsExporting(true);
    setError(null);

    // Stop live preview so the export extractor has the GPU to itself
    extractorRef.current?.stopLivePreview();

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

      // Render all frames in order (cue frames via 3D extractor, image frames drawn directly)
      for (const frame of frames) {
        if (isCueFrame(frame)) {
          // Resize extractor for this frame's dimensions
          exportExtractor.resize(Math.round(frame.transform.width), Math.round(frame.transform.height));

          // Apply frame's cue settings (new control scheme)
          exportExtractor.setModelRotation(frame.cue.spinY);
          exportExtractor.setCameraPhi(frame.cue.phi, 2);
          exportExtractor.setCameraZoom(frame.cue.zoom);
          exportExtractor.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);

          // Apply HDRI layers (new multi-HDRI system)
          if (frame.cue.hdriLayers && frame.cue.hdriLayers.length > 0) {
            await exportExtractor.setHdriLayers(frame.cue.hdriLayers, { applyCueEnv: true });
            // setCueHdri is skipped when applyCueEnv is true (setHdriLayers handles cue)
            await exportExtractor.setCueHdri(hdriLayersToCueHdri(frame.cue.hdriLayers));
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
        } else if (isImageFrame(frame)) {
          ctx.save();
          const centerX = frame.transform.x + frame.transform.width / 2;
          const centerY = frame.transform.y + frame.transform.height / 2;
          ctx.translate(centerX, centerY);
          ctx.rotate((frame.transform.rotation * Math.PI) / 180);

          const hw = frame.transform.width / 2;
          const hh = frame.transform.height / 2;

          // Draw background fill
          if (frame.imageSettings.backgroundEnabled) {
            ctx.globalAlpha = frame.imageSettings.backgroundOpacity ?? 1;
            if (frame.imageSettings.backgroundType === "gradient" && frame.imageSettings.backgroundGradient) {
              ctx.fillStyle = createCanvasGradient(ctx, frame.imageSettings.backgroundGradient, frame.transform.width, frame.transform.height);
            } else {
              ctx.fillStyle = frame.imageSettings.backgroundColor;
            }
            ctx.fillRect(-hw, -hh, frame.transform.width, frame.transform.height);
            ctx.globalAlpha = 1;
          }

          // Draw image layer
          if (frame.imageSettings.imageUrl) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = resolveStorageUrl(frame.imageSettings.imageUrl)!;
            await new Promise((r) => { img.onload = r; img.onerror = r; });
            ctx.globalAlpha = frame.imageSettings.imageOpacity ?? 1;
            const blendMode = frame.imageSettings.blendMode === 'normal' ? 'source-over' : frame.imageSettings.blendMode;
            ctx.globalCompositeOperation = blendMode as GlobalCompositeOperation;
            drawImageWithObjectFit(ctx, img, frame.transform.width, frame.transform.height, frame.imageSettings.objectFit ?? 'cover');
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
          }

          ctx.restore();
        }
      }

      // Dispose export extractor before restarting live preview
      exportExtractor.dispose();

      // Download
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      const refName = references.find(r => r.id === selectedReferenceId)?.name;
      const nameParts = [productName.replace(/\s+/g, "-"), "cue-extract"];
      if (refName) nameParts.push(refName.replace(/\s+/g, "-"));
      link.download = `${nameParts.join("-")}.png`;
      link.click();
    } catch (err) {
      setError("Export failed");
      console.error(err);
    } finally {
      setIsExporting(false);
      // Restart live preview now that export extractor is gone
      extractorRef.current?.startLivePreview();
    }
  };

  // Render a reference to a PNG blob (for batch export)
  const handleRenderReference = useCallback(async (reference: ExtractorReference): Promise<Blob> => {
    if (!sceneManager) {
      throw new Error("Scene manager not available");
    }

    // Create composite canvas
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext("2d")!;

    // Clear with transparency
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Reuse shared bulk extractor if one was prepared (avoids re-creating WebGL context per render)
    const ownExtractor = !bulkExportExtractorRef.current;
    let exportExtractor: ExtractorSceneManager;

    if (bulkExportExtractorRef.current) {
      exportExtractor = bulkExportExtractorRef.current;
    } else {
      // Single render path — stop live preview so export has the GPU to itself
      extractorRef.current?.stopLivePreview();
      const model = sceneManager.getModelForClone();
      exportExtractor = new ExtractorSceneManager(2048, 2048);
      if (model) exportExtractor.setModel(model);
      const defaultHdriUrl = `/hdri/${encodeURIComponent("bloem_train_track_clear_2k.hdr")}`;
      await exportExtractor.loadHDRI(defaultHdriUrl);
      exportExtractor.setTransparentBackground(true);
    }

    // Render all frames in order (cue frames via 3D extractor, image frames drawn directly)
    try {
      for (const frame of reference.frames) {
        if (isCueFrame(frame)) {
          // Resize extractor for this frame's dimensions
          exportExtractor.resize(Math.round(frame.transform.width), Math.round(frame.transform.height));

          // Apply frame's cue settings
          exportExtractor.setModelRotation(frame.cue.spinY);
          exportExtractor.setCameraPhi(frame.cue.phi, 2);
          exportExtractor.setCameraZoom(frame.cue.zoom);
          exportExtractor.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);

          // Apply HDRI layers
          if (frame.cue.hdriLayers && frame.cue.hdriLayers.length > 0) {
            await exportExtractor.setHdriLayers(frame.cue.hdriLayers, { applyCueEnv: true });
            // setCueHdri is skipped when applyCueEnv is true (setHdriLayers handles cue)
            await exportExtractor.setCueHdri(hdriLayersToCueHdri(frame.cue.hdriLayers));
          } else if (frame.cue.lightAngle !== undefined) {
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
        } else if (isImageFrame(frame)) {
          ctx.save();
          const centerX = frame.transform.x + frame.transform.width / 2;
          const centerY = frame.transform.y + frame.transform.height / 2;
          ctx.translate(centerX, centerY);
          ctx.rotate((frame.transform.rotation * Math.PI) / 180);

          const hw = frame.transform.width / 2;
          const hh = frame.transform.height / 2;

          // Draw background fill
          if (frame.imageSettings.backgroundEnabled) {
            ctx.globalAlpha = frame.imageSettings.backgroundOpacity ?? 1;
            if (frame.imageSettings.backgroundType === "gradient" && frame.imageSettings.backgroundGradient) {
              ctx.fillStyle = createCanvasGradient(ctx, frame.imageSettings.backgroundGradient, frame.transform.width, frame.transform.height);
            } else {
              ctx.fillStyle = frame.imageSettings.backgroundColor;
            }
            ctx.fillRect(-hw, -hh, frame.transform.width, frame.transform.height);
            ctx.globalAlpha = 1;
          }

          // Draw image layer
          if (frame.imageSettings.imageUrl) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = resolveStorageUrl(frame.imageSettings.imageUrl)!;
            await new Promise((r) => { img.onload = r; img.onerror = r; });
            ctx.globalAlpha = frame.imageSettings.imageOpacity ?? 1;
            const blendMode = frame.imageSettings.blendMode === 'normal' ? 'source-over' : frame.imageSettings.blendMode;
            ctx.globalCompositeOperation = blendMode as GlobalCompositeOperation;
            drawImageWithObjectFit(ctx, img, frame.transform.width, frame.transform.height, frame.imageSettings.objectFit ?? 'cover');
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
          }

          ctx.restore();
        }
      }
    } finally {
      if (ownExtractor) {
        // Dispose the single-use export extractor and restore live preview
        exportExtractor.dispose();
        extractorRef.current?.startLivePreview();
      }
    }

    // Convert canvas to blob
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Failed to create blob"));
        }
      }, "image/png");
    });
  }, [sceneManager]);

  /**
   * Called before bulk export begins.
   * Stops the live preview loop and creates a shared ExtractorSceneManager
   * reused across all renders — avoiding repeated WebGL context creation/destruction.
   * NOTE: main scene is already paused while this dialog is open; don't re-pause here.
   */
  const handleBulkExportStart = useCallback(async () => {
    if (!sceneManager) return;

    // Stop live preview so export has exclusive GPU access
    extractorRef.current?.stopLivePreview();

    const model = sceneManager.getModelForClone();
    const ext = new ExtractorSceneManager(2048, 2048);
    if (model) ext.setModel(model);
    const hdriUrl = sceneManager.getCurrentHdriUrl();
    await ext.loadHDRI(hdriUrl);
    ext.setTransparentBackground(true);
    bulkExportExtractorRef.current = ext;
  }, [sceneManager]);

  /**
   * Called after bulk export ends (success or error).
   * Disposes the shared extractor and restarts the live preview.
   * NOTE: main scene stays paused — it will resume when the dialog closes.
   */
  const handleBulkExportEnd = useCallback(() => {
    bulkExportExtractorRef.current?.dispose();
    bulkExportExtractorRef.current = null;
    // Restart live preview now that no export extractor is competing for GPU
    extractorRef.current?.startLivePreview();
  }, []);

  const selectedFrame = frames.find((f) => f.id === selectedFrameId) || null;
  const [showHelp, setShowHelp] = useState(false);

  // Keyboard shortcuts: Cmd/Ctrl+Z → undo, Shift+Cmd/Ctrl+Z or Ctrl+Y → redo
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, undo, redo]);

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

              {/* Undo / Redo */}
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={undo}
                  disabled={!canUndo}
                  title="Undo (⌘Z)"
                >
                  <Undo2 className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={redo}
                  disabled={!canRedo}
                  title="Redo (⇧⌘Z)"
                >
                  <Redo2 className="h-4 w-4" />
                </Button>
              </div>

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
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div className="flex flex-1 min-h-0 overflow-hidden">
                {/* Canvas Area */}
                <FrameCanvas
                  frames={frames}
                  selectedFrameId={selectedFrameId}
                  hiddenFrameIds={hiddenFrameIds}
                  onSelectFrame={setSelectedFrameId}
                  onFrameChange={handleFrameChange}
                  sceneManager={sceneManager}
                  frameScreenshots={frameScreenshots}
                  onScreenshotCapture={handleScreenshotCapture}
                  extractorRef={extractorRef}
                  extractorReady={extractorReady}
                  onDragEnd={commitFrames}
                  previewMode={previewMode}
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
                  onAddImageFrame={handleAddImageFrame}
                  onDeselectFrame={() => setSelectedFrameId(null)}
                  selectedFrameId={selectedFrameId}
                  hiddenFrameIds={hiddenFrameIds}
                  onSelectFrame={setSelectedFrameId}
                  onReorderFrames={handleReorderFrames}
                  onToggleVisibility={handleToggleVisibility}
                  onAlignFrames={handleAlignFrames}
                  gap={gap}
                  onGapChange={setGap}
                  hdriOptions={hdriOptions}
                  onRenameReference={handleRenameReference}
                  onDeleteReference={handleDeleteReference}
                  onRenameFrame={handleRenameFrame}
                  onRenderReference={handleRenderReference}
                />
              </div>
            </div>
          )}

          {error && <div className="px-6 py-2 text-sm text-destructive">{error}</div>}

          <DialogFooter className="px-6 py-4 border-t flex justify-between">
            <Button
              variant={previewMode ? "default" : "outline"}
              onClick={() => setPreviewMode((v) => !v)}
              disabled={frames.length === 0}
            >
              {previewMode ? (
                <>
                  <EyeOff className="h-4 w-4 mr-2" />
                  Exit Preview
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4 mr-2" />
                  Preview Final
                </>
              )}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={openSaveDialog} disabled={frames.length === 0}>
                <Save className="h-4 w-4 mr-2" />
                Save Reference
              </Button>
              <Button variant="outline" onClick={() => setShowDownloadMultipleDialog(true)}>
                <FolderDown className="h-4 w-4 mr-2" />
                Download Multiple
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

      {/* Download Multiple Dialog */}
      <DownloadMultipleDialog
        open={showDownloadMultipleDialog}
        onOpenChange={setShowDownloadMultipleDialog}
        productName={productName}
        onRenderReference={handleRenderReference}
        onExportStart={handleBulkExportStart}
        onExportEnd={handleBulkExportEnd}
      />

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
