"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, RotateCcw, RotateCw, Trash2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uploadBlobToStorage } from "@/lib/supabase/upload";
import type { ShaftConfig, ShaftPreviewImageConfig, ShaftPreviewTextFrame } from "@/types/product";

type ShaftPreviewKey = "standard" | "proLux";

const DEFAULT_FRAME: ShaftPreviewTextFrame = {
  x: 0.72,
  y: 0.56,
  w: 0.2,
  h: 0.08,
  fontSize: 3.2,
  fontWeight: 900,
  rotate: 0,
  color: "#1c1c1e",
  fontFamily: "Poppins, Arial, Helvetica, sans-serif",
};

const EMPTY_PREVIEW: ShaftPreviewImageConfig = {
  imageUrl: null,
  frame: DEFAULT_FRAME,
};

function defaultConfig(): ShaftConfig {
  return {
    version: 1,
    standard: { ...EMPTY_PREVIEW, frame: { ...DEFAULT_FRAME } },
    proLux: { ...EMPTY_PREVIEW, frame: { ...DEFAULT_FRAME } },
  };
}

function normalizeConfig(value: ShaftConfig | null | undefined): ShaftConfig {
  const base = defaultConfig();
  return {
    version: 1,
    standard: {
      imageUrl: value?.standard?.imageUrl ?? null,
      frame: { ...base.standard.frame, ...(value?.standard?.frame ?? {}) },
    },
    proLux: {
      imageUrl: value?.proLux?.imageUrl ?? null,
      frame: { ...base.proLux.frame, ...(value?.proLux?.frame ?? {}) },
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface DragState {
  mode: "move" | "resize" | "rotate";
  startClientX: number;
  startClientY: number;
  startFrame: ShaftPreviewTextFrame;
  stageW: number;
  stageH: number;
  centerClientX: number;
  centerClientY: number;
  startAngle: number;
}

interface ShaftConfigEditorProps {
  productId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: ShaftConfig | null | undefined;
  onSave: (config: ShaftConfig | null) => Promise<void> | void;
}

export function ShaftConfigEditor({ productId, open, onOpenChange, value, onSave }: ShaftConfigEditorProps) {
  const [draft, setDraft] = useState<ShaftConfig>(() => normalizeConfig(value));
  const [active, setActive] = useState<ShaftPreviewKey>("standard");
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<ShaftPreviewKey | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(normalizeConfig(value));
    setActive("standard");
    setImgNatural(null);
  }, [open, value]);

  const preview = draft[active];
  const frame = preview.frame;

  const viewportRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () => setViewport({ w: node.clientWidth, h: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
  }, []);

  const stage = (() => {
    if (!imgNatural || viewport.w === 0 || viewport.h === 0) return { w: 0, h: 0 };
    const scale = Math.min(viewport.w / imgNatural.w, viewport.h / imgNatural.h);
    return { w: imgNatural.w * scale, h: imgNatural.h * scale };
  })();

  function updatePreview(key: ShaftPreviewKey, patch: Partial<ShaftPreviewImageConfig>) {
    setDraft((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        ...patch,
        frame: { ...prev[key].frame, ...(patch.frame ?? {}) },
      },
    }));
  }

  function updateFrame(patch: Partial<ShaftPreviewTextFrame>) {
    updatePreview(active, { frame: patch as ShaftPreviewTextFrame });
  }

  async function uploadImage(file: File) {
    if (!file.type.startsWith("image/")) return;
    setUploading(active);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      const path = `shaft-previews/${productId}/${active}.${ext}`;
      const url = await uploadBlobToStorage(file, path, file.type || "image/png");
      updatePreview(active, { imageUrl: url });
      setImgNatural(null);
    } finally {
      setUploading(null);
    }
  }

  function startDrag(event: React.PointerEvent, mode: DragState["mode"]) {
    if (stage.w === 0 || stage.h === 0) return;
    const frameEl = (event.currentTarget as HTMLElement).closest("[data-shaft-frame]");
    const rect = frameEl?.getBoundingClientRect();
    const centerClientX = rect ? rect.left + rect.width / 2 : event.clientX;
    const centerClientY = rect ? rect.top + rect.height / 2 : event.clientY;
    dragRef.current = {
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startFrame: frame,
      stageW: stage.w,
      stageH: stage.h,
      centerClientX,
      centerClientY,
      startAngle: Math.atan2(event.clientY - centerClientY, event.clientX - centerClientX),
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function onDragMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startClientX) / drag.stageW;
    const dy = (event.clientY - drag.startClientY) / drag.stageH;
    if (drag.mode === "rotate") {
      const angle = Math.atan2(event.clientY - drag.centerClientY, event.clientX - drag.centerClientX);
      const delta = ((angle - drag.startAngle) * 180) / Math.PI;
      updateFrame({ rotate: Math.round(drag.startFrame.rotate + delta) });
      return;
    }
    if (drag.mode === "move") {
      updateFrame({
        x: clamp(drag.startFrame.x + dx, 0, 1 - drag.startFrame.w),
        y: clamp(drag.startFrame.y + dy, 0, 1 - drag.startFrame.h),
      });
      return;
    }
    updateFrame({
      w: clamp(drag.startFrame.w + dx, 0.03, 1 - drag.startFrame.x),
      h: clamp(drag.startFrame.h + dy, 0.02, 1 - drag.startFrame.y),
    });
  }

  function endDrag() {
    dragRef.current = null;
  }

  async function handleSave() {
    const hasAnyImage = Boolean(draft.standard.imageUrl || draft.proLux.imageUrl);
    setSaving(true);
    try {
      await onSave(hasAnyImage ? draft : null);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  const activeLabel = active === "standard" ? "Standard" : "Pro / Premium / Lux";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] max-w-6xl flex-col gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>Shaft engraving preview slot</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {(["standard", "proLux"] as ShaftPreviewKey[]).map((key) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={active === key ? "default" : "outline"}
              onClick={() => {
                setActive(key);
                setImgNatural(null);
              }}
            >
              {key === "standard" ? "Standard image" : "Pro/Lux image"}
            </Button>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading === active}>
            <Upload className="mr-1.5 h-4 w-4" />
            {uploading === active ? "Uploading..." : `Upload ${activeLabel}`}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => updateFrame(DEFAULT_FRAME)}>
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Reset frame
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => updatePreview(active, { imageUrl: null })}>
            <Trash2 className="mr-1.5 h-4 w-4" />
            Clear image
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadImage(file);
            }}
          />
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_280px]">
          <div ref={viewportRef} className="relative min-h-[360px] overflow-hidden rounded-lg border bg-zinc-950/5">
            {!preview.imageUrl ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground hover:bg-muted/30"
              >
                <ImageIcon className="h-10 w-10" />
                Upload the {activeLabel} laser preview image
              </button>
            ) : (
              <div
                className="absolute left-1/2 top-1/2"
                style={{
                  width: `${stage.w}px`,
                  height: `${stage.h}px`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview.imageUrl}
                  alt={activeLabel}
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-contain"
                  onLoad={(event) => {
                    const img = event.currentTarget;
                    setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
                  }}
                />
                {stage.w > 0 && (
                  <div
                    data-shaft-frame
                    className="absolute flex cursor-move items-center justify-start rounded-sm border-2 border-dashed border-lime-300 bg-lime-300/15 px-[2%] shadow-[0_0_14px_rgba(190,242,100,0.45)]"
                    style={{
                      left: `${frame.x * 100}%`,
                      top: `${frame.y * 100}%`,
                      width: `${frame.w * 100}%`,
                      height: `${frame.h * 100}%`,
                      transform: `rotate(${frame.rotate}deg)`,
                      transformOrigin: "center",
                    }}
                    onPointerDown={(event) => startDrag(event, "move")}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    <span className="pointer-events-none block w-full overflow-hidden text-left leading-none">
                      <span
                        className="inline-block max-w-full whitespace-nowrap"
                        style={{
                          color: frame.color,
                          fontFamily: "Poppins, Arial, Helvetica, sans-serif",
                          fontSize: `${(frame.fontSize / 100) * stage.w}px`,
                          fontWeight: frame.fontWeight || DEFAULT_FRAME.fontWeight,
                          letterSpacing: "0.04em",
                          transform: "scaleX(1.14)",
                          transformOrigin: "left center",
                        }}
                      >
                        YOUR NAME
                      </span>
                    </span>
                    <button
                      type="button"
                      className="absolute left-1/2 top-0 flex h-7 w-7 -translate-x-1/2 -translate-y-[calc(100%+10px)] cursor-grab items-center justify-center rounded-full border-2 border-white bg-lime-400 text-lime-950 shadow"
                      title="Drag to rotate frame"
                      onPointerDown={(event) => startDrag(event, "rotate")}
                      onPointerMove={onDragMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    >
                      <RotateCw className="h-4 w-4" />
                    </button>
                    <div className="absolute left-1/2 top-0 h-2.5 w-px -translate-x-1/2 -translate-y-2.5 bg-lime-300" />
                    <div
                      className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-white bg-lime-500"
                      onPointerDown={(event) => startDrag(event, "resize")}
                      onPointerMove={onDragMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">Frame position</p>
              <p className="text-xs text-muted-foreground">Values are percent of the preview image.</p>
            </div>
            {(["x", "y", "w", "h"] as const).map((field) => (
              <label key={field} className="grid grid-cols-[42px_1fr_58px] items-center gap-2 text-sm">
                <span className="font-medium uppercase">{field}</span>
                <input
                  type="range"
                  min={0}
                  max={field === "w" || field === "h" ? 100 : 97}
                  step={0.1}
                  value={Math.round(frame[field] * 1000) / 10}
                  onChange={(event) => {
                    const pct = Number(event.target.value) / 100;
                    if (field === "x") updateFrame({ x: clamp(pct, 0, 1 - frame.w) });
                    if (field === "y") updateFrame({ y: clamp(pct, 0, 1 - frame.h) });
                    if (field === "w") updateFrame({ w: clamp(pct, 0.03, 1 - frame.x) });
                    if (field === "h") updateFrame({ h: clamp(pct, 0.02, 1 - frame.y) });
                  }}
                />
                <Input
                  className="h-8 px-2 text-xs"
                  value={(frame[field] * 100).toFixed(1)}
                  onChange={(event) => {
                    const pct = Number(event.target.value) / 100;
                    if (!Number.isFinite(pct)) return;
                    if (field === "x") updateFrame({ x: clamp(pct, 0, 1 - frame.w) });
                    if (field === "y") updateFrame({ y: clamp(pct, 0, 1 - frame.h) });
                    if (field === "w") updateFrame({ w: clamp(pct, 0.03, 1 - frame.x) });
                    if (field === "h") updateFrame({ h: clamp(pct, 0.02, 1 - frame.y) });
                  }}
                />
              </label>
            ))}

            <label className="grid grid-cols-[72px_1fr] items-center gap-2 text-sm">
              <span className="font-medium">Size</span>
              <Input
                type="number"
                min={0.5}
                max={20}
                step={0.1}
                value={frame.fontSize}
                onChange={(event) => updateFrame({ fontSize: Number(event.target.value) || DEFAULT_FRAME.fontSize })}
              />
            </label>
            <label className="grid grid-cols-[72px_1fr] items-center gap-2 text-sm">
              <span className="font-medium">Weight</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={frame.fontWeight || DEFAULT_FRAME.fontWeight}
                onChange={(event) => updateFrame({ fontWeight: Number(event.target.value) || DEFAULT_FRAME.fontWeight })}
              >
                {[300, 400, 500, 600, 700, 800, 900].map((weight) => (
                  <option key={weight} value={weight}>
                    {weight}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid grid-cols-[72px_1fr] items-center gap-2 text-sm">
              <span className="font-medium">Rotate</span>
              <Input
                type="number"
                min={-90}
                max={90}
                step={1}
                value={frame.rotate}
                onChange={(event) => updateFrame({ rotate: Number(event.target.value) || 0 })}
              />
            </label>
            <label className="grid grid-cols-[72px_1fr] items-center gap-2 text-sm">
              <span className="font-medium">Color</span>
              <input
                type="color"
                className="h-9 w-full cursor-pointer rounded border bg-transparent"
                value={frame.color}
                onChange={(event) => updateFrame({ color: event.target.value })}
              />
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving || Boolean(uploading)}>
            {saving ? "Saving..." : "Save shaft config"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
