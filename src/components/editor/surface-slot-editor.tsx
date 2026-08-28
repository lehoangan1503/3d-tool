"use client";

/**
 * Surface Slot Editor — design placeholder "slots" on the product's surface
 * image. Slots are frames (image or text) that storefront customers later FILL
 * (photo upload / text input) but cannot move or resize. Definitions are saved
 * to products.surface_slots and deployed to the custom.surface_slots metafield.
 *
 * Full-screen dialog: one compact toolbar row on top, the pan/zoom viewport
 * fills everything else, and the selected slot's details float as a small
 * panel over the canvas. The surface is shown VERTICALLY in its natural
 * orientation with free pan/zoom (same interaction as the surface uploader's
 * fullscreen viewer: wheel-zoom pinned to the cursor, drag to pan), so slots
 * are edited directly in surface space — x/w across the width (wraps the cue
 * circumference), y/h along the cue length. Persisted values are fractions of
 * the surface image; the pixel inputs allow precise tuning.
 *
 * Note: rotation is part of each persisted slot. By default text slots start
 * at 90° because content usually runs along the cue length, but the whole
 * frame can be rotated by dragging the rotate handle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, ImagePlus, Loader2, Type, Trash2, ZoomIn, ZoomOut, RotateCcw, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SurfaceSlot, SurfaceSlotPoint, SurfaceSlotsConfig, SurfaceSlotType } from "@/types/product";

const SLOT_FONTS: Array<{ label: string; value: string }> = [
  { label: "Wide Sans (Poppins)", value: "'Poppins', sans-serif" },
  { label: "UNI Style (Rajdhani)", value: "'Rajdhani', sans-serif" },
  { label: "Script (Great Vibes)", value: "'Great Vibes', cursive" },
  { label: "Serif (Playfair Display)", value: "'Playfair Display', serif" },
  { label: "Tech (Orbitron)", value: "'Orbitron', sans-serif" },
];

// Surface-space minimums: w across the circumference, h along the cue length.
const MIN_W = 0.05;
const MIN_H = 0.01;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 40;
const WRAP_HALF_SNAP_PX = 12;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function wrap01(v: number): number {
  const wrapped = v % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

function slotRenderXs(slot: SurfaceSlot): number[] {
  const x = wrap01(slot.x);
  return x + slot.w > 1 ? [x, x - 1] : [x];
}

function circularDistance01(a: number, b: number): number {
  const diff = Math.abs(wrap01(a) - wrap01(b));
  return Math.min(diff, 1 - diff);
}

function snapToHalfWrapX(rawX: number, width: number, stageWidth: number): number {
  const x = wrap01(rawX);
  if (!stageWidth || width <= 0 || width >= 1) return x;
  const target = wrap01(1 - width / 2);
  const snapDistance = WRAP_HALF_SNAP_PX / stageWidth;
  return circularDistance01(x, target) <= snapDistance ? target : x;
}

function normalizePoints(points: SurfaceSlotPoint[] | undefined): SurfaceSlotPoint[] | undefined {
  if (!Array.isArray(points) || points.length < 3) return undefined;
  return points.map((point) => ({
    x: clamp(Number(point.x) || 0, 0, 1),
    y: clamp(Number(point.y) || 0, 0, 1),
  }));
}

function polygonClipPath(points: SurfaceSlotPoint[] | undefined): string | undefined {
  const normalized = normalizePoints(points);
  if (!normalized) return undefined;
  return `polygon(${normalized.map((point) => `${point.x * 100}% ${point.y * 100}%`).join(", ")})`;
}

function normalizeSlot(slot: SurfaceSlot): SurfaceSlot {
  if (slot.type === "text") {
    return {
      ...slot,
      x: wrap01(slot.x),
      shape: "rect",
      rotate: slot.rotate ?? 90,
      radius: slot.radius ?? 8,
      maxChars: slot.maxChars ?? 20,
      font: slot.font ?? SLOT_FONTS[0].value,
      fontSize: slot.fontSize ?? 62,
      fontWeight: slot.fontWeight ?? 700,
      color: slot.color ?? "#1c1c1e",
    };
  }
  const points = normalizePoints(slot.points);
  return {
    ...slot,
    x: wrap01(slot.x),
    shape: slot.shape === "polygon" && points ? "polygon" : "rect",
    points,
    rotate: slot.rotate ?? 0,
    radius: slot.shape === "polygon" && points ? 0 : slot.radius ?? 8,
    fit: slot.fit ?? "contain",
  };
}

interface DragState {
  mode: "move" | "resize" | "rotate";
  slotId: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  startRotate: number;
  startAngle: number;
  centerClientX: number;
  centerClientY: number;
  /** Rendered stage size in px at drag start (base × zoom). */
  stageW: number;
  stageH: number;
}

interface SurfaceSlotEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  surfaceUrl: string | null;
  value: SurfaceSlotsConfig | null | undefined;
  onSave: (config: SurfaceSlotsConfig | null) => void | Promise<void>;
}

export function SurfaceSlotEditor({ open, onOpenChange, surfaceUrl, value, onSave }: SurfaceSlotEditorProps) {
  const [slots, setSlots] = useState<SurfaceSlot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [polygonMode, setPolygonMode] = useState(false);
  const [draftPoints, setDraftPoints] = useState<SurfaceSlotPoint[]>([]);
  const [applying, setApplying] = useState(false);

  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;

  const viewportElRef = useRef<HTMLDivElement | null>(null);
  const stageElRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });

  // Initialize the draft from the persisted config each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setSlots((value?.slots ?? []).map(normalizeSlot));
    setSelectedId(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPolygonMode(false);
    setDraftPoints([]);
  }, [open, value]);

  // Wheel-zoom pinned to the cursor + viewport size tracking. Callback ref so
  // the non-passive listener attaches the moment the portal content mounts.
  const viewportCallbackRef = useCallback((node: HTMLDivElement | null) => {
    viewportElRef.current = node;
    if (!node) return;
    const el = node;

    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;

      const oldZoom = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = clamp(oldZoom * factor, MIN_ZOOM, MAX_ZOOM);

      // Pin the image point under the cursor.
      const ratio = newZoom / oldZoom;
      const oldPan = panRef.current;
      setZoom(newZoom);
      setPan({ x: mx - (mx - oldPan.x) * ratio, y: my - (my - oldPan.y) * ratio });
    }

    el.addEventListener("wheel", onWheel, { passive: false });
  }, []);

  // Base (zoom = 1) stage size: the surface image contain-fitted in the viewport.
  const base = (() => {
    if (!imgNatural || viewport.w === 0 || viewport.h === 0) return { w: 0, h: 0 };
    const scale = Math.min(viewport.w / imgNatural.w, viewport.h / imgNatural.h);
    return { w: imgNatural.w * scale, h: imgNatural.h * scale };
  })();
  const stageW = base.w * zoom;
  const stageH = base.h * zoom;

  const selected = slots.find((s) => s.id === selectedId) ?? null;

  const updateSlot = useCallback((id: string, patch: Partial<SurfaceSlot>) => {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const addSlot = (type: SurfaceSlotType) => {
    const id = crypto.randomUUID();
    const count = slots.length;
    // Content runs along the cue length → boxes are wide across the surface
    // width and sized along the length. Stagger new slots down the surface.
    const slot: SurfaceSlot = {
      id,
      type,
      x: 0.2,
      y: clamp(0.45 + count * 0.06, 0, 0.9),
      w: 0.6,
      h: type === "text" ? 0.05 : 0.08,
      rotate: type === "text" ? 90 : 0,
      radius: 8,
      label: type === "text" ? `Text ${count + 1}` : `Photo ${count + 1}`,
      ...(type === "text"
        ? { maxChars: 20, font: SLOT_FONTS[0].value, fontSize: 62, fontWeight: 700, color: "#1c1c1e" }
        : { fit: "contain" as const }),
    };
    setSlots((prev) => [...prev, slot]);
    setSelectedId(id);
  };

  const pointFromClient = (event: React.PointerEvent): SurfaceSlotPoint | null => {
    const stage = stageElRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
  };

  const createPolygonSlot = (points: SurfaceSlotPoint[]) => {
    if (points.length < 4) return;
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));
    const w = Math.max(maxX - minX, MIN_W);
    const h = Math.max(maxY - minY, MIN_H);
    const x = clamp(minX, 0, 1 - w);
    const y = clamp(minY, 0, 1 - h);
    const width = clamp(w, MIN_W, 1 - x);
    const height = clamp(h, MIN_H, 1 - y);
    const slot: SurfaceSlot = {
      id: crypto.randomUUID(),
      type: "image",
      shape: "polygon",
      x,
      y,
      w: width,
      h: height,
      rotate: 0,
      radius: 0,
      label: `Photo ${slots.length + 1}`,
      fit: "contain",
      points: points.map((point) => ({
        x: width > 0 ? clamp((point.x - x) / width, 0, 1) : 0,
        y: height > 0 ? clamp((point.y - y) / height, 0, 1) : 0,
      })),
    };
    setSlots((prev) => [...prev, slot]);
    setSelectedId(slot.id);
    setDraftPoints([]);
    setPolygonMode(false);
  };

  const addPolygonPoint = (event: React.PointerEvent) => {
    const point = pointFromClient(event);
    if (!point) return;
    if (draftPoints.length >= 4) {
      const first = draftPoints[0];
      const dx = (point.x - first.x) * stageW;
      const dy = (point.y - first.y) * stageH;
      if (Math.hypot(dx, dy) <= 18) {
        createPolygonSlot(draftPoints);
        return;
      }
    }
    setDraftPoints((prev) => [...prev, point]);
  };

  const togglePolygonMode = () => {
    setPolygonMode((value) => !value);
    setDraftPoints([]);
    setSelectedId(null);
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setSlots((prev) => prev.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  };

  const duplicateSelected = () => {
    if (!selected) return;
    const copy = normalizeSlot({
      ...selected,
      id: crypto.randomUUID(),
      label: selected.label ? `${selected.label} copy` : selected.type === "text" ? `Text ${slots.length + 1}` : `Photo ${slots.length + 1}`,
      x: wrap01(selected.x + 0.025),
      y: clamp(selected.y + 0.025, 0, 1 - selected.h),
      points: selected.points?.map((point) => ({ ...point })),
    });
    setSlots((prev) => [...prev, copy]);
    setSelectedId(copy.id);
  };

  /* ---------------- viewport panning (background drag) ---------------- */
  const onViewportPointerDown = (e: React.PointerEvent) => {
    if (polygonMode) {
      addPolygonPoint(e);
      setSelectedId(null);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelectedId(null);
  };
  const onViewportPointerMove = (e: React.PointerEvent) => {
    if (polygonMode || dragRef.current || !isPanningRef.current) return;
    setPan({ x: e.clientX - panStartRef.current.x, y: e.clientY - panStartRef.current.y });
  };
  const onViewportPointerUp = () => {
    isPanningRef.current = false;
  };

  const applyZoom = useCallback((factor: number) => {
    setZoom((z) => {
      const nz = clamp(z * factor, MIN_ZOOM, MAX_ZOOM);
      setPan((p) => ({ x: p.x * (nz / z), y: p.y * (nz / z) }));
      return nz;
    });
  }, []);
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  /* ------------------------- slot drag / resize ------------------------- */
  const startDrag = (e: React.PointerEvent, slotId: string, mode: DragState["mode"]) => {
    const slot = slots.find((s) => s.id === slotId);
    if (!slot || stageW === 0) return;
    const frameEl = (e.currentTarget as HTMLElement).closest("[data-slot-frame]") as HTMLElement | null;
    const rect = frameEl?.getBoundingClientRect();
    const centerClientX = rect ? rect.left + rect.width / 2 : e.clientX;
    const centerClientY = rect ? rect.top + rect.height / 2 : e.clientY;
    const startAngle = Math.atan2(e.clientY - centerClientY, e.clientX - centerClientX) * 180 / Math.PI;
    dragRef.current = {
      mode,
      slotId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: slot.x,
      startY: slot.y,
      startW: slot.w,
      startH: slot.h,
      startRotate: slot.rotate ?? 0,
      startAngle,
      centerClientX,
      centerClientY,
      stageW,
      stageH,
    };
    setSelectedId(slotId);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  const onDragMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (e.clientX - drag.startClientX) / drag.stageW;
    const dy = (e.clientY - drag.startClientY) / drag.stageH;
    if (drag.mode === "move") {
      updateSlot(drag.slotId, {
        x: snapToHalfWrapX(drag.startX + dx, drag.startW, drag.stageW),
        y: clamp(drag.startY + dy, 0, 1 - drag.startH),
      });
    } else if (drag.mode === "resize") {
      updateSlot(drag.slotId, {
        w: clamp(drag.startW + dx, MIN_W, 1),
        h: clamp(drag.startH + dy, MIN_H, 1 - drag.startY),
      });
    } else {
      const angle = Math.atan2(e.clientY - drag.centerClientY, e.clientX - drag.centerClientX) * 180 / Math.PI;
      updateSlot(drag.slotId, { rotate: Math.round(drag.startRotate + angle - drag.startAngle) });
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  /* --------------- precise pixel inputs (selected slot) --------------- */
  const setSlotPx = (field: "x" | "y" | "w" | "h", px: number) => {
    if (!selected || !imgNatural) return;
    const full = field === "x" || field === "w" ? imgNatural.w : imgNatural.h;
    const frac = px / full;
    if (field === "x") updateSlot(selected.id, { x: wrap01(frac) });
    if (field === "y") updateSlot(selected.id, { y: clamp(frac, 0, 1 - selected.h) });
    if (field === "w") updateSlot(selected.id, { w: clamp(frac, MIN_W, 1) });
    if (field === "h") updateSlot(selected.id, { h: clamp(frac, MIN_H, 1 - selected.y) });
  };
  const slotPx = (field: "x" | "y" | "w" | "h"): number => {
    if (!selected || !imgNatural) return 0;
    const full = field === "x" || field === "w" ? imgNatural.w : imgNatural.h;
    return Math.round(selected[field] * full);
  };

  const handleSave = async () => {
    if (applying) return;
    const config: SurfaceSlotsConfig | null =
      slots.length > 0 ? { version: 1, slots: slots.map(normalizeSlot) } : null;
    setApplying(true);
    try {
      await onSave(config);
      onOpenChange(false);
    } catch (error) {
      console.error("Surface slot apply failed:", error);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!applying) onOpenChange(nextOpen); }}>
      <DialogContent className="flex h-screen w-screen max-w-none flex-col gap-2 rounded-none border-0 p-2 sm:p-3">
        {/* Fonts used by text-slot previews (same set the storefront offers) */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Great+Vibes&family=Orbitron:wght@600;700&family=Playfair+Display:wght@600;700&family=Poppins:wght@600;700;800&family=Rajdhani:wght@600;700&display=swap"
        />

        {/* Single compact toolbar row */}
        <DialogHeader className="flex-row items-center gap-2 space-y-0">
          <DialogTitle className="mr-2 whitespace-nowrap text-sm">Khung tùy chỉnh (Slots)</DialogTitle>

          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => addSlot("image")}>
            <ImagePlus className="mr-1 h-3.5 w-3.5" /> Khung ảnh
          </Button>
          <Button type="button" variant={polygonMode ? "secondary" : "outline"} size="sm" className="h-7 px-2 text-xs" onClick={togglePolygonMode}>
            <ImagePlus className="mr-1 h-3.5 w-3.5" /> Vẽ khung
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => addSlot("text")}>
            <Type className="mr-1 h-3.5 w-3.5" /> Khung chữ
          </Button>
          {selected && (
            <>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={duplicateSelected}>
                <Copy className="mr-1 h-3.5 w-3.5" /> Nhân đôi
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs text-destructive" onClick={deleteSelected}>
                <Trash2 className="mr-1 h-3.5 w-3.5" /> Xóa
              </Button>
            </>
          )}

          <div className="ml-auto flex items-center gap-0.5">
            <button type="button" onClick={() => applyZoom(1 / 1.25)} className="rounded p-1.5 transition-colors hover:bg-muted" title="Thu nhỏ">
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="w-11 text-center text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => applyZoom(1.25)} className="rounded p-1.5 transition-colors hover:bg-muted" title="Phóng to">
              <ZoomIn className="h-4 w-4" />
            </button>
            <button type="button" onClick={resetView} className="rounded p-1.5 transition-colors hover:bg-muted" title="Đặt lại">
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>

          <span className="hidden text-[11px] text-muted-foreground lg:block">
            {polygonMode ? "Chấm ít nhất 4 điểm, bấm lại điểm đầu để đóng khung" : `Lăn chuột để zoom · kéo nền để di chuyển · ${slots.length} khung`}
          </span>

          <Button type="button" variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={() => onOpenChange(false)} disabled={applying}>
            Hủy
          </Button>
          <Button type="button" size="sm" className="mr-8 h-7 px-3 text-xs" onClick={handleSave} disabled={applying}>
            {applying && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {applying ? "Đang lưu..." : "Áp dụng"}
          </Button>
        </DialogHeader>

        {!surfaceUrl ? (
          <p className="text-sm text-muted-foreground">
            Sản phẩm chưa có ảnh bề mặt. Hãy tải lên bề mặt trước khi tạo khung.
          </p>
        ) : (
          /* Pan/zoom viewport — fills the whole remaining dialog area */
          <div
            ref={viewportCallbackRef}
            className="relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-md border border-border bg-black/20"
            style={{ cursor: polygonMode ? "crosshair" : "grab" }}
            onPointerDown={onViewportPointerDown}
            onPointerMove={onViewportPointerMove}
            onPointerUp={onViewportPointerUp}
            onPointerCancel={onViewportPointerUp}
          >
            {stageW > 0 && (
              <div
                ref={stageElRef}
                className="absolute left-1/2 top-1/2 overflow-hidden"
                style={{
                  width: `${stageW}px`,
                  height: `${stageH}px`,
                  transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={surfaceUrl}
                  alt="Bề mặt"
                  draggable={false}
                  className="absolute inset-0 h-full w-full"
                />
                {slots.flatMap((slot) => {
                  const isSelected = slot.id === selectedId;
                  const textPx = Math.max((slot.fontSize ?? 62) / 100 * slot.h * stageH, 8);
                  const clipPath = slot.shape === "polygon" ? polygonClipPath(slot.points) : undefined;
                  return slotRenderXs(slot).map((renderX, renderIndex) => (
                    <div
                      key={`${slot.id}-${renderIndex}`}
                      data-slot-frame
                      className={cn("absolute cursor-move overflow-visible", isSelected && "z-10")}
                      style={{
                        left: `${renderX * 100}%`,
                        top: `${slot.y * 100}%`,
                        width: `${slot.w * 100}%`,
                        height: `${slot.h * 100}%`,
                        transform: `rotate(${slot.rotate ?? 0}deg)`,
                        transformOrigin: "center",
                      }}
                      onPointerDown={(e) => startDrag(e, slot.id, "move")}
                      onPointerMove={onDragMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    >
                      <div
                        className={cn(
                          "absolute inset-0 flex items-center overflow-hidden rounded-sm border-2",
                          slot.type === "text" ? "justify-center px-2" : "justify-center",
                          slot.shape === "polygon" && "border-transparent bg-transparent",
                          isSelected
                            ? "border-solid border-lime-300 bg-lime-400/20 shadow-[0_0_10px_rgba(163,230,53,0.6)]"
                            : "border-dashed border-lime-400 bg-lime-400/10"
                        )}
                        style={{
                          borderRadius: `${slot.radius ?? 8}%`,
                          clipPath,
                        }}
                      >
                        {slot.type === "text" ? (
                          <span
                            className="pointer-events-none whitespace-nowrap leading-none"
                            style={{
                              fontFamily: slot.font,
                              fontWeight: slot.fontWeight ?? 700,
                              color: slot.color,
                              fontSize: `${textPx}px`,
                            }}
                          >
                            {slot.label || "Text"}
                          </span>
                        ) : (
                          <>
                            {slot.shape === "polygon" && normalizePoints(slot.points) && (
                              <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                                <polygon
                                  points={normalizePoints(slot.points)!.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")}
                                  fill="rgba(120,255,45,.16)"
                                  stroke={isSelected ? "#a3ff12" : "rgba(120,255,45,.95)"}
                                  strokeWidth="1.4"
                                  strokeDasharray={isSelected ? "0" : "3 2"}
                                  vectorEffect="non-scaling-stroke"
                                />
                              </svg>
                            )}
                            <span className="pointer-events-none rounded bg-lime-950/70 px-1.5 py-0.5 text-center text-[10px] font-semibold text-lime-300">
                              {slot.label || "Photo"}
                            </span>
                          </>
                        )}
                      </div>
                      {isSelected && (
                        <>
                          <div
                            className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-lime-500"
                            onPointerDown={(e) => startDrag(e, slot.id, "resize")}
                            onPointerMove={onDragMove}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                          />
                          <button
                            type="button"
                            className="absolute -left-8 top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border-2 border-slate-900 bg-lime-400 text-slate-950 shadow-sm"
                            title="Drag to rotate frame"
                            onPointerDown={(e) => startDrag(e, slot.id, "rotate")}
                            onPointerMove={onDragMove}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  ));
                })}
                {polygonMode && draftPoints.length > 0 && (
                  <>
                    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                      <polyline
                        points={draftPoints.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")}
                        fill="rgba(120,255,45,.10)"
                        stroke="#a3ff12"
                        strokeWidth="1.2"
                        strokeDasharray="3 2"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                    {draftPoints.map((point, index) => (
                      <span
                        key={`${point.x}-${point.y}-${index}`}
                        className={cn(
                          "pointer-events-none absolute h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#a3ff12]",
                          index === 0 && draftPoints.length >= 4 && "ring-1 ring-slate-950"
                        )}
                        style={{
                          left: `${point.x * 100}%`,
                          top: `${point.y * 100}%`,
                        }}
                      />
                    ))}
                  </>
                )}
              </div>
            )}

            {/* Hidden probe to learn the image's natural size */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={surfaceUrl}
              alt=""
              className="hidden"
              onLoad={(e) => {
                const img = e.currentTarget;
                setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
              }}
            />

            {/* Floating compact details panel for the selected slot */}
            {selected && (
              <div
                className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 flex-wrap items-end justify-center gap-x-2 gap-y-1 rounded-lg border border-border bg-background/90 px-3 py-1.5 shadow-lg backdrop-blur"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="flex flex-col">
                  <span className="text-[9px] font-medium uppercase text-muted-foreground">Nhãn</span>
                  <Input
                    className="h-6 w-28 px-1.5 text-xs"
                    value={selected.label ?? ""}
                    onChange={(e) => updateSlot(selected.id, { label: e.target.value })}
                  />
                </div>
                {imgNatural &&
                  (["x", "y", "w", "h"] as const).map((field) => (
                    <div key={field} className="flex flex-col">
                      <span className="text-[9px] font-medium uppercase text-muted-foreground">{field} px</span>
                      <NumberInput
                        className="h-6 w-[68px] px-1.5 text-xs"
                        value={slotPx(field)}
                        onChange={(v) => setSlotPx(field, v)}
                      />
                    </div>
                  ))}
                <div className="flex flex-col">
                  <span className="text-[9px] font-medium uppercase text-muted-foreground">Xoay</span>
                  <NumberInput
                    className="h-6 w-[68px] px-1.5 text-xs"
                    value={Math.round(selected.rotate ?? 0)}
                    onChange={(v) => updateSlot(selected.id, { rotate: v })}
                  />
                </div>
                <div className="flex flex-col">
                  <span className="text-[9px] font-medium uppercase text-muted-foreground">Bo góc %</span>
                  <NumberInput
                    min={0}
                    max={50}
                    className="h-6 w-[68px] px-1.5 text-xs"
                    value={selected.radius ?? 8}
                    onChange={(v) => updateSlot(selected.id, { radius: v })}
                  />
                </div>
                {selected.type === "text" && (
                  <>
                    <div className="flex flex-col">
                      <span className="text-[9px] font-medium uppercase text-muted-foreground">Max</span>
                      <NumberInput
                        min={1}
                        max={60}
                        fallback={20}
                        className="h-6 w-14 px-1.5 text-xs"
                        value={selected.maxChars ?? 20}
                        onChange={(v) => updateSlot(selected.id, { maxChars: v })}
                      />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[9px] font-medium uppercase text-muted-foreground">Size %</span>
                      <NumberInput
                        min={10}
                        max={160}
                        fallback={62}
                        className="h-6 w-[68px] px-1.5 text-xs"
                        value={selected.fontSize ?? 62}
                        onChange={(v) => updateSlot(selected.id, { fontSize: v })}
                      />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[9px] font-medium uppercase text-muted-foreground">Weight</span>
                      <NumberInput
                        min={100}
                        max={900}
                        fallback={700}
                        className="h-6 w-[68px] px-1.5 text-xs"
                        value={selected.fontWeight ?? 700}
                        onChange={(v) => updateSlot(selected.id, { fontWeight: v })}
                      />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[9px] font-medium uppercase text-muted-foreground">Font</span>
                      <Select
                        value={selected.font ?? SLOT_FONTS[0].value}
                        onValueChange={(font) => updateSlot(selected.id, { font })}
                      >
                        <SelectTrigger className="h-6 w-40 px-1.5 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SLOT_FONTS.map((f) => (
                            <SelectItem key={f.value} value={f.value}>
                              <span style={{ fontFamily: f.value }}>{f.label}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[9px] font-medium uppercase text-muted-foreground">Màu</span>
                      <input
                        type="color"
                        className="h-6 w-9 cursor-pointer rounded border border-border bg-transparent"
                        value={selected.color ?? "#1c1c1e"}
                        onChange={(e) => updateSlot(selected.id, { color: e.target.value })}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
