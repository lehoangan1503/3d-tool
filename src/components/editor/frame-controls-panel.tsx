"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Plus,
  Trash2,
  AlignCenter,
  Sun,
  Move,
  Maximize2,
  RotateCw,
  ZoomIn,
  Crosshair,
  ArrowLeft,
  Lightbulb,
  X,
  Check,
  ImagePlus,
  Pencil,
  ChevronDown,
  Search,
  Loader2,
} from "lucide-react";
import type { ExtractorFrame, ExtractorReference, HdriLayer, CueFrame, CueSettings, ImageFrame } from "@/types/extractor";
import { createDefaultHdriLayer, isCueFrame, isImageFrame, STUDIO_WHITE_HDRI } from "@/types/extractor";
import { cn } from "@/lib/utils";
import { ImageFrameControls } from "./image-frame-controls";
import { FramesList } from "./frames-list";
import { useReferenceList } from "@/hooks/use-reference-list";
import { renderPool } from "@/lib/render-pool";

interface HdriOption {
  id: string;
  label: string;
}

const PREVIEW_CANVAS = 2048;

function LayoutPreviewSvg({ frames, size }: { frames: ExtractorFrame[]; size: number }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${PREVIEW_CANVAS} ${PREVIEW_CANVAS}`} style={{ background: "#111827" }} className="rounded block flex-shrink-0">
      {frames.map((frame, i) => {
        const cx = frame.transform.x + frame.transform.width / 2;
        const cy = frame.transform.y + frame.transform.height / 2;
        const fill = isImageFrame(frame) ? "#f87171" : `hsl(${(i * 137) % 360}, 65%, 60%)`;
        return (
          <rect
            key={frame.id}
            x={frame.transform.x}
            y={frame.transform.y}
            width={frame.transform.width}
            height={frame.transform.height}
            fill={fill}
            opacity={0.85}
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={22}
            rx={36}
            transform={frame.transform.rotation ? `rotate(${frame.transform.rotation},${cx},${cy})` : undefined}
          />
        );
      })}
    </svg>
  );
}

interface FrameControlsPanelProps {
  // Reference management
  references: ExtractorReference[];
  selectedReferenceId: string | null;
  onSelectReference: (id: string | null) => void;

  // Frame management
  frames: ExtractorFrame[];
  selectedFrame: ExtractorFrame | null;
  onFrameChange: (frame: ExtractorFrame) => void;
  onDeleteFrame: (id: string) => void;
  onAddFrame: () => void;
  onAddImageFrame: () => void;
  onDeselectFrame: () => void;

  // Frames list (inline panel)
  selectedFrameId: string | null;
  hiddenFrameIds: Set<string>;
  onSelectFrame: (id: string) => void;
  onReorderFrames: (frames: ExtractorFrame[]) => void;
  onToggleVisibility: (id: string) => void;

  // Layout controls
  onAlignFrames: () => void;
  gap: number;
  onGapChange: (gap: number) => void;

  // HDRI controls
  hdriOptions: HdriOption[];

  // Reference rename / delete
  onRenameReference?: (id: string, newName: string) => Promise<void>;
  onDeleteReference?: (id: string) => Promise<void>;

  // Frame rename
  onRenameFrame?: (id: string, name: string) => void;

  // Render callback for thumbnails
  onRenderReference?: (reference: ExtractorReference) => Promise<Blob>;
}

// Persistent frames list pinned at the bottom of the panel
function FramesListSection({
  frames,
  selectedFrameId,
  hiddenFrameIds,
  onSelectFrame,
  onReorderFrames,
  onToggleVisibility,
  onDeleteFrame,
  onRenameFrame,
}: {
  frames: ExtractorFrame[];
  selectedFrameId: string | null;
  hiddenFrameIds: Set<string>;
  onSelectFrame: (id: string) => void;
  onReorderFrames: (frames: ExtractorFrame[]) => void;
  onToggleVisibility: (id: string) => void;
  onDeleteFrame: (id: string) => void;
  onRenameFrame?: (id: string, name: string) => void;
}) {
  return (
    <div className="shrink-0 border-t bg-muted/20">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          {frames.length} frame{frames.length !== 1 ? "s" : ""} in canvas
        </Label>
        <span className="text-[10px] text-muted-foreground/50">drag to reorder</span>
      </div>
      <div className="overflow-y-auto max-h-[168px] px-2 pb-2">
        <FramesList
          frames={frames}
          selectedFrameId={selectedFrameId}
          hiddenFrameIds={hiddenFrameIds}
          onSelectFrame={onSelectFrame}
          onReorderFrames={onReorderFrames}
          onToggleVisibility={onToggleVisibility}
          onDeleteFrame={onDeleteFrame}
          onRenameFrame={onRenameFrame}
        />
      </div>
    </div>
  );
}

export function FrameControlsPanel({
  references,
  selectedReferenceId,
  onSelectReference,
  frames,
  selectedFrame,
  onFrameChange,
  onDeleteFrame,
  onAddFrame,
  onAddImageFrame,
  onDeselectFrame,
  selectedFrameId,
  hiddenFrameIds,
  onSelectFrame,
  onReorderFrames,
  onToggleVisibility,
  onAlignFrames,
  gap,
  onGapChange,
  hdriOptions,
  onRenameReference,
  onDeleteReference,
  onRenameFrame,
  onRenderReference,
}: FrameControlsPanelProps) {
  // Track which HDRI layer is being edited (by layer id)
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [addHdriOpen, setAddHdriOpen] = useState(false);

  // Reference rename / delete state
  const [isRenamingRef, setIsRenamingRef] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteRef, setConfirmDeleteRef] = useState(false);

  // Reference popover state
  const [refPopoverOpen, setRefPopoverOpen] = useState(false);
  const refThumbnailUrls = useRef<Map<string, string>>(new Map());
  const [refThumbVersion, setRefThumbVersion] = useState(0);
  // Prevent concurrent renderPool calls — only 1 WebGL render at a time
  const renderPoolRunning = useRef(false);

  const {
    references: popoverRefs,
    isLoading: popoverLoading,
    isFetchingMore: popoverFetchingMore,
    hasMore: popoverHasMore,
    search: popoverSearch,
    setSearch: setPopoverSearch,
    loadMore: popoverLoadMore,
  } = useReferenceList({ enabled: refPopoverOpen });

  // Render thumbnails for newly-arrived refs — serial (concurrency=1) to protect GPU
  // DISABLED: 3D thumbnail rendering costs too much memory; use LayoutPreviewSvg instead
  // useEffect(() => {
  //   if (!onRenderReference || popoverRefs.length === 0) return;
  //   if (renderPoolRunning.current) return; // a pool is already running; it will re-check on finish
  //   const unrendered = popoverRefs.filter((r) => !refThumbnailUrls.current.has(r.id));
  //   if (!unrendered.length) return;
  //
  //   renderPoolRunning.current = true;
  //   renderPool(
  //     unrendered,
  //     onRenderReference,
  //     (idx, url) => {
  //       refThumbnailUrls.current.set(unrendered[idx].id, url);
  //       setRefThumbVersion((v) => v + 1);
  //     },
  //     1
  //   ).finally(() => {
  //     renderPoolRunning.current = false;
  //     // Re-check: new refs may have arrived (scroll load-more) while pool was running
  //     const stillUnrendered = popoverRefs.filter((r) => !refThumbnailUrls.current.has(r.id));
  //     if (stillUnrendered.length && onRenderReference) {
  //       renderPoolRunning.current = true;
  //       renderPool(
  //         stillUnrendered,
  //         onRenderReference,
  //         (idx, url) => {
  //           refThumbnailUrls.current.set(stillUnrendered[idx].id, url);
  //           setRefThumbVersion((v) => v + 1);
  //         },
  //         1
  //       ).finally(() => {
  //         renderPoolRunning.current = false;
  //       });
  //     }
  //   });
  // }, [popoverRefs, onRenderReference]);

  // Revoke blob URLs only on component unmount — cache persists across open/close
  // so reopening the popover shows cached thumbnails instantly with zero GPU work
  useEffect(() => {
    return () => {
      refThumbnailUrls.current.forEach((u) => URL.revokeObjectURL(u));
      refThumbnailUrls.current.clear();
    };
  }, []);

  // refThumbVersion read to subscribe to updates
  void refThumbVersion;

  // Allow native scroll on the popover list — react-remove-scroll (used by Radix Dialog)
  // blocks wheel events at the document level (bubble phase). A native listener on the list
  // that calls stopPropagation() prevents the event from ever reaching document, so the
  // browser handles scrolling naturally with full momentum/inertia.
  // Callback ref fires synchronously when the element mounts (avoids useEffect timing issues
  // with Radix Portals).
  const popoverListRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const onWheel = (e: WheelEvent) => e.stopPropagation();
    node.addEventListener("wheel", onWheel, { passive: false });
  }, []);

  // Local state for slider drag (for smooth UI, only commit on release)
  const [localRotationX, setLocalRotationX] = useState<number | null>(null);
  const [localRotationY, setLocalRotationY] = useState<number | null>(null);

  const updateTransform = (key: keyof ExtractorFrame["transform"], value: number) => {
    if (!selectedFrame) return;
    onFrameChange({
      ...selectedFrame,
      transform: { ...selectedFrame.transform, [key]: value },
    });
  };

  const updateCue = (key: keyof CueSettings, value: number | string | HdriLayer[]) => {
    if (!selectedFrame || !isCueFrame(selectedFrame)) return;
    onFrameChange({
      ...selectedFrame,
      cue: { ...selectedFrame.cue, [key]: value },
    });
  };

  // Parse number from text input, handling empty/invalid values
  const parseNumber = (value: string, fallback: number = 0): number => {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? fallback : parsed;
  };

  // HDRI Layer management (only for CueFrame)
  const hdriLayers = selectedFrame && isCueFrame(selectedFrame) ? selectedFrame.cue.hdriLayers || [] : [];
  const canAddHdri = hdriLayers.length < 2;

  // Auto-select first layer for editing if none selected
  const effectiveEditingLayerId = editingLayerId && hdriLayers.find((l) => l.id === editingLayerId) ? editingLayerId : hdriLayers[0]?.id || null;

  const editingLayer = hdriLayers.find((l) => l.id === effectiveEditingLayerId);

  const addHdriLayer = (hdriType: string) => {
    if (!selectedFrame || hdriLayers.length >= 2) return;
    const newLayer = createDefaultHdriLayer(hdriType);
    updateCue("hdriLayers", [...hdriLayers, newLayer]);
    setEditingLayerId(newLayer.id);
    setAddHdriOpen(false);
  };

  const removeHdriLayer = (layerId: string) => {
    if (!selectedFrame || hdriLayers.length <= 1) return; // Keep at least 1
    const newLayers = hdriLayers.filter((l) => l.id !== layerId);
    updateCue("hdriLayers", newLayers);
    if (editingLayerId === layerId) {
      setEditingLayerId(newLayers[0]?.id || null);
    }
  };

  const updateHdriLayer = (layerId: string, updates: Partial<HdriLayer>) => {
    if (!selectedFrame) return;
    const newLayers = hdriLayers.map((l) => (l.id === layerId ? { ...l, ...updates } : l));
    updateCue("hdriLayers", newLayers);
  };

  const getHdriLabel = (hdriType: string) => {
    if (hdriType === STUDIO_WHITE_HDRI) return "Studio White";
    const option = hdriOptions.find((o) => o.id === hdriType);
    // Return short name (first 2 words)
    if (option) {
      const words = option.label.split(" ").slice(0, 2);
      return words.join(" ");
    }
    return hdriType.split("_").slice(0, 2).join(" ");
  };

  const submitRename = async () => {
    if (!selectedReferenceId || !renameValue.trim() || !onRenameReference) return;
    await onRenameReference(selectedReferenceId, renameValue.trim());
    setIsRenamingRef(false);
  };

  const submitDelete = async () => {
    if (!selectedReferenceId || !onDeleteReference) return;
    await onDeleteReference(selectedReferenceId);
    setConfirmDeleteRef(false);
  };

  const selectedRefName = selectedReferenceId ? references.find((r) => r.id === selectedReferenceId)?.name ?? "Unnamed" : null;

  // No frame selected - show reference/template controls
  if (!selectedFrame) {
    return (
      <div className="w-72 flex flex-col border-l bg-muted/30 overflow-hidden">
        {/* Scrollable main content */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {/* Reference Selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Load Reference</Label>
            <Popover open={refPopoverOpen} onOpenChange={setRefPopoverOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-between text-sm font-normal">
                  <span className="truncate">{selectedRefName ?? "New Layout"}</span>
                  <ChevronDown className="h-4 w-4 ml-2 flex-shrink-0" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-72 p-0 flex flex-col overflow-hidden"
                style={{ maxHeight: "min(380px, var(--radix-popover-content-available-height, 380px))" }}
                align="start"
              >
                <div className="flex flex-col gap-2 p-2 flex-1 min-h-0">
                  {/* Search */}
                  <div className="relative flex-shrink-0">
                    <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                    <Input value={popoverSearch} onChange={(e) => setPopoverSearch(e.target.value)} placeholder="Search..." className="pl-7 h-8 text-sm" />
                  </div>

                  {/* New Layout option */}
                  <button
                    className="flex-shrink-0 w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent"
                    onClick={() => {
                      setIsRenamingRef(false);
                      setConfirmDeleteRef(false);
                      onSelectReference(null);
                      setRefPopoverOpen(false);
                    }}
                  >
                    + New Layout
                  </button>

                  {/* Scrollable thumbnail list — flex-1 min-h-0 required for overflow to work in flex context */}
                  <div
                    ref={popoverListRef}
                    className="flex-1 min-h-0 overflow-y-auto space-y-1"
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 && popoverHasMore && !popoverFetchingMore) {
                        popoverLoadMore();
                      }
                    }}
                  >
                    {popoverLoading && popoverRefs.length === 0 ? (
                      <div className="flex justify-center py-4">
                        <Search className="h-4 w-4 animate-pulse text-muted-foreground" />
                      </div>
                    ) : popoverRefs.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">No references found</p>
                    ) : (
                      popoverRefs.map((ref) => {
                        const thumbUrl = refThumbnailUrls.current.get(ref.id);
                        return (
                          <button
                            key={ref.id}
                            className={`w-full flex items-center gap-2 p-1.5 rounded text-left hover:bg-accent ${selectedReferenceId === ref.id ? "bg-accent" : ""}`}
                            onClick={() => {
                              setIsRenamingRef(false);
                              setConfirmDeleteRef(false);
                              onSelectReference(ref.id);
                              setRefPopoverOpen(false);
                            }}
                          >
                            <div className="flex-shrink-0 w-12 h-12 rounded overflow-hidden bg-[#111827]">
                              <LayoutPreviewSvg frames={ref.frames} size={48} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{ref.name}</div>
                              <div className="text-xs text-muted-foreground">{ref.frames.length} frames</div>
                            </div>
                          </button>
                        );
                      })
                    )}

                    {/* Load-more spinner shown while fetching next page */}
                    {popoverFetchingMore && (
                      <div className="py-1 flex justify-center">
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* Selected reference name + rename / delete */}
            <div className="flex items-center gap-1 min-h-[28px] px-0.5">
              {isRenamingRef ? (
                <>
                  <Input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    className="h-7 flex-1 text-sm"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename();
                      if (e.key === "Escape") setIsRenamingRef(false);
                    }}
                  />
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-green-500 hover:text-green-400" onClick={submitRename} disabled={!renameValue.trim()}>
                    <Check className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsRenamingRef(false)}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </>
              ) : confirmDeleteRef ? (
                <>
                  <span className="flex-1 text-xs text-destructive">Delete this reference?</span>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={submitDelete}>
                    <Check className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setConfirmDeleteRef(false)}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm truncate text-muted-foreground">{selectedRefName ?? "New Layout"}</span>
                  {selectedReferenceId && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        title="Rename"
                        onClick={() => {
                          setRenameValue(selectedRefName ?? "");
                          setIsRenamingRef(true);
                        }}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" title="Delete" onClick={() => setConfirmDeleteRef(true)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Add Frame / Add Image */}
          <div className="flex flex-col gap-2">
            <Button onClick={onAddFrame} className="w-full">
              <Plus className="w-4 h-4 mr-2" />
              Add Frame
            </Button>
            <Button onClick={onAddImageFrame} variant="outline" className="w-full">
              <ImagePlus className="w-4 h-4 mr-2" />
              Add Image
            </Button>
          </div>

          {/* Layout Controls */}
          <div className="space-y-3 pt-4 border-t">
            <Label className="text-sm font-medium">Layout</Label>

            <Button variant="outline" size="sm" onClick={onAlignFrames} className="w-full">
              <AlignCenter className="w-4 h-4 mr-2" />
              Auto Align
            </Button>

            <div>
              <Label className="text-xs text-muted-foreground">Gap (px)</Label>
              <Input type="text" inputMode="numeric" value={gap} onChange={(e) => onGapChange(parseNumber(e.target.value, 0))} className="h-8 mt-1" />
              <p className="text-[10px] text-muted-foreground/70 mt-1">Change value and click Auto Align</p>
            </div>
          </div>

          {/* Frames in canvas — inside scrollable area but we'll move it to persistent footer */}
        </div>

        {/* Persistent frames list at bottom */}
        <FramesListSection
          frames={frames}
          selectedFrameId={selectedFrameId}
          hiddenFrameIds={hiddenFrameIds}
          onSelectFrame={onSelectFrame}
          onReorderFrames={onReorderFrames}
          onToggleVisibility={onToggleVisibility}
          onDeleteFrame={onDeleteFrame}
          onRenameFrame={onRenameFrame}
        />
      </div>
    );
  }

  // Frame selected - show frame controls
  return (
    <div className="w-72 flex flex-col border-l bg-muted/30 overflow-hidden">
      {/* Scrollable frame controls */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {/* Frame Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={onDeselectFrame} className="h-8 w-8">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h3 className="font-medium text-sm">
              {selectedFrame.name || `Frame ${selectedFrame.order + 1}`}
            </h3>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onDeleteFrame(selectedFrame.id)} className="h-8 w-8 text-destructive hover:text-destructive">
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>

        {/* Frame Transform */}
        <div className="space-y-3">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Move className="w-4 h-4" /> Position
          </Label>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">X</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={Math.round(selectedFrame.transform.x)}
                onChange={(e) => updateTransform("x", parseNumber(e.target.value, 0))}
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Y</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={Math.round(selectedFrame.transform.y)}
                onChange={(e) => updateTransform("y", parseNumber(e.target.value, 0))}
                className="h-8"
              />
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Maximize2 className="w-4 h-4" /> Size
          </Label>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Width</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={Math.round(selectedFrame.transform.width)}
                onChange={(e) => updateTransform("width", Math.max(100, parseNumber(e.target.value, 100)))}
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Height</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={Math.round(selectedFrame.transform.height)}
                onChange={(e) => updateTransform("height", Math.max(100, parseNumber(e.target.value, 100)))}
                className="h-8"
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <RotateCw className="w-4 h-4" /> Rotation
          </Label>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              inputMode="numeric"
              value={Math.round(selectedFrame.transform.rotation)}
              onChange={(e) => updateTransform("rotation", parseNumber(e.target.value, 0))}
              className="h-8"
            />
            <span className="text-sm text-muted-foreground">°</span>
          </div>
        </div>

        {/* Cue Controls - only show for CueFrame */}
        {isCueFrame(selectedFrame) && (
          <div className="space-y-3 pt-4 border-t">
            <Label className="text-sm font-medium">Cue Controls</Label>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Spin Y (°)</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={Math.round(selectedFrame.cue.spinY * (180 / Math.PI))}
                  onChange={(e) => updateCue("spinY", parseNumber(e.target.value, 0) * (Math.PI / 180))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Camera (°)</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={Math.round(selectedFrame.cue.phi * (180 / Math.PI))}
                  onChange={(e) => updateCue("phi", parseNumber(e.target.value, 90) * (Math.PI / 180))}
                  className="h-8"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1">
                <ZoomIn className="w-3 h-3" /> Zoom
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  inputMode="decimal"
                  value={selectedFrame.cue.zoom.toFixed(1)}
                  onChange={(e) => updateCue("zoom", Math.max(0.5, Math.min(5, parseNumber(e.target.value, 1))))}
                  className="h-8"
                />
                <span className="text-sm text-muted-foreground">x</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Crosshair className="w-3 h-3" /> Offset X
                </Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={selectedFrame.cue.offsetX.toFixed(2)}
                  onChange={(e) => updateCue("offsetX", parseNumber(e.target.value, 0))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Offset Y</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={selectedFrame.cue.offsetY.toFixed(2)}
                  onChange={(e) => updateCue("offsetY", parseNumber(e.target.value, 0))}
                  className="h-8"
                />
              </div>
            </div>
          </div>
        )}

        {/* HDRI / Light Controls - only show for CueFrame */}
        {isCueFrame(selectedFrame) && (
          <div className="space-y-3 pt-4 border-t">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Lightbulb className="w-4 h-4" /> Lighting
            </Label>

            {/* Add HDRI Button */}
            <Popover open={addHdriOpen} onOpenChange={setAddHdriOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="w-full" disabled={!canAddHdri}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add HDRI {hdriLayers.length > 0 && `(${hdriLayers.length}/2)`}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-2" align="start">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground px-2">Select HDRI to add</Label>
                  {hdriOptions.map((option) => (
                    <Button key={option.id} variant="ghost" size="sm" className="w-full justify-start text-sm h-8" onClick={() => addHdriLayer(option.id)}>
                      {option.label}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* Active HDRI Badges */}
            {hdriLayers.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Active HDRIs (click to edit)</Label>
                <div className="flex flex-wrap gap-2">
                  {hdriLayers.map((layer) => (
                    <div
                      key={layer.id}
                      className={cn(
                        "flex items-center gap-1 px-2 py-1 rounded-md text-xs cursor-pointer transition-colors",
                        effectiveEditingLayerId === layer.id ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80"
                      )}
                      onClick={() => setEditingLayerId(layer.id)}
                    >
                      {effectiveEditingLayerId === layer.id && <Check className="w-3 h-3" />}
                      <span className="truncate max-w-[100px]">{getHdriLabel(layer.hdriType)}</span>
                      {hdriLayers.length > 1 && (
                        <button
                          className="ml-1 hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeHdriLayer(layer.id);
                          }}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Rotation Sliders for Selected HDRI */}
            {editingLayer && (
              <div className="space-y-3 p-3 bg-muted/50 rounded-lg">
                <Label className="text-xs font-medium">{getHdriLabel(editingLayer.hdriType)} Rotation</Label>

                {/* X Rotation Slider */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      <Sun className="w-3 h-3" /> X (Vertical)
                    </Label>
                    <span className="text-xs text-muted-foreground w-10 text-right">{Math.round(localRotationX ?? editingLayer.rotationX)}°</span>
                  </div>
                  <Slider
                    value={[localRotationX ?? editingLayer.rotationX]}
                    onValueChange={([value]) => setLocalRotationX(value)}
                    onValueCommit={([value]) => {
                      updateHdriLayer(editingLayer.id, { rotationX: value });
                      setLocalRotationX(null);
                    }}
                    min={0}
                    max={360}
                    step={1}
                    className="w-full"
                  />
                </div>

                {/* Y Rotation Slider */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      <RotateCw className="w-3 h-3" /> Y (Horizontal)
                    </Label>
                    <span className="text-xs text-muted-foreground w-10 text-right">{Math.round(localRotationY ?? editingLayer.rotationY)}°</span>
                  </div>
                  <Slider
                    value={[localRotationY ?? editingLayer.rotationY]}
                    onValueChange={([value]) => setLocalRotationY(value)}
                    onValueCommit={([value]) => {
                      updateHdriLayer(editingLayer.id, { rotationY: value });
                      setLocalRotationY(null);
                    }}
                    min={0}
                    max={360}
                    step={1}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Image Frame Controls - only show for ImageFrame */}
        {isImageFrame(selectedFrame) && (
          <div className="space-y-3 pt-4 border-t">
            <Label className="text-sm font-medium">Image Controls</Label>
            <ImageFrameControls frame={selectedFrame as ImageFrame} onFrameChange={onFrameChange} />
          </div>
        )}

        {/* Click outside hint */}
        <div className="text-xs text-muted-foreground pb-2">Click outside frames for layout controls</div>
      </div>

      {/* Persistent frames list at bottom */}
      <FramesListSection
        frames={frames}
        selectedFrameId={selectedFrameId}
        hiddenFrameIds={hiddenFrameIds}
        onSelectFrame={onSelectFrame}
        onReorderFrames={onReorderFrames}
        onToggleVisibility={onToggleVisibility}
        onDeleteFrame={onDeleteFrame}
        onRenameFrame={onRenameFrame}
      />
    </div>
  );
}
