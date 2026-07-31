"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  Layers,
  Box,
  Copy,
  ClipboardPaste,
} from "lucide-react";
import type { ExtractorFrame, ExtractorReference, HdriLayer, CueFrame, CueSettings, ImageFrame, CueShadowConfig } from "@/types/extractor";
import type { ProductType } from "@/types/product";
import { createDefaultHdriLayer, isCueFrame, isImageFrame, STUDIO_WHITE_HDRI, DEFAULT_CUE_SHADOW } from "@/types/extractor";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { ImageFrameControls } from "./image-frame-controls";
import { FramesList } from "./frames-list";
import { useReferenceList } from "@/hooks/use-reference-list";
import { ShadowSimulateDialog } from "./shadow-simulate-dialog";
import type { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";

interface HdriOption {
  id: string;
  label: string;
}

const PREVIEW_CANVAS = 2048;

function LayoutPreviewSvg({ frames, size, canvasW = 2048, canvasH = 2048 }: { frames: ExtractorFrame[]; size: number; canvasW?: number; canvasH?: number }) {
  const aspect = canvasW / canvasH;
  const svgW = aspect >= 1 ? size : Math.round(size * aspect);
  const svgH = aspect <= 1 ? size : Math.round(size / aspect);
  return (
    <svg width={svgW} height={svgH} viewBox={`0 0 ${canvasW} ${canvasH}`} style={{ background: "#111827" }} className="rounded block flex-shrink-0">
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
  selectedRefMeta: { id: string; name: string; isOwned: boolean } | null;
  onSelectReference: (id: string | null, meta: { id: string; name: string; isOwned: boolean } | null) => void;

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

  /** Live extractor scene manager — used by shadow simulator dialog */
  extractorRef?: React.MutableRefObject<ExtractorSceneManager | null>;

  /** Callback to set a frame's screenshot (used by simulator to push studio capture) */
  onScreenshotCapture?: (frameId: string, dataUrl: string) => void;

  /** Current product cue type — used to filter the surface product picker in shadow simulator */
  productType?: ProductType;

  /** Current product's flat surface design URL — used for the dynamic-surface
   *  image frame (button + live preview). */
  productSurfaceUrl?: string | null;

  /** Canvas dimensions — used for proportional frame positioning */
  canvasWidth?: number;
  canvasHeight?: number;
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
        <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{frames.length} khung trong canvas</Label>
        <span className="text-[10px] text-muted-foreground/50">kéo để sắp xếp</span>
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
  selectedRefMeta,
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
  extractorRef,
  onScreenshotCapture,
  productType,
  productSurfaceUrl,
  canvasWidth = 2048,
  canvasHeight = 2048,
}: FrameControlsPanelProps) {
  // Track which HDRI layer is being edited (by layer id)
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [addHdriOpen, setAddHdriOpen] = useState(false);

  // Shadow simulate dialog state
  const [shadowSimulateOpen, setShadowSimulateOpen] = useState(false);

  // Reference rename / delete state
  const [isRenamingRef, setIsRenamingRef] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteRef, setConfirmDeleteRef] = useState(false);

  // Reference popover state
  const [refPopoverOpen, setRefPopoverOpen] = useState(false);

  const {
    references: popoverRefs,
    isLoading: popoverLoading,
    isFetchingMore: popoverFetchingMore,
    hasMore: popoverHasMore,
    search: popoverSearch,
    setSearch: setPopoverSearch,
    loadMore: popoverLoadMore,
    reload: reloadPopoverRefs,
  } = useReferenceList({ enabled: refPopoverOpen });

  // Accumulate all refs ever seen so name lookups work after popover closes / resets.
  // Updated synchronously during render (ref, not state) — no stale-closure lag.
  const seenRefsMap = useRef<Map<string, ExtractorReference>>(new Map());
  for (const ref of references) seenRefsMap.current.set(ref.id, ref);
  for (const ref of popoverRefs) seenRefsMap.current.set(ref.id, ref);

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
  const [localIntensity, setLocalIntensity] = useState<number | null>(null);
  const [zoomInputValue, setZoomInputValue] = useState<string | null>(null);

  // Copy/paste clipboard: cue config (excluding studioShadow) + frame size
  type CueConfigClipboard = {
    cue: Omit<import("@/types/extractor").CueSettings, "studioShadow" | "lightAngle" | "hdriType">;
    width: number;
    height: number;
  };
  const [cueClipboard, setCueClipboard] = useState<CueConfigClipboard | null>(null);

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

  const updateShadow = (updates: Partial<CueShadowConfig>) => {
    if (!selectedFrame || !isCueFrame(selectedFrame)) return;
    const current = selectedFrame.cue.studioShadow ?? { ...DEFAULT_CUE_SHADOW };
    onFrameChange({
      ...selectedFrame,
      cue: { ...selectedFrame.cue, studioShadow: { ...current, ...updates } },
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

  // Studio shadow config for the selected CueFrame
  const shadowCfg: CueShadowConfig = (selectedFrame && isCueFrame(selectedFrame) ? selectedFrame.cue.studioShadow : null) ?? { ...DEFAULT_CUE_SHADOW };

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
    reloadPopoverRefs();
    setIsRenamingRef(false);
  };

  const submitDelete = async () => {
    if (!selectedReferenceId || !onDeleteReference) return;
    await onDeleteReference(selectedReferenceId);
    reloadPopoverRefs();
    setConfirmDeleteRef(false);
  };
  const selectedRefName = selectedReferenceId
    ? (seenRefsMap.current.get(selectedReferenceId)?.name ?? selectedRefMeta?.name ?? "Chưa đặt tên")
    : null;
  const selectedRefIsOwned = selectedReferenceId
    ? (seenRefsMap.current.get(selectedReferenceId)?.isOwned ?? selectedRefMeta?.isOwned ?? false)
    : false;

  // No frame selected - show reference/template controls
  if (!selectedFrame) {
    return (
      <div className="w-72 flex flex-col border-l bg-muted/30 overflow-hidden">
        {/* Scrollable main content */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {/* Reference Selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Tải tham chiếu</Label>
            <Button variant="outline" className="w-full justify-between text-sm font-normal" onClick={() => setRefPopoverOpen(true)}>
              <span className="truncate">{selectedRefName ?? "Bố cục mới"}</span>
              <ChevronDown className="h-4 w-4 ml-2 flex-shrink-0" />
            </Button>

            <Dialog open={refPopoverOpen} onOpenChange={setRefPopoverOpen}>
              <DialogContent className="sm:max-w-md flex flex-col gap-0 p-0 overflow-hidden h-[560px]">
                <DialogHeader className="px-4 pt-4 pb-3 border-b flex-shrink-0">
                  <DialogTitle className="text-base">Tải tham chiếu</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-2 p-3 flex-1 min-h-0 overflow-hidden">
                  {/* Search — spinner replaces icon while loading */}
                  <div className="relative flex-shrink-0">
                    {popoverLoading ? (
                      <Loader2 className="absolute left-2 top-2 h-4 w-4 text-muted-foreground animate-spin" />
                    ) : (
                      <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                    )}
                    <Input value={popoverSearch} onChange={(e) => setPopoverSearch(e.target.value)} placeholder="Tìm kiếm..." className="pl-7 h-8 text-sm" autoFocus />
                  </div>

                  {/* New Layout option */}
                  <button
                    className="flex-shrink-0 w-full text-left text-sm px-2 py-2 rounded hover:bg-accent font-medium"
                    onClick={() => {
                      setIsRenamingRef(false);
                      setConfirmDeleteRef(false);
                      onSelectReference(null, null);
                      setRefPopoverOpen(false);
                    }}
                  >
                    + Bố cục mới
                  </button>

                  {/* Scrollable thumbnail list — fixed height via parent, never resizes */}
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
                      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                        <Loader2 className="h-6 w-6 animate-spin" />
                        <span className="text-xs">Đang tải...</span>
                      </div>
                    ) : !popoverLoading && popoverRefs.length === 0 ? (
                      <div className="flex items-center justify-center h-full">
                        <p className="text-sm text-muted-foreground">Không tìm thấy tham chiếu</p>
                      </div>
                    ) : (
                      popoverRefs.map((ref) => (
                        <button
                          key={ref.id}
                          className={`w-full flex items-center gap-3 p-2 rounded text-left hover:bg-accent transition-colors ${selectedReferenceId === ref.id ? "bg-accent" : ""}`}
                          onClick={() => {
                            setIsRenamingRef(false);
                            setConfirmDeleteRef(false);
                            onSelectReference(ref.id, { id: ref.id, name: ref.name, isOwned: ref.isOwned ?? false });
                            setRefPopoverOpen(false);
                          }}
                        >
                          <div className="flex-shrink-0 w-14 h-14 rounded overflow-hidden bg-[#111827]">
                            <img src={ref.thumbUrl} alt={ref.name} className="w-full h-full object-cover" draggable={false} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{ref.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {ref.frames.length} khung
                              {ref.createdByName && <span className="ml-1.5 opacity-70">· {ref.createdByName}</span>}
                            </div>
                          </div>
                        </button>
                      ))
                    )}

                    {popoverFetchingMore && (
                      <div className="py-2 flex justify-center">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </div>
              </DialogContent>
            </Dialog>

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
                  <span className="flex-1 text-xs text-destructive">Xóa tham chiếu này?</span>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={submitDelete}>
                    <Check className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setConfirmDeleteRef(false)}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm truncate text-muted-foreground">{selectedRefName ?? "Bố cục mới"}</span>
                  {selectedReferenceId && selectedRefIsOwned && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        title="Đổi tên"
                        onClick={() => {
                          setRenameValue(selectedRefName ?? "");
                          setIsRenamingRef(true);
                        }}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" title="Xóa" onClick={() => setConfirmDeleteRef(true)}>
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
              Thêm Khung
            </Button>
            <Button onClick={onAddImageFrame} variant="outline" className="w-full">
              <ImagePlus className="w-4 h-4 mr-2" />
              Thêm Ảnh
            </Button>
          </div>

          {/* Layout Controls */}
          <div className="space-y-3 pt-4 border-t">
            <Label className="text-sm font-medium">Bố cục</Label>

            <Button variant="outline" size="sm" onClick={onAlignFrames} className="w-full">
              <AlignCenter className="w-4 h-4 mr-2" />
              Tự động căn chỉnh
            </Button>

            <div>
              <Label className="text-xs text-muted-foreground">Khoảng cách (px)</Label>
              <Input type="text" inputMode="numeric" value={gap} onChange={(e) => onGapChange(parseNumber(e.target.value, 0))} className="h-8 mt-1" />
              <p className="text-[10px] text-muted-foreground/70 mt-1">Thay đổi giá trị và nhấn Tự động căn chỉnh</p>
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
            <h3 className="font-medium text-sm">{selectedFrame.name || `Frame ${selectedFrame.order + 1}`}</h3>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onDeleteFrame(selectedFrame.id)} className="h-8 w-8 text-destructive hover:text-destructive">
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>

        {/* Copy / Paste config buttons — only for CueFrame */}
        {isCueFrame(selectedFrame) && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-8"
              onClick={() => {
                const { studioShadow, lightAngle, hdriType, ...cue } = selectedFrame.cue;
                setCueClipboard({
                  cue,
                  width: Math.round(selectedFrame.transform.width),
                  height: Math.round(selectedFrame.transform.height),
                });
              }}
            >
              <Copy className="w-3.5 h-3.5 mr-1.5" /> Sao chép
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-8"
              disabled={!cueClipboard}
              onClick={() => {
                if (!cueClipboard) return;
                onFrameChange({
                  ...selectedFrame,
                  transform: {
                    ...selectedFrame.transform,
                    width: cueClipboard.width,
                    height: cueClipboard.height,
                  },
                  cue: {
                    ...selectedFrame.cue,
                    ...cueClipboard.cue,
                  },
                });
              }}
            >
              <ClipboardPaste className="w-3.5 h-3.5 mr-1.5" /> Dán
            </Button>
          </div>
        )}

        {/* Frame Transform */}
        <div className="space-y-3">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Move className="w-4 h-4" /> Vị trí
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
            <Maximize2 className="w-4 h-4" /> Kích thước
          </Label>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Chiều rộng</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={Math.round(selectedFrame.transform.width)}
                onChange={(e) => updateTransform("width", Math.max(100, parseNumber(e.target.value, 100)))}
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Chiều cao</Label>
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
            <RotateCw className="w-4 h-4" /> Xoay
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
            <Label className="text-sm font-medium">Điều khiển Cơ</Label>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Xoay Y (°)</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={Math.round(selectedFrame.cue.spinY * (180 / Math.PI))}
                  onChange={(e) => updateCue("spinY", parseNumber(e.target.value, 0) * (Math.PI / 180))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Góc Camera (°)</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={Math.round(selectedFrame.cue.phi * (180 / Math.PI))}
                  onChange={(e) => updateCue("phi", parseNumber(e.target.value, 0) * (Math.PI / 180))}
                  className="h-8"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1">
                <ZoomIn className="w-3 h-3" /> Thu phóng
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  inputMode="decimal"
                  value={zoomInputValue ?? selectedFrame.cue.zoom.toFixed(1)}
                  onChange={(e) => {
                    setZoomInputValue(e.target.value);
                    const parsed = parseFloat(e.target.value);
                    if (!isNaN(parsed)) {
                      updateCue("zoom", Math.max(0.5, Math.min(5, parsed)));
                    }
                  }}
                  onBlur={() => {
                    const parsed = parseFloat(zoomInputValue ?? "");
                    const clamped = Math.max(0.5, Math.min(5, isNaN(parsed) ? 1 : parsed));
                    updateCue("zoom", clamped);
                    setZoomInputValue(null);
                  }}
                  className="h-8"
                />
                <span className="text-sm text-muted-foreground">x</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Crosshair className="w-3 h-3" /> Bù trừ X
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
                <Label className="text-xs text-muted-foreground">Bù trừ Y</Label>
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
              <Lightbulb className="w-4 h-4" /> Ánh sáng
            </Label>

            {/* Add HDRI Button */}
            <Popover open={addHdriOpen} onOpenChange={setAddHdriOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="w-full" disabled={!canAddHdri}>
                  <Plus className="w-4 h-4 mr-2" />
                  Thêm HDRI {hdriLayers.length > 0 && `(${hdriLayers.length}/2)`}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-64 p-2 flex flex-col max-h-[min(20rem,var(--radix-popover-content-available-height))]"
                align="start"
                collisionPadding={8}
              >
                <Label className="text-xs text-muted-foreground px-2 pb-1 shrink-0">Chọn HDRI để thêm</Label>
                <div ref={popoverListRef} className="space-y-1 overflow-y-auto overscroll-contain min-h-0">
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
                <Label className="text-xs text-muted-foreground">HDRI đang hoạt động (nhấn để chỉnh sửa)</Label>
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
                <Label className="text-xs font-medium">Xoay {getHdriLabel(editingLayer.hdriType)}</Label>

                {/* X Rotation Slider */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      <Sun className="w-3 h-3" /> X (Dọc)
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
                      <RotateCw className="w-3 h-3" /> Y (Ngang)
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

                {/* Intensity Slider */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      <Lightbulb className="w-3 h-3" /> Cường độ
                    </Label>
                    <span className="text-xs text-muted-foreground w-10 text-right">{(localIntensity ?? editingLayer.intensity).toFixed(1)}</span>
                  </div>
                  <Slider
                    value={[localIntensity ?? editingLayer.intensity]}
                    onValueChange={([value]) => setLocalIntensity(value)}
                    onValueCommit={([value]) => {
                      updateHdriLayer(editingLayer.id, { intensity: value });
                      setLocalIntensity(null);
                    }}
                    min={0}
                    max={3}
                    step={0.1}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Studio Shadow — only for CueFrame */}
        {isCueFrame(selectedFrame) && (
          <div className="space-y-3 pt-4 border-t">
            {/* Header + toggle */}
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium flex items-center gap-2">
                <Layers className="w-4 h-4" /> Studio Shadow
              </Label>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="shadow-enabled"
                  checked={shadowCfg.enabled}
                  onCheckedChange={(checked) => {
                    const enabled = !!checked;
                    if (!selectedFrame || !isCueFrame(selectedFrame)) return;
                    const current = selectedFrame.cue.studioShadow ?? { ...DEFAULT_CUE_SHADOW };
                    // Merge shadow enable + optional transform resize into a single onFrameChange call
                    // so neither update overwrites the other.
                    const updates: Partial<typeof selectedFrame> = {
                      cue: { ...selectedFrame.cue, studioShadow: { ...current, enabled } },
                    };
                    if (enabled) {
                      updates.transform = {
                        ...(selectedFrame.transform ?? {}),
                        x: 0,
                        y: 0,
                        width: canvasWidth,
                        height: canvasHeight,
                      };
                    }
                    onFrameChange({ ...selectedFrame, ...updates });
                    if (enabled) setShadowSimulateOpen(true);
                  }}
                />
                <label htmlFor="shadow-enabled" className="text-xs text-muted-foreground cursor-pointer select-none">
                  {shadowCfg.enabled ? "Bật" : "Tắt"}
                </label>
              </div>
            </div>

            {shadowCfg.enabled && (
              <Button variant="outline" size="sm" className="w-full gap-2" onClick={() => setShadowSimulateOpen(true)}>
                <Box className="w-3.5 h-3.5" />
                Mở Studio 3D Simulator
              </Button>
            )}

            {shadowCfg.enabled && extractorRef && (
              <ShadowSimulateDialog
                open={shadowSimulateOpen}
                onOpenChange={setShadowSimulateOpen}
                shadowConfig={shadowCfg}
                onConfigChange={(cfg) => updateShadow(cfg)}
                onSave={(cfg) => {
                  updateShadow(cfg);
                  // Push studio capture as frame screenshot so it shows in the canvas
                  if (cfg.studioCapture && selectedFrame && onScreenshotCapture) {
                    onScreenshotCapture(selectedFrame.id, cfg.studioCapture);
                  }
                  setShadowSimulateOpen(false);
                }}
                extractorRef={extractorRef}
                productType={productType ?? "smooth"}
                cueSettings={{
                  phi: selectedFrame.cue.phi,
                  zoom: selectedFrame.cue.zoom,
                  offsetX: selectedFrame.cue.offsetX,
                  offsetY: selectedFrame.cue.offsetY,
                  spinY: selectedFrame.cue.spinY,
                }}
              />
            )}
          </div>
        )}

        {/* Image Frame Controls - only show for ImageFrame */}
        {isImageFrame(selectedFrame) && (
          <div className="space-y-3 pt-4 border-t">
            <Label className="text-sm font-medium">Điều khiển Ảnh</Label>
            <ImageFrameControls
              frame={selectedFrame as ImageFrame}
              onFrameChange={onFrameChange}
              productSurfaceUrl={productSurfaceUrl}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
            />
          </div>
        )}

        {/* Click outside hint */}
        <div className="text-xs text-muted-foreground pb-2">Nhấn bên ngoài khung để xem điều khiển bố cục</div>
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
