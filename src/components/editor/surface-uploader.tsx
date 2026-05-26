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
import { cn } from "@/lib/utils";
import { detectCmykJpeg, convertCmykToRgb } from "@/lib/image/cmyk-detection";

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

  // CMYK detection state
  const [colorSpace, setColorSpace] = useState<"rgb" | "cmyk" | "detecting" | null>(null);
  const [originalCmykUrl, setOriginalCmykUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"original" | "converted">("converted");
  const isDetectingRef = useRef(false);
  const detectionIdRef = useRef(0);
  const prevPendingFileRef = useRef<File | null | undefined>(undefined);
  const rgbConvertedUrlRef = useRef<string | null>(null);
  const originalCmykUrlRef = useRef<string | null>(null);

  // For existing URL detection (silent background check, no overlay)
  const detectedUrlRef = useRef<string | null>(null);
  const existingDetectionGenRef = useRef(0);

  // Keep refs in sync so the native wheel handler always reads latest values
  zoomRef.current = zoom;
  panRef.current = pan;

  // Reset zoom/pan when dialog closes
  useEffect(() => {
    if (!fullscreenOpen) { setZoom(1); setPan({ x: 0, y: 0 }); }
  }, [fullscreenOpen]);

  // Reset color state when the pending file transitions from a File → null (save completed)
  useEffect(() => {
    if (prevPendingFileRef.current instanceof File && pendingFile == null) {
      if (originalCmykUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(originalCmykUrlRef.current);
        originalCmykUrlRef.current = null;
      }
      if (rgbConvertedUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(rgbConvertedUrlRef.current);
        rgbConvertedUrlRef.current = null;
      }
      setColorSpace(null);
      setOriginalCmykUrl(null);
      setActiveTab("converted");
    }
    prevPendingFileRef.current = pendingFile ?? null;
  }, [pendingFile]); // Only pendingFile — reads blob URLs from refs (always current)

  // Revoke any blob URLs on unmount to prevent leaks
  useEffect(() => {
    return () => {
      if (originalCmykUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(originalCmykUrlRef.current);
      }
      if (rgbConvertedUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(rgbConvertedUrlRef.current);
      }
    };
  }, []);

  // Silently detect color space of the already-saved surface image.
  // Runs when currentUrl changes or pendingFile clears (e.g. after remove).
  // Does NOT set "detecting" state to avoid hiding controls.
  useEffect(() => {
    // If a new file is pending, handleFile manages colorSpace — don't interfere
    if (pendingFile != null || !currentUrl) return;
    // Already detected this exact URL — skip
    if (detectedUrlRef.current === currentUrl) return;

    const myGen = ++existingDetectionGenRef.current;
    const controller = new AbortController();

    // async/await + try/catch keeps the AbortError local — never reaches the
    // global unhandled-rejection handler that powers the Next.js dev overlay.
    (async () => {
      try {
        const r = await fetch(currentUrl, { signal: controller.signal });
        const blob = await r.blob();

        if (myGen !== existingDetectionGenRef.current) return;

        const isJpeg = blob.type === "image/jpeg" || blob.type === "image/jpg";
        if (!isJpeg) {
          detectedUrlRef.current = currentUrl;
          setColorSpace("rgb");
          return;
        }

        const file = new File([blob], "surface.jpg", { type: blob.type });
        const isCmyk = await detectCmykJpeg(file);

        if (myGen !== existingDetectionGenRef.current) return;
        detectedUrlRef.current = currentUrl;
        setColorSpace(isCmyk ? "cmyk" : "rgb");
      } catch (err) {
        if ((err as Error).name === "AbortError") return; // intentional cleanup
        if (myGen !== existingDetectionGenRef.current) return;
        detectedUrlRef.current = currentUrl;
        setColorSpace("rgb"); // safe fallback
      }
    })();

    return () => controller.abort();
  }, [currentUrl, pendingFile]);

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
      const newZoom = Math.min(40, Math.max(0.5, oldZoom * factor));

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
      const nz = Math.min(40, Math.max(0.5, z * factor));
      setPan((p) => ({ x: p.x * (nz / z), y: p.y * (nz / z) }));
      return nz;
    });
  }, []);

  const zoomIn = () => applyZoom(1.25);
  const zoomOut = () => applyZoom(1 / 1.25);
  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  // During detection or when viewing the CMYK original tab, show the local CMYK blob URL.
  // Otherwise fall through to the parent-managed preview (pendingPreview) or saved URL (currentUrl).
  const effectivePreview =
    (colorSpace === "detecting" || (colorSpace === "cmyk" && activeTab === "original")) &&
    originalCmykUrl
      ? originalCmykUrl
      : pendingPreview || currentUrl || null;

  const handleFile = useCallback(
    async (file: File) => {
      // Monotonically increasing ID — increments on each new file selection
      const myId = ++detectionIdRef.current;

      // Revoke previous blob before creating new one
      if (originalCmykUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(originalCmykUrlRef.current);
      }
      const localUrl = URL.createObjectURL(file);
      isDetectingRef.current = true;
      originalCmykUrlRef.current = localUrl;
      setColorSpace("detecting");
      setOriginalCmykUrl(localUrl);
      setActiveTab("converted");

      try {
        const isCmyk = await detectCmykJpeg(file);

        // If a newer file selection has started, discard this result
        if (myId !== detectionIdRef.current) {
          URL.revokeObjectURL(localUrl);
          return;
        }

        if (isCmyk) {
          const { file: rgbFile, url: rgbUrl } = await convertCmykToRgb(file.name, localUrl);

          // Check after second await — if superseded, discard both URLs we created
          if (myId !== detectionIdRef.current) {
            URL.revokeObjectURL(localUrl);
            URL.revokeObjectURL(rgbUrl);
            return;
          }

          // Confirmed current detection — safe to revoke previous RGB URL
          if (rgbConvertedUrlRef.current?.startsWith("blob:")) {
            URL.revokeObjectURL(rgbConvertedUrlRef.current);
          }
          rgbConvertedUrlRef.current = rgbUrl;
          originalCmykUrlRef.current = localUrl;
          setColorSpace("cmyk");
          setOriginalCmykUrl(localUrl);
          onFileSelect(rgbFile, rgbUrl);
        } else {
          if (rgbConvertedUrlRef.current?.startsWith("blob:")) {
            URL.revokeObjectURL(rgbConvertedUrlRef.current);
          }
          rgbConvertedUrlRef.current = localUrl;
          originalCmykUrlRef.current = null;
          setColorSpace("rgb");
          setOriginalCmykUrl(null);
          onFileSelect(file, localUrl);
        }
      } catch (err) {
        console.error("[SurfaceUploader] CMYK detection/conversion error:", err);

        if (myId !== detectionIdRef.current) {
          URL.revokeObjectURL(localUrl);
          return;
        }

        if (rgbConvertedUrlRef.current?.startsWith("blob:")) {
          URL.revokeObjectURL(rgbConvertedUrlRef.current);
        }
        rgbConvertedUrlRef.current = localUrl;
        originalCmykUrlRef.current = null;
        setColorSpace("rgb");
        setOriginalCmykUrl(null);
        onFileSelect(file, localUrl);
      } finally {
        // Only clear the detecting flag if this is still the active detection
        if (myId === detectionIdRef.current) {
          isDetectingRef.current = false;
        }
      }
    },
    [onFileSelect],
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
    if (originalCmykUrlRef.current?.startsWith("blob:")) {
      URL.revokeObjectURL(originalCmykUrlRef.current);
    }
    if (rgbConvertedUrlRef.current?.startsWith("blob:")) {
      URL.revokeObjectURL(rgbConvertedUrlRef.current);
      rgbConvertedUrlRef.current = null;
    }
    setColorSpace(null);
    originalCmykUrlRef.current = null;
    detectedUrlRef.current = null;
    setOriginalCmykUrl(null);
    setActiveTab("converted");
    onFileSelect(null, "");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Label>Ảnh Bề Mặt</Label>

      {effectivePreview ? (
        <div className="relative rounded-lg overflow-hidden border bg-muted group">
          <img
            src={effectivePreview}
            alt="Xem trước bề mặt"
            className="w-full h-32 object-contain bg-black/5"
          />
          {!uploading && colorSpace !== "detecting" && (
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
          {/* CMYK detection in progress */}
          {colorSpace === "detecting" && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/75 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-5 w-5 text-primary animate-spin" />
                <span className="text-xs text-muted-foreground">Đang phát hiện màu...</span>
              </div>
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

      {/* RGB badge — shown when the pending file is confirmed RGB */}
      {colorSpace === "rgb" && !uploading && (
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-md bg-green-500/15 text-green-400 border border-green-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            RGB
          </span>
        </div>
      )}

      {/* CMYK warning — shown when the stored image is detected as CMYK (no pending file) */}
      {colorSpace === "cmyk" && !uploading && !pendingFile && (
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-md bg-amber-500/15 text-amber-400 border border-amber-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            CMYK - Tải lại để chuyển đổi
          </span>
        </div>
      )}

      {/* CMYK tabs — shown when the pending file was CMYK-converted */}
      {colorSpace === "cmyk" && !uploading && pendingFile != null && (
        <div className="flex gap-1">
          <button
            type="button"
            className={cn(
              "flex-1 py-1.5 text-[11px] rounded font-medium transition-colors border",
              activeTab === "original"
                ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                : "border-muted text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
            aria-pressed={activeTab === "original"}
            onClick={() => setActiveTab("original")}
          >
            Gốc (CMYK)
          </button>
          <button
            type="button"
            className={cn(
              "flex-1 py-1.5 text-[11px] rounded font-medium transition-colors border",
              activeTab === "converted"
                ? "bg-green-500/20 text-green-400 border-green-500/30"
                : "border-muted text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
            aria-pressed={activeTab === "converted"}
            onClick={() => setActiveTab("converted")}
          >
            RGB ✓
          </button>
        </div>
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
        <DialogContent className="w-screen h-screen max-w-none max-h-none rounded-none p-0 overflow-hidden">
          <DialogHeader className="p-4 pb-2 flex flex-row items-center justify-between">
            <div className="flex items-center gap-3">
              <DialogTitle>Ảnh Bề Mặt</DialogTitle>
              {/* CMYK / RGB tab toggle inside fullscreen dialog */}
              {colorSpace === "cmyk" && pendingFile != null && (
                <div className="flex gap-1">
                  <button
                    type="button"
                    className={cn(
                      "px-3 py-1 text-[11px] rounded font-medium transition-colors border",
                      activeTab === "original"
                        ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                        : "border-muted text-muted-foreground hover:text-foreground hover:bg-muted/50",
                    )}
                    aria-pressed={activeTab === "original"}
                    onClick={() => setActiveTab("original")}
                  >
                    Gốc (CMYK)
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "px-3 py-1 text-[11px] rounded font-medium transition-colors border",
                      activeTab === "converted"
                        ? "bg-green-500/20 text-green-400 border-green-500/30"
                        : "border-muted text-muted-foreground hover:text-foreground hover:bg-muted/50",
                    )}
                    aria-pressed={activeTab === "converted"}
                    onClick={() => setActiveTab("converted")}
                  >
                    RGB ✓
                  </button>
                </div>
              )}
            </div>
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
            style={{ height: "calc(100vh - 72px)", cursor: "grab" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {effectivePreview && (
              <img
                src={effectivePreview}
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
