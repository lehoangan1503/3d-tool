"use client";

import { useState, useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Images, Trash2, Link2, Link2Off, Check, Palette, Blend, Layers, RotateCcw } from "lucide-react";
import type { ImageFrame, ObjectFit, ImageGradient } from "@/types/extractor";
import {
  imageGradientToCss,
  DEFAULT_GRADIENT,
  surfaceFrameTransform,
  DEFAULT_SURFACE_PAN,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
} from "@/types/extractor";
import { ImagePickerDialog } from "./image-picker-dialog";
import { GradientPickerDialog } from "./gradient-picker-dialog";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";

interface ImageFrameControlsProps {
  frame: ImageFrame;
  onFrameChange: (frame: ImageFrame) => void;
  /** Current product's flat surface design URL (for the dynamic-surface mode). */
  productSurfaceUrl?: string | null;
  canvasWidth?: number;
  canvasHeight?: number;
}

const OBJECT_FIT_OPTIONS: { value: ObjectFit; label: string }[] = [
  { value: 'cover', label: 'Phủ' },
  { value: 'contain', label: 'Vừa khung' },
  { value: 'custom', label: 'Tùy chỉnh' },
];

export function ImageFrameControls({
  frame,
  onFrameChange,
  productSurfaceUrl,
  canvasWidth = DEFAULT_CANVAS_WIDTH,
  canvasHeight = DEFAULT_CANVAS_HEIGHT,
}: ImageFrameControlsProps) {
  const [linkedDimensions, setLinkedDimensions] = useState(frame.imageSettings.objectFit !== 'custom');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [gradientPickerOpen, setGradientPickerOpen] = useState(false);

  const { imageSettings, transform } = frame;
  const isDynamicSurface = imageSettings.dynamicSurface ?? false;

  const updateImageSettings = useCallback((updates: Partial<typeof imageSettings>) => {
    onFrameChange({
      ...frame,
      imageSettings: { ...imageSettings, ...updates },
    });
  }, [frame, imageSettings, onFrameChange]);

  const updateTransform = useCallback((updates: Partial<typeof transform>) => {
    onFrameChange({
      ...frame,
      transform: { ...transform, ...updates },
    });
  }, [frame, transform, onFrameChange]);

  const handleObjectFitChange = useCallback((value: ObjectFit) => {
    setLinkedDimensions(value !== 'custom');
    updateImageSettings({ objectFit: value });
  }, [updateImageSettings]);

  const handleWidthChange = useCallback((width: number) => {
    if (linkedDimensions) {
      const aspectRatio = transform.width / transform.height;
      updateTransform({ width, height: Math.round(width / aspectRatio) });
    } else {
      updateTransform({ width });
    }
  }, [linkedDimensions, transform, updateTransform]);

  const handleHeightChange = useCallback((height: number) => {
    if (linkedDimensions) {
      const aspectRatio = transform.width / transform.height;
      updateTransform({ width: Math.round(height * aspectRatio), height });
    } else {
      updateTransform({ height });
    }
  }, [linkedDimensions, transform, updateTransform]);

  const handleRemoveImage = useCallback(() => {
    updateImageSettings({ imageUrl: null });
  }, [updateImageSettings]);

  // Dynamic-surface frame width: user sets WIDTH; height auto-keeps the canvas
  // (root frame) aspect ratio so the frame stays a valid full frame. The frame
  // stays anchored to the canvas origin (0,0). Height input is read-only.
  const handleSurfaceWidthChange = useCallback((width: number) => {
    const w = Math.max(50, Math.min(canvasWidth, Math.round(width)));
    const ratio = canvasHeight / (canvasWidth || 1);
    updateTransform({ x: 0, y: 0, width: w, height: Math.round(w * ratio) });
  }, [canvasWidth, canvasHeight, updateTransform]);

  // Toggle "Ảnh động Surface": render this product's flat surface into the frame
  // at export time instead of a static image. The frame is locked to the full
  // canvas (2048×2048); the user pans/zooms the surface image inside it.
  const handleToggleDynamicSurface = useCallback(() => {
    if (isDynamicSurface) {
      updateImageSettings({ dynamicSurface: false });
      return;
    }
    onFrameChange({
      ...frame,
      imageSettings: {
        ...frame.imageSettings,
        dynamicSurface: true,
        imageUrl: null,
        objectFit: "cover",
        surfacePan: { ...DEFAULT_SURFACE_PAN },
      },
      transform: surfaceFrameTransform(canvasWidth, canvasHeight),
    });
  }, [isDynamicSurface, updateImageSettings, onFrameChange, frame, canvasWidth, canvasHeight]);

  const surfacePan = imageSettings.surfacePan ?? DEFAULT_SURFACE_PAN;
  const updateSurfacePan = useCallback((updates: Partial<typeof surfacePan>) => {
    updateImageSettings({ surfacePan: { ...surfacePan, ...updates } });
  }, [surfacePan, updateImageSettings]);

  const bgEnabled = imageSettings.backgroundEnabled ?? true;
  const imageOpacity = imageSettings.imageOpacity ?? imageSettings.opacity ?? 1;
  const backgroundOpacity = imageSettings.backgroundOpacity ?? 1;

  return (
    <div className="space-y-4">
      {/* Image Picker Dialog */}
      <ImagePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(url) => updateImageSettings({ imageUrl: url })}
        currentUrl={imageSettings.imageUrl}
      />

      {/* Image Upload */}
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
            {imageSettings.imageUrl && !isDynamicSurface ? "Thay thế ảnh" : "Chọn ảnh"}
          </Button>
          {imageSettings.imageUrl && !isDynamicSurface && (
            <Button variant="outline" size="sm" onClick={handleRemoveImage}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* Dynamic surface: render the current product's surface into this frame.
            Disabled when the product has no surface — there'd be nothing to render. */}
        <Button
          variant={isDynamicSurface ? "default" : "outline"}
          size="sm"
          className="w-full"
          onClick={handleToggleDynamicSurface}
          disabled={!isDynamicSurface && !productSurfaceUrl}
          title={!isDynamicSurface && !productSurfaceUrl ? "Sản phẩm chưa có surface" : undefined}
        >
          <Layers className="h-3.5 w-3.5 mr-2" />
          {isDynamicSurface ? "Đang dùng Surface động ✓" : "Ảnh động Surface"}
        </Button>

        {isDynamicSurface ? (
          <div className="rounded border overflow-hidden bg-muted/30">
            {productSurfaceUrl ? (
              <img
                src={resolveStorageUrl(productSurfaceUrl)!}
                alt="Surface sản phẩm"
                className="w-full h-16 object-cover"
              />
            ) : (
              <div className="w-full h-16 flex items-center justify-center text-[10px] text-muted-foreground px-2 text-center">
                Sản phẩm chưa có surface — sẽ render theo từng sản phẩm khi xuất.
              </div>
            )}
            <p className="text-[10px] text-muted-foreground px-2 py-1">
              Mỗi sản phẩm sẽ render surface riêng khi xuất ảnh.
            </p>
          </div>
        ) : (
          imageSettings.imageUrl && (
            <div className="rounded border overflow-hidden bg-muted/30">
              <img
                src={resolveStorageUrl(imageSettings.imageUrl)!}
                alt="Xem trước"
                className="w-full h-16 object-cover"
              />
            </div>
          )
        )}
      </div>

      {/* Dynamic-surface pan / zoom — the frame is fixed; move the image inside it.
          Kéo trực tiếp trong khung để di chuyển, lăn chuột để zoom. */}
      {isDynamicSurface && (
        <div className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-2.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium text-muted-foreground">Vị trí surface trong khung</Label>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => updateImageSettings({ surfacePan: { ...DEFAULT_SURFACE_PAN } })}
            >
              <RotateCcw className="h-3 w-3 mr-1" /> Đặt lại
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">Mặc định: ảnh rộng bằng khung, đáy ảnh trùng đáy khung. Kéo ảnh để di chuyển · lăn chuột để zoom.</p>

          {/* Zoom — slider + nhập số (%) */}
          <div className="space-y-1">
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Phóng to</span>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  value={Math.round(surfacePan.scale * 100)}
                  onChange={(e) => updateSurfacePan({ scale: Math.max(0.1, Math.min(10, Number(e.target.value) / 100)) })}
                  min={10}
                  max={1000}
                  className="h-6 w-16 text-xs px-1.5 text-right"
                />
                <span className="text-muted-foreground">%</span>
              </div>
            </div>
            <Slider
              value={[surfacePan.scale * 100]}
              onValueChange={([v]) => updateSurfacePan({ scale: v / 100 })}
              min={10}
              max={1000}
              step={1}
            />
            <p className="text-[10px] text-muted-foreground">100% = ảnh rộng bằng khung. Tăng để phóng to (tối đa 1000%).</p>
          </div>

          {/* Horizontal offset — slider + nhập số (%) */}
          <div className="space-y-1">
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Ngang (X)</span>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  value={Math.round(surfacePan.x * 100)}
                  onChange={(e) => updateSurfacePan({ x: Math.max(-3, Math.min(3, Number(e.target.value) / 100)) })}
                  min={-300}
                  max={300}
                  className="h-6 w-16 text-xs px-1.5 text-right"
                />
                <span className="text-muted-foreground">%</span>
              </div>
            </div>
            <Slider
              value={[surfacePan.x * 100]}
              onValueChange={([v]) => updateSurfacePan({ x: v / 100 })}
              min={-300}
              max={300}
              step={1}
            />
          </div>

          {/* Vertical offset — slider + nhập số (%) */}
          <div className="space-y-1">
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Dọc (Y)</span>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  value={Math.round(surfacePan.y * 100)}
                  onChange={(e) => updateSurfacePan({ y: Math.max(-3, Math.min(3, Number(e.target.value) / 100)) })}
                  min={-300}
                  max={300}
                  className="h-6 w-16 text-xs px-1.5 text-right"
                />
                <span className="text-muted-foreground">%</span>
              </div>
            </div>
            <Slider
              value={[surfacePan.y * 100]}
              onValueChange={([v]) => updateSurfacePan({ y: v / 100 })}
              min={-300}
              max={300}
              step={1}
            />
          </div>
        </div>
      )}

      {/* Image Opacity */}
      {imageSettings.imageUrl && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <Label className="font-medium text-muted-foreground">Độ mờ ảnh</Label>
            <span className="text-muted-foreground">{Math.round(imageOpacity * 100)}%</span>
          </div>
          <Slider
            value={[imageOpacity * 100]}
            onValueChange={([v]) => updateImageSettings({ imageOpacity: v / 100 })}
            min={0}
            max={100}
            step={1}
          />
        </div>
      )}

      {/* Image Fit */}
      {imageSettings.imageUrl && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Khớp ảnh</Label>
          <Select value={imageSettings.objectFit} onValueChange={handleObjectFitChange}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OBJECT_FIT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Background — Color / Gradient */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium text-muted-foreground">Nền</Label>
          <button
            type="button"
            onClick={() => updateImageSettings({ backgroundEnabled: !bgEnabled })}
            className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
              bgEnabled
                ? "bg-primary border-primary text-primary-foreground"
                : "border-muted-foreground/40 hover:border-muted-foreground"
            }`}
            title={bgEnabled ? "Xóa nền" : "Thêm nền"}
          >
            {bgEnabled && <Check className="w-3 h-3" />}
          </button>
        </div>
        {bgEnabled && (
          <div className="space-y-2">
            {/* Tabs: Color | Gradient */}
            <div className="flex rounded-md border border-border text-xs overflow-hidden">
              <button
                type="button"
                className={`flex-1 flex items-center justify-center gap-1 py-1.5 transition-colors ${
                  (imageSettings.backgroundType ?? "color") === "color"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                }`}
                onClick={() => updateImageSettings({ backgroundType: "color" })}
              >
                <Palette className="w-3 h-3" /> Màu sắc
              </button>
              <button
                type="button"
                className={`flex-1 flex items-center justify-center gap-1 py-1.5 transition-colors ${
                  imageSettings.backgroundType === "gradient"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                }`}
                onClick={() => updateImageSettings({
                  backgroundType: "gradient",
                  ...(!imageSettings.backgroundGradient ? { backgroundGradient: DEFAULT_GRADIENT } : {}),
                })}
              >
                <Blend className="w-3 h-3" /> Độ chuyển màu
              </button>
            </div>

            {(imageSettings.backgroundType ?? "color") === "color" ? (
              /* ── Color picker ── */
              <div className="flex gap-2">
                <Input
                  type="color"
                  value={imageSettings.backgroundColor}
                  onChange={(e) => updateImageSettings({ backgroundColor: e.target.value })}
                  className="w-10 h-8 p-0.5 cursor-pointer"
                />
                <Input
                  type="text"
                  value={imageSettings.backgroundColor}
                  onChange={(e) => updateImageSettings({ backgroundColor: e.target.value })}
                  className="flex-1 h-8 font-mono text-xs"
                  placeholder="#2a2a2a"
                />
              </div>
            ) : (
              /* ── Gradient picker ── */
              <div className="space-y-2">
                <button
                  type="button"
                  className="w-full h-10 rounded-md border border-border overflow-hidden hover:border-primary/60 transition-colors"
                  onClick={() => setGradientPickerOpen(true)}
                  title="Chọn độ chuyển màu"
                >
                  <div
                    className="w-full h-full"
                    style={{
                      background: imageSettings.backgroundGradient
                        ? imageGradientToCss(imageSettings.backgroundGradient)
                        : "linear-gradient(90deg, #667eea, #764ba2)",
                    }}
                  />
                </button>
                {imageSettings.backgroundGradient && (
                  <p className="text-[10px] text-muted-foreground text-center truncate">
                    {imageSettings.backgroundGradient.name}
                  </p>
                )}
                {/* Angle slider */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Góc</span>
                    <span className="text-muted-foreground">{imageSettings.backgroundGradient?.angle ?? 90}°</span>
                  </div>
                  <Slider
                    value={[imageSettings.backgroundGradient?.angle ?? 90]}
                    onValueChange={([v]) => {
                      const current = imageSettings.backgroundGradient ?? {
                        name: "Default",
                        colors: ["#667eea", "#764ba2"],
                        angle: 90,
                      };
                      updateImageSettings({ backgroundGradient: { ...current, angle: v } });
                    }}
                    min={0}
                    max={360}
                    step={1}
                  />
                </div>
              </div>
            )}

            {/* Opacity — shared by both modes */}
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Độ mờ</span>
                <span className="text-muted-foreground">{Math.round(backgroundOpacity * 100)}%</span>
              </div>
              <Slider
                value={[backgroundOpacity * 100]}
                onValueChange={([v]) => updateImageSettings({ backgroundOpacity: v / 100 })}
                min={0}
                max={100}
                step={1}
              />
            </div>
          </div>
        )}
      </div>

      {/* Gradient Picker Dialog */}
      <GradientPickerDialog
        open={gradientPickerOpen}
        onClose={() => setGradientPickerOpen(false)}
        onSelect={(g) => updateImageSettings({ backgroundType: "gradient", backgroundGradient: g })}
        currentAngle={imageSettings.backgroundGradient?.angle ?? 90}
      />

      {/* Dynamic-surface frame size: width editable, height auto from canvas ratio. */}
      {isDynamicSurface && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Kích thước khung</Label>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs text-muted-foreground">W</Label>
              <Input
                type="number"
                value={transform.width}
                onChange={(e) => handleSurfaceWidthChange(Number(e.target.value))}
                min={50}
                max={canvasWidth}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">H (tự động)</Label>
              <Input
                type="number"
                value={transform.height}
                readOnly
                disabled
                className="h-8 opacity-60"
                title="Chiều cao tự động theo tỉ lệ khung"
              />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">Chiều cao tự tính theo tỉ lệ khung gốc ({canvasWidth}×{canvasHeight}).</p>
        </div>
      )}

      {/* Dimensions — hidden for dynamic surface (frame is locked to the canvas). */}
      {!isDynamicSurface && (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium text-muted-foreground">Kích thước</Label>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5"
            onClick={() => setLinkedDimensions(!linkedDimensions)}
            disabled={imageSettings.objectFit !== 'custom'}
          >
            {linkedDimensions ? <Link2 className="h-3 w-3" /> : <Link2Off className="h-3 w-3" />}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-muted-foreground">W</Label>
            <Input
              type="number"
              value={transform.width}
              onChange={(e) => handleWidthChange(Number(e.target.value))}
              min={50}
              max={2048}
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">H</Label>
            <Input
              type="number"
              value={transform.height}
              onChange={(e) => handleHeightChange(Number(e.target.value))}
              min={50}
              max={2048}
              className="h-8"
            />
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
