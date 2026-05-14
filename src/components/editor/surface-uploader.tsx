"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { X, Loader2, ImageIcon, Maximize2, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";

interface SurfaceUploaderProps {
  productId: string;
  currentUrl?: string | null;
  onFileSelect: (file: File | null, previewUrl: string) => void;
  pendingFile?: File | null;
  pendingPreview?: string | null;
  uploading?: boolean;
}

export function SurfaceUploader({
  productId,
  currentUrl,
  onFileSelect,
  pendingFile,
  pendingPreview,
  uploading = false,
}: SurfaceUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep refs in sync so the native wheel handler always reads latest values
  zoomRef.current = zoom;
  panRef.current = pan;

  // Reset zoom/pan when dialog closes
  useEffect(() => {
    if (!fullscreenOpen) { setZoom(1); setPan({ x: 0, y: 0 }); }
  }, [fullscreenOpen]);

  // Callback ref — attaches a non-passive wheel listener the instant the
  // dialog viewport mounts (portals render async, so useEffect + ref misses it)
  const viewportCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const el = node; // capture non-null for closure

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      e.stopPropagation();

      const rect = el.getBoundingClientRect();
      // Cursor position relative to the container centre
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;

      const oldZoom = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.min(10, Math.max(0.5, oldZoom * factor));

      // Pin the image point under the cursor
      const ratio = newZoom / oldZoom;
      const oldPan = panRef.current;
      setZoom(newZoom);
      setPan({ x: mx - (mx - oldPan.x) * ratio, y: my - (my - oldPan.y) * ratio });
    }

    el.addEventListener("wheel", onWheel, { passive: false });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isPanning.current = true;
    panStart.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    setPan({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y });
  }, []);

  const handleMouseUp = useCallback(() => { isPanning.current = false; }, []);

  const applyZoom = useCallback((factor: number) => {
    setZoom((z) => {
      const nz = Math.min(10, Math.max(0.5, z * factor));
      setPan((p) => ({ x: p.x * (nz / z), y: p.y * (nz / z) }));
      return nz;
    });
  }, []);

  const zoomIn = () => applyZoom(1.25);
  const zoomOut = () => applyZoom(1 / 1.25);
  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  // Use pending preview if available, otherwise current URL
  const preview = pendingPreview || currentUrl || null;

  const handleFile = useCallback(
    (file: File) => {
      const localUrl = URL.createObjectURL(file);
      onFileSelect(file, localUrl);
    },
    [onFileSelect]
  );

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      handleFile(file);
    }
  }

  function handleRemove() {
    onFileSelect(null, "");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Label>Ảnh Bề Mặt</Label>

      {preview ? (
        <div className="relative rounded-lg overflow-hidden border bg-muted group">
          <img
            src={preview}
            alt="Xem trước bề mặt"
            className="w-full h-32 object-contain bg-black/5"
          />
          {!uploading && (
            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200">
              <button
                onClick={() => setFullscreenOpen(true)}
                className="p-1.5 bg-background/90 rounded-lg text-foreground hover:bg-primary hover:text-primary-foreground cursor-pointer"
                title="Xem toàn màn hình"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              <button
                onClick={handleRemove}
                className="p-1.5 bg-background/90 rounded-lg text-foreground hover:bg-destructive hover:text-destructive-foreground cursor-pointer"
                title="Xóa ảnh"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {uploading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-6 w-6 text-primary animate-spin" />
                <span className="text-xs text-muted-foreground">Đang tải lên...</span>
              </div>
            </div>
          )}
          {pendingFile && !uploading && (
            <div className="absolute bottom-2 left-2 px-2 py-1 bg-amber-500/90 text-amber-950 text-xs rounded font-medium">
              Chưa lưu
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={() => inputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          disabled={uploading}
          className={`w-full h-28 rounded-lg border-2 border-dashed bg-muted/30 flex flex-col items-center justify-center gap-2 transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
            isDragging
              ? "border-primary bg-primary/10"
              : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
          }`}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <ImageIcon className="h-5 w-5 text-primary" />
          </div>
          <span className="text-sm text-muted-foreground">
            {isDragging ? "Thả ảnh vào đây" : "Nhấn hoặc kéo để tải lên"}
          </span>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />

      <p className="text-xs text-muted-foreground">Khuyến nghị: 1141 × 8359</p>

      {/* Fullscreen Dialog */}
      <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] p-0 overflow-hidden">
          <DialogHeader className="p-4 pb-2 flex flex-row items-center justify-between">
            <DialogTitle>Ảnh Bề Mặt</DialogTitle>
            <div className="flex items-center gap-1 mr-8">
              <button
                onClick={zoomOut}
                className="p-1.5 rounded hover:bg-muted transition-colors"
                title="Thu nhỏ"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <span className="text-xs text-muted-foreground w-12 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={zoomIn}
                className="p-1.5 rounded hover:bg-muted transition-colors"
                title="Phóng to"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                onClick={resetZoom}
                className="p-1.5 rounded hover:bg-muted transition-colors"
                title="Đặt lại"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
          </DialogHeader>
          <div
            ref={viewportCallbackRef}
            className="relative overflow-hidden bg-black/5"
            style={{ height: "70vh", cursor: "grab" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {preview && (
              <img
                src={preview}
                alt="Bề mặt toàn màn hình"
                draggable={false}
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`,
                  transformOrigin: "center",
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                  userSelect: "none",
                  transition: isPanning.current ? "none" : "transform 0.1s ease",
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
