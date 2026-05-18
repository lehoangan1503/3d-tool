"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Camera, Download, Save, Loader2, HelpCircle, ChevronDown, FolderDown, Undo2, Redo2, Eye, EyeOff, Plus } from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { FrameCanvas, CANVAS_SIZE } from "./frame-canvas";
import { FrameControlsPanel } from "./frame-controls-panel";
import { DownloadMultipleDialog } from "./download-multiple-dialog";
import type { ExtractorFrame, ExtractorReference, TemplateKey, CueFrame, ImageFrame, ImageGradient, HdriLayer, ImageRatio } from "@/types/extractor";
import { createDefaultFrame, createDefaultImageFrame, DEFAULT_CUE_SHADOW, FRAME_TEMPLATES, isCueFrame, isImageFrame, STUDIO_WHITE_HDRI, DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT } from "@/types/extractor";
import type { CueHdriConfig } from "@/types/video-studio";
import { DEFAULT_CUE_HDRI } from "@/types/video-studio";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";
import { useUndoable } from "@/hooks/use-undoable";
import { forceWhiteWalls } from "@/lib/three/studio-helpers";
import { invalidateReferenceListCache } from "@/hooks/use-reference-list";

/** Convert an HdriLayer[] (used by Image Extractor frames) into a CueHdriConfig
 *  so that `setCueHdri()` can apply the HDRI environment map directly to cue
 *  materials.  Uses the first enabled non-studio-white layer, falling back to
 *  DEFAULT_CUE_HDRI. */
export function hdriLayersToCueHdri(layers: HdriLayer[]): CueHdriConfig {
  const primary = layers.find((l) => l.enabled && l.hdriType !== STUDIO_WHITE_HDRI);
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
 * Render a cue frame using the full studio pipeline (matches the simulator's "Xem trước kết quả").
 * Sets up the studio scene from the saved snapshot, renders, and captures.
 * Returns a data URL. Caller must provide a cloned model.
 * If `reuseEsm` is provided, reuses it instead of creating/disposing a new ESM per frame.
 */
/** Migrate a snapshot saved against the old studio layout (wall y=4.5, table y=-7.5)
 *  to the current layout (wall y=10, table y=-2) by shifting all Y positions +5.5. */
function migrateSnapshotLayout(snapshot: import("@/types/video-studio").VideoStudioConfig): import("@/types/video-studio").VideoStudioConfig {
  const Y_SHIFT = 5.5;
  const OLD_TABLE_Y = -7.5;
  // Only apply to old-layout snapshots: camera below old table + shift threshold
  if (snapshot.cameraStart.y >= OLD_TABLE_Y + Y_SHIFT) return snapshot;
  return {
    ...snapshot,
    cameraStart: { ...snapshot.cameraStart, y: snapshot.cameraStart.y + Y_SHIFT },
    cueConfig: {
      ...snapshot.cueConfig,
      instances: snapshot.cueConfig.instances.map(i => ({ ...i, positionY: i.positionY + Y_SHIFT })),
    },
  };
}

export async function renderCueFrameViaStudio(
  model: ReturnType<SceneManager["getModelForClone"]>,
  snapshot: import("@/types/video-studio").VideoStudioConfig,
  width: number,
  height: number,
  reuseEsm?: ExtractorSceneManager,
  wallsTransparent?: boolean,
  overrideSurfaceUrl?: string,
): Promise<string> {
  const size = Math.max(2048, width, height);
  const studioEsm = reuseEsm ?? new ExtractorSceneManager(size, size);
  // Apply layout migration so old snapshots render correctly in the current studio
  const migratedSnapshot = migrateSnapshotLayout(snapshot);
  try {
    if (reuseEsm) studioEsm.resize(size, size);
    if (model) studioEsm.setModel(model);

    // Setup the full studio scene (walls, lights, shadow floor, camera)
    await studioEsm.setupStudioFromStudioConfig(migratedSnapshot);
    forceWhiteWalls(studioEsm);

    // Switch to simulator mode so individual per-instance cue groups are used,
    // matching the preview pipeline from the Simulator dialog exactly.
    studioEsm.enableSimulatorMode();
    studioEsm.setupSimulatorCueGroups(migratedSnapshot.cueConfig);
    // Apply surface to each simulator group. overrideSurfaceUrl replaces the snapshot's
    // sourceSurfaceUrl for every instance (used by bulk dashboard export to apply the
    // current product's surface). Falls back to the snapshot's own URL for the normal path.
    const surfacePromises = migratedSnapshot.cueConfig.instances.map((inst, i) => {
      const url = overrideSurfaceUrl ?? inst.sourceSurfaceUrl;
      return url ? studioEsm.applySurfaceToSimulatorCueGroup(i, url) : Promise.resolve();
    });
    await Promise.all(surfacePromises);

    // Invalidate cue HDRI dedup caches so the explicit setCueHdri / setCueHdriLayers calls
    // below bypass dedup and re-apply envMap to the newly-built simulator groups.
    studioEsm.invalidateCueHdriCache();

    // Apply all config properties (cue transforms, shadow, HDRI, camera)
    studioEsm.updateStudioPreviewConfig(migratedSnapshot);
    // forceWhiteWalls again in case updateSurfaceHdri replaced materials
    forceWhiteWalls(studioEsm);

    // Explicitly await async HDRI operations that updateStudioPreviewConfig fires without awaiting.
    // Wall/surface lights:
    const layers = migratedSnapshot.hdriConfig?.layers ?? [];
    if (layers.length > 0) {
      await studioEsm.setHdriLayers(layers);
    }
    // Cue HDRI — use multi-layer blend when available (matches simulator preview),
    // fall back to legacy single-HDRI for old snapshots that don't have cueHdriLayers.
    if (migratedSnapshot.cueHdriLayers && migratedSnapshot.cueHdriLayers.length > 0) {
      await studioEsm.setCueHdriLayers(migratedSnapshot.cueHdriLayers);
    } else {
      const cueHdri = migratedSnapshot.cueHdri ?? DEFAULT_CUE_HDRI;
      await studioEsm.setCueHdri(cueHdri);
    }
    // Final safety: directly push current envMap to all simulator groups in case
    // any dedup path still prevented the calls above from running.
    studioEsm.reapplyCurrentCueEnvMap();
    forceWhiteWalls(studioEsm);

    studioEsm.render();

    return studioEsm.captureCleanFrame(size, "png", wallsTransparent ?? false);
  } finally {
    // Only dispose if we created it (not reusing)
    if (!reuseEsm) studioEsm.dispose();
  }
}

/**
 * Renders one ExtractorReference for a given product model and returns a PNG Blob.
 *
 * Used by the bulk image export pipeline. Creates a canvas of the reference's
 * declared canvas dimensions, composites all frames (cue + image), and returns
 * the result as a PNG blob.
 *
 * @param model              - Three.js model group (from `SceneManager.getModelForClone()`)
 * @param reference          - Reference with frames to composite
 * @param overrideSurfaceUrl - When provided, applied to every cue instance instead of
 *                             the snapshot's original sourceSurfaceUrl. Use this in bulk
 *                             dashboard export to apply the current product's surface.
 */
export async function renderReferenceToBlob(
  model: ReturnType<SceneManager["getModelForClone"]>,
  reference: ExtractorReference,
  overrideSurfaceUrl?: string,
): Promise<Blob> {
  const canvasWidth  = reference.canvasWidth  ?? DEFAULT_CANVAS_WIDTH;
  const canvasHeight = reference.canvasHeight ?? DEFAULT_CANVAS_HEIGHT;

  const canvas = document.createElement("canvas");
  canvas.width  = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const studioEsm = new ExtractorSceneManager(2048, 2048);
  let legacyEsm: ExtractorSceneManager | null = null;

  try {
    for (const frame of reference.frames) {
      if (isCueFrame(frame)) {
        const shadow = frame.cue.studioShadow ?? DEFAULT_CUE_SHADOW;
        let frameDataUrl: string;

        if (shadow.studioConfigSnapshot) {
          frameDataUrl = await renderCueFrameViaStudio(
            model,
            shadow.studioConfigSnapshot,
            Math.round(frame.transform.width),
            Math.round(frame.transform.height),
            studioEsm,
            shadow.wallsTransparent,
            overrideSurfaceUrl,
          );
        } else {
          if (!legacyEsm) {
            legacyEsm = new ExtractorSceneManager(canvasWidth, canvasHeight);
            const defaultHdriUrl = `/hdri/${encodeURIComponent("bloem_train_track_clear_2k.hdr")}`;
            await legacyEsm.loadHDRI(defaultHdriUrl);
            legacyEsm.setTransparentBackground(true);
            if (model) legacyEsm.setModel(model);
          }
          legacyEsm.resize(Math.round(frame.transform.width), Math.round(frame.transform.height));
          legacyEsm.setModelRotation(frame.cue.spinY);
          legacyEsm.setCameraPhi(frame.cue.phi, 2);
          legacyEsm.setCameraZoom(frame.cue.zoom);
          legacyEsm.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);
          if (frame.cue.hdriLayers && frame.cue.hdriLayers.length > 0) {
            await legacyEsm.setHdriLayers(frame.cue.hdriLayers, { applyCueEnv: true });
            await legacyEsm.setCueHdri(hdriLayersToCueHdri(frame.cue.hdriLayers));
          } else if (frame.cue.lightAngle !== undefined) {
            legacyEsm.setHdriRotation(frame.cue.lightAngle);
          }
          legacyEsm.setFrameShadow(shadow);
          legacyEsm.setFrameShadowQuality(4096);
          legacyEsm.render();
          frameDataUrl = legacyEsm.captureFrame("png");
        }

        const img = new Image();
        img.src = frameDataUrl;
        await new Promise((r) => { img.onload = r; });
        ctx.save();
        const cx = frame.transform.x + frame.transform.width / 2;
        const cy = frame.transform.y + frame.transform.height / 2;
        ctx.translate(cx, cy);
        ctx.rotate((frame.transform.rotation * Math.PI) / 180);
        ctx.drawImage(img, -frame.transform.width / 2, -frame.transform.height / 2, frame.transform.width, frame.transform.height);
        ctx.restore();
      } else if (isImageFrame(frame)) {
        ctx.save();
        const cx = frame.transform.x + frame.transform.width / 2;
        const cy = frame.transform.y + frame.transform.height / 2;
        ctx.translate(cx, cy);
        ctx.rotate((frame.transform.rotation * Math.PI) / 180);
        const hw = frame.transform.width / 2;
        const hh = frame.transform.height / 2;
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
        if (frame.imageSettings.imageUrl) {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.src = resolveStorageUrl(frame.imageSettings.imageUrl)!;
          await new Promise((r) => { img.onload = r; img.onerror = r; });
          ctx.globalAlpha = frame.imageSettings.imageOpacity ?? 1;
          const blendMode = frame.imageSettings.blendMode === "normal" ? "source-over" : frame.imageSettings.blendMode;
          ctx.globalCompositeOperation = blendMode as GlobalCompositeOperation;
          drawImageWithObjectFit(ctx, img, frame.transform.width, frame.transform.height, frame.imageSettings.objectFit ?? "cover");
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
        }
        ctx.restore();
      }
    }
  } finally {
    studioEsm.dispose();
    legacyEsm?.dispose();
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Failed to create blob")), "image/png");
  });
}

/**
 * Draws an image onto a 2D canvas context respecting object-fit behaviour,
 * matching the CSS preview in StaticFrame.
/**
 * Create a CanvasGradient from an ImageGradient within a rect centred on (0,0).
 */
export function createCanvasGradient(ctx: CanvasRenderingContext2D, g: ImageGradient, w: number, h: number): CanvasGradient {
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
export function drawImageWithObjectFit(ctx: CanvasRenderingContext2D, img: HTMLImageElement, destW: number, destH: number, fit: string = "cover"): void {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const x = -destW / 2;
  const y = -destH / 2;

  if (fit === "cover") {
    const scale = Math.max(destW / iw, destH / ih);
    const sw = destW / scale;
    const sh = destH / scale;
    const sx = (iw - sw) / 2;
    const sy = (ih - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, x, y, destW, destH);
  } else if (fit === "contain") {
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
  productType: "smooth" | "leather";
  onClose: () => void;
  open: boolean;
}

export function ImageExtractor({ sceneManager, productName, productType, onClose, open }: ImageExtractorProps) {
  // Frames state with full undo/redo support
  const {
    value: frames,
    set: setFrames, // discrete ops  → creates a history entry immediately
    setLive: setFramesLive, // continuous ops → no history; call commitFrames when done
    commit: commitFrames, // flush a live interaction to a single history entry
    reset: resetFrames, // load new state & wipe history (reference load / new layout)
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
  // Snapshot of selected reference metadata — survives FrameControlsPanel unmount during loading.
  const [selectedRefMeta, setSelectedRefMeta] = useState<{ id: string; name: string; isOwned: boolean } | null>(null);
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
  const [saveMode, setSaveMode] = useState<"new" | "update" | "choose">("new");
  const [error, setError] = useState<string | null>(null);
  const [hiddenFrameIds, setHiddenFrameIds] = useState<Set<string>>(new Set());
  const [previewMode, setPreviewMode] = useState(false);

  // Canvas ratio state
  const [canvasWidth, setCanvasWidth] = useState(DEFAULT_CANVAS_WIDTH);
  const [canvasHeight, setCanvasHeight] = useState(DEFAULT_CANVAS_HEIGHT);
  const [imageRatios, setImageRatios] = useState<ImageRatio[]>([]);
  const [showAddRatioPopover, setShowAddRatioPopover] = useState(false);
  const [newRatioWidth, setNewRatioWidth] = useState("");
  const [newRatioHeight, setNewRatioHeight] = useState("");
  const [isAddingRatio, setIsAddingRatio] = useState(false);

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

    // Load canvas ratio presets
    fetch("/api/image-ratios")
      .then((r) => r.json())
      .then(({ ratios }) => { if (Array.isArray(ratios)) setImageRatios(ratios); })
      .catch(() => {/* keep existing ratios */});
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
      const studioEsm = new ExtractorSceneManager(2048, 2048);
      const screenshots: Record<string, string> = {};
      try {
        for (const frame of cueFrames) {
          const shadow = frame.cue.studioShadow;
          // Dynamically re-render shadow frames using the current cue model
          if (shadow?.enabled && shadow.studioConfigSnapshot) {
            const model = sceneManager?.getModelForClone() ?? null;
            screenshots[frame.id] = await renderCueFrameViaStudio(
              model,
              shadow.studioConfigSnapshot,
              Math.round(frame.transform.width),
              Math.round(frame.transform.height),
              studioEsm,
              shadow.wallsTransparent,
            );
            continue;
          }
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
          screenshots[frame.id] = extractor.captureFrame("png");
        }
      } finally {
        studioEsm.dispose();
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
        // Restore canvas ratio saved with the reference
        if (data.canvasWidth && data.canvasHeight) {
          setCanvasWidth(data.canvasWidth);
          setCanvasHeight(data.canvasHeight);
        }

        // Render all cue frames immediately so every frame shows real content
        const extractor = extractorRef.current;
        if (extractor && extractorReady) {
          extractor.stopLivePreview();
          const studioEsm = new ExtractorSceneManager(2048, 2048);
          const screenshots: Record<string, string> = {};
          try {
            for (const frame of data.frames) {
              if (!isCueFrame(frame)) continue;
              const shadow = frame.cue.studioShadow;
              // Dynamically re-render shadow frames using the current cue model
              if (shadow?.enabled && shadow.studioConfigSnapshot) {
                const model = sceneManager?.getModelForClone() ?? null;
                screenshots[frame.id] = await renderCueFrameViaStudio(
                  model,
                  shadow.studioConfigSnapshot,
                  Math.round(frame.transform.width),
                  Math.round(frame.transform.height),
                  studioEsm,
                  shadow.wallsTransparent,
                );
                continue;
              }
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
              screenshots[frame.id] = extractor.captureFrame("png");
            }
          } finally {
            studioEsm.dispose();
          }
          setFrameScreenshots(screenshots);
          extractor.startLivePreview();
        }
      }
    } catch (err) {
      setError("Không thể tải tham chiếu");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectReference = (id: string | null, meta: { id: string; name: string; isOwned: boolean } | null) => {
    setSelectedRefMeta(meta);
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

  // Release memory for screenshots that belong to deleted frames.
  useEffect(() => {
    const frameIds = new Set(frames.map((frame) => frame.id));
    setFrameScreenshots((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [id, dataUrl] of Object.entries(prev)) {
        if (frameIds.has(id)) {
          next[id] = dataUrl;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [frames]);

  const handleAddFrame = () => {
    const newFrame = createDefaultFrame(undefined, frames.length, canvasWidth, canvasHeight);
    // Offset subsequent frames slightly so they don't all stack on top of each other
    const offset = Math.min(frames.length * Math.round(Math.min(canvasWidth, canvasHeight) * 0.025), Math.min(canvasWidth, canvasHeight) * 0.3);
    newFrame.transform.x = Math.round(newFrame.transform.x - newFrame.transform.width / 2 * 0.15 + offset);
    newFrame.transform.y = Math.round(newFrame.transform.y - newFrame.transform.height / 2 * 0.15 + offset);
    setFrames([...frames, newFrame]); // discrete — undoable
    setSelectedFrameId(newFrame.id);
  };

  const handleAddImageFrame = () => {
    const newFrame = createDefaultImageFrame(undefined, frames.length, canvasWidth, canvasHeight);
    const offset = Math.min(frames.length * Math.round(Math.min(canvasWidth, canvasHeight) * 0.025), Math.min(canvasWidth, canvasHeight) * 0.3);
    newFrame.transform.x = Math.round(newFrame.transform.x - newFrame.transform.width / 2 * 0.15 + offset);
    newFrame.transform.y = Math.round(newFrame.transform.y - newFrame.transform.height / 2 * 0.15 + offset);
    setFrames([...frames, newFrame]); // discrete — undoable
    setSelectedFrameId(newFrame.id);
  };

  // Called on every mousemove/slider tick — live update, no immediate history entry.
  // debouncedCommit collapses rapid panel changes into one undo step after 400 ms idle.
  const handleFrameChange = useCallback(
    (updatedFrame: ExtractorFrame) => {
      setFramesLive((prev) => prev.map((f) => (f.id === updatedFrame.id ? updatedFrame : f)));
      debouncedCommit();
    },
    [setFramesLive, debouncedCommit]
  );

  const handleDeleteFrame = (id: string) => {
    setFrames((prev) => prev.filter((f) => f.id !== id)); // discrete — undoable
    setFrameScreenshots((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
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
    setFrames((prev) => prev.map((f) => (f.id === id ? { ...f, name: name || undefined } : f)));
  };

  const handleSave = async (mode: "new" | "update") => {
    if (mode === "new" && !saveName.trim()) return;
    if (mode === "update" && !selectedReferenceId) return;
    if (frames.length === 0) return;

    setIsSaving(true);
    try {
      // Upload any locally-loaded images (data URLs) before persisting
      const readyFrames = await Promise.all(
        frames.map(async (frame) => {
          if (isImageFrame(frame) && frame.imageSettings.imageUrl?.startsWith("data:")) {
            try {
              const blob = await fetch(frame.imageSettings.imageUrl).then((r) => r.blob());
              const fd = new FormData();
              fd.append("file", blob, "overlay.png");
              const res = await fetch("/api/upload-overlay", { method: "POST", body: fd });
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

      // Render current canvas state at the chosen resolution then downscale to 496px for thumbnail
      let thumbBlob: Blob | null = null;
      try {
        const refData: ExtractorReference = { id: "", name: "", frames: readyFrames };
        const fullBlob = await handleRenderReference(refData);
        const fullImg = new Image();
        fullImg.src = URL.createObjectURL(fullBlob);
        await new Promise((r) => {
          fullImg.onload = r;
        });
        const aspect = canvasWidth / canvasHeight;
        const thumbW = aspect >= 1 ? 496 : Math.round(496 * aspect);
        const thumbH = aspect <= 1 ? 496 : Math.round(496 / aspect);
        const tc = document.createElement("canvas");
        tc.width = thumbW;
        tc.height = thumbH;
        tc.getContext("2d")!.drawImage(fullImg, 0, 0, thumbW, thumbH);
        URL.revokeObjectURL(fullImg.src);
        thumbBlob = await new Promise<Blob>((resolve, reject) => {
          tc.toBlob((b) => (b ? resolve(b) : reject(new Error("Thumb blob failed"))), "image/png");
        });
      } catch (err) {
        console.error("Thumbnail capture failed:", err);
      }

      let savedRefId: string;

      if (mode === "update" && selectedReferenceId) {
        const currentRef = references.find((r) => r.id === selectedReferenceId);
        const res = await fetch(`/api/extractor-references/${selectedReferenceId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: currentRef?.name || saveName.trim(), frames: readyFrames, canvasWidth, canvasHeight }),
        });

        if (!res.ok) throw new Error("Update failed");
        setFrames(readyFrames);
        savedRefId = selectedReferenceId;
      } else {
        const res = await fetch("/api/extractor-references", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: saveName.trim(), frames: readyFrames, canvasWidth, canvasHeight }),
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
          fd.append("file", thumbBlob, "thumbnail.png");
          await fetch(`/api/extractor-references/${savedRefId}/thumbnail`, { method: "POST", body: fd });
        } catch (err) {
          console.error("Thumbnail upload failed:", err);
        }
      }

      setShowSaveDialog(false);
      setSaveName("");
      setSaveMode("new");
      invalidateReferenceListCache();
      loadReferences();
    } catch (err) {
      setError(mode === "update" ? "Không thể cập nhật tham chiếu" : "Không thể lưu tham chiếu");
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const openSaveDialog = () => {
    // If using a loaded reference, ask whether to update or create new
    if (selectedReferenceId) {
      setSaveMode("choose");
    } else {
      setSaveMode("new");
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
        invalidateReferenceListCache();
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
          setSelectedRefMeta(null);
          resetFrames([]); // load → clear history
          setFrameScreenshots({});
        }
        invalidateReferenceListCache();
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
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const ctx = canvas.getContext("2d")!;

      // Clear with transparency
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);

      // Get model from main scene
      const model = sceneManager.getModelForClone();

      // Create ONE extractor for export (full resolution)
      const exportExtractor = new ExtractorSceneManager(canvasWidth, canvasHeight);
      if (model) exportExtractor.setModel(model);

      // Load a default HDRI first (will be overridden per frame)
      const defaultHdriUrl = `/hdri/${encodeURIComponent("bloem_train_track_clear_2k.hdr")}`;
      await exportExtractor.loadHDRI(defaultHdriUrl);
      exportExtractor.setTransparentBackground(true);

      // Create a reusable studio ESM for renderCueFrameViaStudio (avoids new WebGL context per frame)
      const studioEsm = new ExtractorSceneManager(2048, 2048);

      // Render all frames in order (cue frames via 3D extractor, image frames drawn directly)
      for (const frame of frames) {
        if (isCueFrame(frame)) {
          const shadow = frame.cue.studioShadow ?? DEFAULT_CUE_SHADOW;
          let frameDataUrl: string;

          // Use studio pipeline when a snapshot config exists (matches simulator preview)
          if (shadow.studioConfigSnapshot) {
            const model = sceneManager.getModelForClone();
            frameDataUrl = await renderCueFrameViaStudio(
              model,
              shadow.studioConfigSnapshot,
              Math.round(frame.transform.width),
              Math.round(frame.transform.height),
              studioEsm,
              shadow.wallsTransparent,
            );
          } else {
            // Legacy export path — no studio snapshot
            exportExtractor.resize(Math.round(frame.transform.width), Math.round(frame.transform.height));
            exportExtractor.setModelRotation(frame.cue.spinY);
            exportExtractor.setCameraPhi(frame.cue.phi, 2);
            exportExtractor.setCameraZoom(frame.cue.zoom);
            exportExtractor.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);

            if (frame.cue.hdriLayers && frame.cue.hdriLayers.length > 0) {
              await exportExtractor.setHdriLayers(frame.cue.hdriLayers, { applyCueEnv: true });
              await exportExtractor.setCueHdri(hdriLayersToCueHdri(frame.cue.hdriLayers));
            } else if (frame.cue.lightAngle !== undefined) {
              exportExtractor.setHdriRotation(frame.cue.lightAngle);
            }

            exportExtractor.setFrameShadow(shadow);
            exportExtractor.setFrameShadowQuality(4096);
            exportExtractor.render();
            frameDataUrl = exportExtractor.captureFrame("png");
          }

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
            img.crossOrigin = "anonymous";
            img.src = resolveStorageUrl(frame.imageSettings.imageUrl)!;
            await new Promise((r) => {
              img.onload = r;
              img.onerror = r;
            });
            ctx.globalAlpha = frame.imageSettings.imageOpacity ?? 1;
            const blendMode = frame.imageSettings.blendMode === "normal" ? "source-over" : frame.imageSettings.blendMode;
            ctx.globalCompositeOperation = blendMode as GlobalCompositeOperation;
            drawImageWithObjectFit(ctx, img, frame.transform.width, frame.transform.height, frame.imageSettings.objectFit ?? "cover");
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
          }

          ctx.restore();
        }
      }

      // Dispose export extractors before restarting live preview
      studioEsm.dispose();
      exportExtractor.dispose();

      // Download
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      const refName = references.find((r) => r.id === selectedReferenceId)?.name;
      const nameParts = [productName.replace(/\s+/g, "-"), "cue-extract"];
      if (refName) nameParts.push(refName.replace(/\s+/g, "-"));
      link.download = `${nameParts.join("-")}.png`;
      link.click();
    } catch (err) {
      setError("Xuất thất bại");
      console.error(err);
    } finally {
      setIsExporting(false);
      // Restart live preview now that export extractor is gone
      extractorRef.current?.startLivePreview();
    }
  };

  // Render a reference to a PNG blob (for batch export)
  const handleRenderReference = useCallback(
    async (reference: ExtractorReference): Promise<Blob> => {
      if (!sceneManager) {
        throw new Error("Scene manager not available");
      }

      // Use the canvas dimensions saved with the reference, not the current editor state.
      const refCanvasWidth  = reference.canvasWidth  ?? DEFAULT_CANVAS_WIDTH;
      const refCanvasHeight = reference.canvasHeight ?? DEFAULT_CANVAS_HEIGHT;

      // Create composite canvas
      const canvas = document.createElement("canvas");
      canvas.width = refCanvasWidth;
      canvas.height = refCanvasHeight;
      const ctx = canvas.getContext("2d")!;

      // Clear with transparency
      ctx.clearRect(0, 0, refCanvasWidth, refCanvasHeight);

      // Reuse shared bulk extractor if one was prepared (avoids re-creating WebGL context per render)
      const ownExtractor = !bulkExportExtractorRef.current;
      let exportExtractor: ExtractorSceneManager;

      if (bulkExportExtractorRef.current) {
        exportExtractor = bulkExportExtractorRef.current;
        // Resize to this reference's canvas dimensions (each reference may differ)
        exportExtractor.resize(refCanvasWidth, refCanvasHeight);
      } else {
        // Single render path — stop live preview so export has the GPU to itself
        extractorRef.current?.stopLivePreview();
        const model = sceneManager.getModelForClone();
        exportExtractor = new ExtractorSceneManager(refCanvasWidth, refCanvasHeight);
        if (model) exportExtractor.setModel(model);
        const defaultHdriUrl = `/hdri/${encodeURIComponent("bloem_train_track_clear_2k.hdr")}`;
        await exportExtractor.loadHDRI(defaultHdriUrl);
        exportExtractor.setTransparentBackground(true);
      }

      // Render all frames in order (cue frames via 3D extractor, image frames drawn directly)
      // Create a reusable studio ESM for renderCueFrameViaStudio (avoids new WebGL context per frame)
      const studioEsm = new ExtractorSceneManager(2048, 2048);
      try {
        for (const frame of reference.frames) {
          if (isCueFrame(frame)) {
            const shadow = frame.cue.studioShadow ?? DEFAULT_CUE_SHADOW;
            let frameDataUrl: string;

            // Use studio pipeline when a snapshot config exists (matches simulator preview)
            if (shadow.studioConfigSnapshot) {
              const model = sceneManager.getModelForClone();
              frameDataUrl = await renderCueFrameViaStudio(
                model,
                shadow.studioConfigSnapshot,
                Math.round(frame.transform.width),
                Math.round(frame.transform.height),
                studioEsm,
                shadow.wallsTransparent,
              );
            } else {
              // Legacy export path
              exportExtractor.resize(Math.round(frame.transform.width), Math.round(frame.transform.height));
              exportExtractor.setModelRotation(frame.cue.spinY);
              exportExtractor.setCameraPhi(frame.cue.phi, 2);
              exportExtractor.setCameraZoom(frame.cue.zoom);
              exportExtractor.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);

              if (frame.cue.hdriLayers && frame.cue.hdriLayers.length > 0) {
                await exportExtractor.setHdriLayers(frame.cue.hdriLayers, { applyCueEnv: true });
                await exportExtractor.setCueHdri(hdriLayersToCueHdri(frame.cue.hdriLayers));
              } else if (frame.cue.lightAngle !== undefined) {
                exportExtractor.setHdriRotation(frame.cue.lightAngle);
              }

              exportExtractor.setFrameShadow(shadow);
              exportExtractor.setFrameShadowQuality(4096);
              exportExtractor.render();
              frameDataUrl = exportExtractor.captureFrame("png");
            }

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
              img.crossOrigin = "anonymous";
              img.src = resolveStorageUrl(frame.imageSettings.imageUrl)!;
              await new Promise((r) => {
                img.onload = r;
                img.onerror = r;
              });
              ctx.globalAlpha = frame.imageSettings.imageOpacity ?? 1;
              const blendMode = frame.imageSettings.blendMode === "normal" ? "source-over" : frame.imageSettings.blendMode;
              ctx.globalCompositeOperation = blendMode as GlobalCompositeOperation;
              drawImageWithObjectFit(ctx, img, frame.transform.width, frame.transform.height, frame.imageSettings.objectFit ?? "cover");
              ctx.globalAlpha = 1;
              ctx.globalCompositeOperation = "source-over";
            }

            ctx.restore();
          }
        }
      } finally {
        studioEsm.dispose();
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
    },
    [sceneManager]
  );

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
    // Initial size is arbitrary — handleRenderReference resizes per-reference before each render.
    const ext = new ExtractorSceneManager(DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT);
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

  const handleSelectRatio = useCallback((ratioId: string) => {
    const ratio = imageRatios.find((r) => r.id === ratioId);
    if (!ratio) return;
    setCanvasWidth(ratio.width);
    setCanvasHeight(ratio.height);
  }, [imageRatios]);

  const handleAddCustomRatio = useCallback(async () => {
    const w = parseInt(newRatioWidth, 10);
    const h = parseInt(newRatioHeight, 10);
    if (!w || !h || w < 1024 || h < 1024) return;
    setIsAddingRatio(true);
    try {
      const res = await fetch("/api/image-ratios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width: w, height: h }),
      });
      if (res.ok) {
        const { ratio } = await res.json();
        setImageRatios((prev) => [...prev, ratio]);
        setCanvasWidth(ratio.width);
        setCanvasHeight(ratio.height);
        setNewRatioWidth("");
        setNewRatioHeight("");
        setShowAddRatioPopover(false);
      }
    } catch (err) {
      console.error("Failed to add ratio:", err);
    } finally {
      setIsAddingRatio(false);
    }
  }, [newRatioWidth, newRatioHeight]);

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
        <DialogContent className="w-[99vw] h-[99vh] max-w-none max-h-none overflow-hidden flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2">
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5" />
                Trích Xuất Ảnh{" "}
              </DialogTitle>

              {/* Undo / Redo */}
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={undo} disabled={!canUndo} title="Hoàn tác (⌘Z)">
                  <Undo2 className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={redo} disabled={!canRedo} title="Làm lại (⇧⌘Z)">
                  <Redo2 className="h-4 w-4" />
                </Button>
              </div>

              {/* Canvas Ratio Selector */}
              <div className="flex items-center gap-1">
                <Select
                  value={imageRatios.find((r) => r.width === canvasWidth && r.height === canvasHeight)?.id ?? ""}
                  onValueChange={handleSelectRatio}
                >
                  <SelectTrigger className="h-8 w-44 text-xs">
                    <SelectValue placeholder={`${canvasWidth} × ${canvasHeight}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {imageRatios.map((r) => (
                      <SelectItem key={r.id} value={r.id} className="text-xs">
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Popover open={showAddRatioPopover} onOpenChange={setShowAddRatioPopover}>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Thêm tỉ lệ tuỳ chỉnh">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-52 p-3 space-y-3">
                    <p className="text-xs font-medium">Tỉ lệ tuỳ chỉnh (px)</p>
                    <p className="text-[10px] text-muted-foreground">Tối thiểu 1024px mỗi chiều</p>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <Label className="text-[10px] text-muted-foreground">Rộng</Label>
                        <Input
                          type="number"
                          min={1024}
                          max={8192}
                          className="h-7 text-xs mt-1"
                          placeholder="2048"
                          value={newRatioWidth}
                          onChange={(e) => setNewRatioWidth(e.target.value)}
                        />
                      </div>
                      <div className="flex-1">
                        <Label className="text-[10px] text-muted-foreground">Cao</Label>
                        <Input
                          type="number"
                          min={1024}
                          max={8192}
                          className="h-7 text-xs mt-1"
                          placeholder="2048"
                          value={newRatioHeight}
                          onChange={(e) => setNewRatioHeight(e.target.value)}
                        />
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="w-full h-7 text-xs"
                      disabled={!newRatioWidth || !newRatioHeight || isAddingRatio}
                      onClick={handleAddCustomRatio}
                    >
                      {isAddingRatio ? <Loader2 className="h-3 w-3 animate-spin" /> : "Thêm & Áp dụng"}
                    </Button>
                  </PopoverContent>
                </Popover>
              </div>

              {/* How to use dropdown */}
              <div className="relative mr-4">
                <Button variant="ghost" size="sm" onClick={() => setShowHelp(!showHelp)} className="text-muted-foreground hover:text-foreground">
                  <HelpCircle className="h-4 w-4 mr-1" />
                  Hướng dẫn
                  <ChevronDown className={`h-3 w-3 ml-1 transition-transform ${showHelp ? "rotate-180" : ""}`} />
                </Button>

                {showHelp && (
                  <div className="absolute right-0 top-full mt-2 w-[420px] bg-popover border rounded-lg shadow-lg p-4 z-50">
                    {/* Overview */}
                    <p className="text-sm text-muted-foreground mb-4">Tạo bố cục khung tùy chỉnh và lưu làm mẫu, hoặc tải từ tham chiếu đã lưu.</p>

                    {/* Frame Control Diagram */}
                    <div className="text-xs font-medium mb-2">Điều khiển Khung</div>
                    <div className="relative bg-muted/50 rounded-lg p-3 mb-3">
                      {/* Frame diagram */}
                      <div className="relative w-full aspect-square max-w-[200px] mx-auto">
                        {/* Outer frame border - Move area */}
                        <div className="absolute inset-0 border-2 border-blue-500 rounded-lg">
                          {/* Inner 3D control area */}
                          <div className="absolute inset-3 border-2 border-dashed border-green-500 rounded flex items-center justify-center">
                            <span className="text-[10px] text-green-500">Điều khiển 3D</span>
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
                          <span>Viền: Di chuyển khung</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-3 border-2 border-dashed border-green-500 rounded" />
                          <span>Trung tâm: Điều khiển 3D</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-3 bg-purple-500 rounded-full" />
                          <span>Vòng tròn: Xoay</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-3 bg-orange-500 rounded-sm" />
                          <span>Hình vuông: Thay đổi kích thước</span>
                        </div>
                      </div>
                    </div>

                    {/* Axis constraint tip */}
                    <div className="bg-muted/50 rounded-lg p-3">
                      <div className="text-xs font-medium mb-2">Di chuyển theo Trục</div>
                      <div className="flex gap-4 text-[11px] text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px] font-mono">X</kbd>
                          <span>+ kéo</span>
                          <div className="w-4 h-[2px] bg-red-500 rounded" />
                          <span>ngang</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <kbd className="px-1.5 py-0.5 bg-background border rounded text-[10px] font-mono">Y</kbd>
                          <span>+ kéo</span>
                          <div className="w-[2px] h-4 bg-green-500 rounded" />
                          <span>dọc</span>
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground/70 mt-2">Theo trục riêng của khung (hoạt động với khung đã xoay)</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <DialogDescription className="sr-only">Tạo và xuất bố cục khung tùy chỉnh</DialogDescription>
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
                  canvasWidth={canvasWidth}
                  canvasHeight={canvasHeight}
                />

                {/* Controls Panel */}
                <FrameControlsPanel
                  references={references}
                  selectedReferenceId={selectedReferenceId}
                  selectedRefMeta={selectedRefMeta}
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
                  extractorRef={extractorRef}
                  onScreenshotCapture={handleScreenshotCapture}
                  productType={productType}
                  canvasWidth={canvasWidth}
                  canvasHeight={canvasHeight}
                />
              </div>
            </div>
          )}

          {error && <div className="px-6 py-2 text-sm text-destructive">{error}</div>}

          <DialogFooter className="px-6 py-4 border-t flex justify-between">
            <Button variant={previewMode ? "default" : "outline"} onClick={() => setPreviewMode((v) => !v)} disabled={frames.length === 0}>
              {previewMode ? (
                <>
                  <EyeOff className="h-4 w-4 mr-2" />
                  Thoát Xem trước
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4 mr-2" />
                  Xem trước
                </>
              )}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={openSaveDialog} disabled={frames.length === 0}>
                <Save className="h-4 w-4 mr-2" />
                Lưu Tham chiếu
              </Button>
              <Button variant="outline" onClick={() => setShowDownloadMultipleDialog(true)}>
                <FolderDown className="h-4 w-4 mr-2" />
                Tải xuống nhiều
              </Button>
              <Button onClick={handleExport} disabled={isExporting || frames.length === 0 || !sceneManager}>
                {isExporting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Đang xuất...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2" />
                    Tải xuống PNG
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
      <Dialog
        open={showSaveDialog}
        onOpenChange={(open) => {
          setShowSaveDialog(open);
          if (!open) {
            setSaveMode("new");
            setSaveName("");
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{saveMode === "choose" ? "Lưu Tham chiếu" : saveMode === "update" ? "Cập nhật Tham chiếu" : "Lưu dưới dạng Tham chiếu mới"}</DialogTitle>
            <DialogDescription>
              {saveMode === "choose"
                ? "Cập nhật tham chiếu hiện có hoặc lưu dưới dạng mới?"
                : saveMode === "update"
                ? `Cập nhật "${references.find((r) => r.id === selectedReferenceId)?.name}" với bố cục hiện tại`
                : "Đặt tên cho bố cục của bạn để sử dụng lại sau"}
            </DialogDescription>
          </DialogHeader>

          {saveMode === "choose" ? (
            // Choice mode - update or new
            <div className="py-4 space-y-3">
              <Button
                variant="outline"
                className="w-full justify-start h-auto py-3"
                onClick={() => {
                  handleSave("update");
                }}
                disabled={isSaving}
              >
                <div className="text-left">
                  <div className="font-medium">Cập nhật hiện có</div>
                  <div className="text-xs text-muted-foreground">Lưu thay đổi vào &quot;{references.find((r) => r.id === selectedReferenceId)?.name}&quot;</div>
                </div>
              </Button>
              <Button variant="outline" className="w-full justify-start h-auto py-3" onClick={() => setSaveMode("new")}>
                <div className="text-left">
                  <div className="font-medium">Lưu dưới dạng mới</div>
                  <div className="text-xs text-muted-foreground">Tạo tham chiếu mới với tên khác</div>
                </div>
              </Button>
            </div>
          ) : (
            // New reference mode - show name input
            <div className="py-4">
              <Label htmlFor="ref-name">Tên tham chiếu</Label>
              <Input id="ref-name" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="vd: 3 Phần Chéo" className="mt-2" autoFocus />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveDialog(false)}>
              Hủy
            </Button>
            {saveMode !== "choose" && (
              <Button onClick={() => handleSave("new")} disabled={!saveName.trim() || isSaving}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Lưu"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
