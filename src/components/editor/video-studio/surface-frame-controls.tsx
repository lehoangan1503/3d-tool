"use client";

import { useState, useCallback, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import {
  Eye,
  EyeOff,
  Trash2,
  Images,
  Palette,
  Blend,
  Check,
  ChevronDown,
  ChevronUp,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import type { BackgroundFrame } from "@/types/video-studio";
import { ImagePickerDialog } from "../image-picker-dialog";
import { GradientPickerDialog } from "../gradient-picker-dialog";
import type { ImageGradient } from "@/types/extractor";
import { imageGradientToCss, DEFAULT_GRADIENT } from "@/types/extractor";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";

// ─── SurfaceFrameControls ─────────────────────────────────────────────────────

export interface SurfaceFrameControlsProps {
  frame: BackgroundFrame;
  onChange: (frame: BackgroundFrame) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}

export function SurfaceFrameControls({
  frame,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: SurfaceFrameControlsProps) {
  const [expanded, setExpanded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [gradientPickerOpen, setGradientPickerOpen] = useState(false);
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null);

  // Load image to get natural dimensions for display
  useEffect(() => {
    if (!frame.imageUrl) { setImageDims(null); return; }
    const img = new Image();
    img.onload = () => setImageDims({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setImageDims(null);
    img.src = resolveStorageUrl(frame.imageUrl) ?? frame.imageUrl;
  }, [frame.imageUrl]);

  const patch = useCallback(
    (partial: Partial<BackgroundFrame>) => onChange({ ...frame, ...partial }),
    [frame, onChange]
  );

  const bgEnabled = frame.backgroundEnabled ?? true;
  const bgType = frame.backgroundType ?? "color";
  const imageOpacity = frame.imageOpacity ?? 1;
  const bgOpacity = frame.backgroundOpacity ?? 1;
  const bgGradient = frame.backgroundGradient as ImageGradient | undefined;

  // Preview swatch for the header
  const previewStyle: React.CSSProperties = frame.imageUrl
    ? { backgroundImage: `url(${resolveStorageUrl(frame.imageUrl)})`, backgroundSize: "cover", backgroundPosition: "center" }
    : bgEnabled && bgType === "gradient" && bgGradient
    ? { background: imageGradientToCss(bgGradient) }
    : { backgroundColor: frame.backgroundColor ?? "#1a1a1a" };

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-card/30">
      <ImagePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(url) => {
          // Load image to get natural dimensions, then auto-set frame AR
          const img = new Image();
          img.onload = () => {
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              const ar = img.naturalHeight / img.naturalWidth;
              // Keep width, adjust height to match image aspect ratio
              const wallAr = 24 / 34; // wall height/width ratio
              const newHeight = (frame.width * 34 * ar) / 24;
              patch({ imageUrl: url, backgroundEnabled: false, height: Math.min(2, Math.max(0.05, newHeight)) });
            } else {
              patch({ imageUrl: url, backgroundEnabled: false });
            }
          };
          img.onerror = () => patch({ imageUrl: url, backgroundEnabled: false });
          const resolved = resolveStorageUrl(url);
          img.src = resolved ?? url;
        }}
        currentUrl={frame.imageUrl}
      />
      <GradientPickerDialog
        open={gradientPickerOpen}
        onClose={() => setGradientPickerOpen(false)}
        onSelect={(g: ImageGradient) =>
          patch({ backgroundType: "gradient", backgroundGradient: g })
        }
        currentAngle={bgGradient?.angle ?? 90}
      />

      {/* ── Header ── */}
      <div
        className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/30"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Swatch */}
        <div
          className="h-4 w-4 shrink-0 rounded border border-border/40"
          style={previewStyle}
        />
        <span className="text-xs font-medium flex-1">Khung nền</span>

        {/* Visibility */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={(e) => {
            e.stopPropagation();
            patch({ enabled: !frame.enabled });
          }}
        >
          {frame.enabled ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </Button>

        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}

        <Button variant="ghost" size="icon" className="h-6 w-6" disabled={isFirst} onClick={(e) => { e.stopPropagation(); onMoveUp(); }}>
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" disabled={isLast} onClick={(e) => { e.stopPropagation(); onMoveDown(); }}>
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-destructive/70 hover:text-destructive"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── Expanded section ── */}
      {expanded && (
        <div className="space-y-4 border-t border-border/30 px-3 pb-3 pt-3">

          {/* ── Image ── */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">Ảnh</Label>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setPickerOpen(true)}
              >
                <Images className="h-3.5 w-3.5 mr-2" />
                {frame.imageUrl ? "Thay thế ảnh" : "Chọn ảnh"}
              </Button>
              {frame.imageUrl && (
                <Button variant="outline" size="sm" onClick={() => patch({ imageUrl: null })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {frame.imageUrl && (
              <div className="rounded border overflow-hidden bg-muted/30">
                <img
                  src={resolveStorageUrl(frame.imageUrl)!}
                  alt="Xem trước"
                  className="w-full h-16 object-cover"
                />
                {imageDims && (
                  <div className="px-2 py-1 text-xs text-muted-foreground text-center border-t border-border/30">
                    {imageDims.w} × {imageDims.h}px
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Image opacity */}
          {frame.imageUrl && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <Label className="font-medium text-muted-foreground">Độ mờ ảnh</Label>
                <span className="text-muted-foreground">{Math.round(imageOpacity * 100)}%</span>
              </div>
              <Slider
                value={[imageOpacity * 100]}
                onValueChange={([v]) => patch({ imageOpacity: v / 100 })}
                min={0}
                max={100}
                step={1}
              />
            </div>
          )}

          {/* ── Background ── */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-muted-foreground">Nền</Label>
              <button
                type="button"
                onClick={() => patch({ backgroundEnabled: !bgEnabled })}
                className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                  bgEnabled
                    ? "bg-primary border-primary text-primary-foreground"
                    : "border-muted-foreground/40 hover:border-muted-foreground"
                }`}
              >
                {bgEnabled && <Check className="w-3 h-3" />}
              </button>
            </div>
            {bgEnabled && (
              <div className="space-y-2">
                {/* Color / Gradient toggle */}
                <div className="flex rounded-md border border-border text-xs overflow-hidden">
                  <button
                    type="button"
                    className={`flex-1 flex items-center justify-center gap-1 py-1.5 transition-colors ${
                      bgType === "color"
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    }`}
                    onClick={() => patch({ backgroundType: "color" })}
                  >
                    <Palette className="w-3 h-3" /> Màu sắc
                  </button>
                  <button
                    type="button"
                    className={`flex-1 flex items-center justify-center gap-1 py-1.5 transition-colors ${
                      bgType === "gradient"
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    }`}
                    onClick={() =>
                      patch({
                        backgroundType: "gradient",
                        ...(!bgGradient ? { backgroundGradient: DEFAULT_GRADIENT } : {}),
                      })
                    }
                  >
                    <Blend className="w-3 h-3" /> Chuyển màu
                  </button>
                </div>

                {bgType === "color" ? (
                  <div className="flex gap-2">
                    <Input
                      type="color"
                      value={frame.backgroundColor ?? "#1a1a1a"}
                      onChange={(e) => patch({ backgroundColor: e.target.value })}
                      className="w-10 h-8 p-0.5 cursor-pointer"
                    />
                    <Input
                      type="text"
                      value={frame.backgroundColor ?? "#1a1a1a"}
                      onChange={(e) => patch({ backgroundColor: e.target.value })}
                      className="flex-1 h-8 font-mono text-xs"
                      placeholder="#1a1a1a"
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <button
                      type="button"
                      className="w-full h-10 rounded-md border border-border overflow-hidden hover:border-primary/60 transition-colors"
                      onClick={() => setGradientPickerOpen(true)}
                    >
                      <div
                        className="w-full h-full"
                        style={{
                          background: bgGradient
                            ? imageGradientToCss(bgGradient)
                            : "linear-gradient(90deg, #667eea, #764ba2)",
                        }}
                      />
                    </button>
                    {bgGradient && (
                      <p className="text-[10px] text-muted-foreground text-center truncate">
                        {bgGradient.name}
                      </p>
                    )}
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Góc</span>
                        <span className="text-muted-foreground">{bgGradient?.angle ?? 90}°</span>
                      </div>
                      <Slider
                        value={[bgGradient?.angle ?? 90]}
                        onValueChange={([v]) =>
                          patch({ backgroundGradient: { ...(bgGradient ?? DEFAULT_GRADIENT), angle: v } })
                        }
                        min={0}
                        max={360}
                        step={1}
                      />
                    </div>
                  </div>
                )}

                {/* Background opacity */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Độ mờ nền</span>
                    <span className="text-muted-foreground">{Math.round(bgOpacity * 100)}%</span>
                  </div>
                  <Slider
                    value={[bgOpacity * 100]}
                    onValueChange={([v]) => patch({ backgroundOpacity: v / 100 })}
                    min={0}
                    max={100}
                    step={1}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── Transform ── */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">Vị trí & Kích thước</Label>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">X</span>
                  <span className="text-muted-foreground">{frame.x.toFixed(2)}</span>
                </div>
                <Slider value={[frame.x]} min={0} max={1} step={0.01} onValueChange={([v]) => patch({ x: v })} />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Y</span>
                  <span className="text-muted-foreground">{frame.y.toFixed(2)}</span>
                </div>
                <Slider value={[frame.y]} min={0} max={1} step={0.01} onValueChange={([v]) => patch({ y: v })} />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Rộng</span>
                  <span className="text-muted-foreground">{Math.round(frame.width * 2048)}px</span>
                </div>
                <Slider value={[frame.width]} min={0.05} max={2} step={0.005} onValueChange={([v]) => patch({ width: v })} />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Cao</span>
                  <span className="text-muted-foreground">{Math.round(frame.height * 2048)}px</span>
                </div>
                <Slider value={[frame.height]} min={0.05} max={2} step={0.005} onValueChange={([v]) => patch({ height: v })} />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Xoay</span>
                <span className="text-muted-foreground">{frame.rotation}°</span>
              </div>
              <Slider value={[frame.rotation]} min={0} max={360} step={1} onValueChange={([v]) => patch({ rotation: v })} />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Độ mờ khung</span>
                <span className="text-muted-foreground">{Math.round(frame.opacity * 100)}%</span>
              </div>
              <Slider value={[frame.opacity * 100]} min={0} max={100} step={1} onValueChange={([v]) => patch({ opacity: v / 100 })} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
