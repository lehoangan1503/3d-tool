"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import JSZip from "jszip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Loader2, Download, Image as ImageIcon, Search } from "lucide-react";
import type { ExtractorReference, ExtractorFrame } from "@/types/extractor";
import { isCueFrame, isImageFrame } from "@/types/extractor";
import { useReferenceList } from "@/hooks/use-reference-list";
import { renderPool }       from "@/lib/render-pool";

const PREVIEW_CANVAS = 2048;

function LayoutPreviewSvg({ frames, size }: { frames: ExtractorFrame[]; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${PREVIEW_CANVAS} ${PREVIEW_CANVAS}`}
      style={{ background: "#111827" }}
      className="rounded block flex-shrink-0"
    >
      {frames.map((frame, i) => {
        const cx = frame.transform.x + frame.transform.width / 2;
        const cy = frame.transform.y + frame.transform.height / 2;
        const fill = isImageFrame(frame)
          ? "#f87171"
          : `hsl(${(i * 137) % 360}, 65%, 60%)`;
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
            transform={
              frame.transform.rotation
                ? `rotate(${frame.transform.rotation},${cx},${cy})`
                : undefined
            }
          />
        );
      })}
    </svg>
  );
}

interface DownloadMultipleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  onRenderReference: (reference: ExtractorReference) => Promise<Blob>;
}

export function DownloadMultipleDialog({
  open,
  onOpenChange,
  productId,
  onRenderReference,
}: DownloadMultipleDialogProps) {
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting]   = useState(false);
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, status: "" });
  const [error, setError]               = useState<string | null>(null);

  // thumbnail url cache: id → objectURL
  const thumbnailUrls = useRef<Map<string, string>>(new Map());
  const [thumbnailVersion, setThumbnailVersion] = useState(0);

  const { references, total, isLoading, isFetchingMore, hasMore,
          search, setSearch, sentinelRef } =
    useReferenceList({ enabled: open });

  // Select-all when first page loads (only when search is empty and we're at page start)
  useEffect(() => {
    if (references.length > 0 && selectedIds.size === 0 && !search) {
      setSelectedIds(new Set(references.map((r) => r.id)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [references]);

  // Render thumbnails for newly-arrived references
  useEffect(() => {
    if (references.length === 0) return;
    const unrendered = references.filter(
      (r) => !thumbnailUrls.current.has(r.id)
    );
    if (unrendered.length === 0) return;

    renderPool(
      unrendered,
      onRenderReference,
      (idx, url) => {
        thumbnailUrls.current.set(unrendered[idx].id, url);
        setThumbnailVersion((v) => v + 1);
      },
      3
    );
  }, [references, onRenderReference]);

  // Revoke all blob URLs + reset state on close
  useEffect(() => {
    if (!open) {
      thumbnailUrls.current.forEach((url) => URL.revokeObjectURL(url));
      thumbnailUrls.current.clear();
      setThumbnailVersion(0);
      setSelectedIds(new Set());
      setExportProgress({ current: 0, total: 0, status: "" });
      setError(null);
    }
  }, [open]);

  const handleSelectAll = () => {
    setSelectedIds(new Set(references.map((r) => r.id)));
  };

  const handleDeselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleExport = async () => {
    if (selectedIds.size === 0) return;

    setIsExporting(true);
    setError(null);

    const selectedRefs = references.filter((r) => selectedIds.has(r.id));
    const exportTotal = selectedRefs.length;

    try {
      const zip = new JSZip();

      for (let i = 0; i < selectedRefs.length; i++) {
        const ref = selectedRefs[i];
        setExportProgress({
          current: i + 1,
          total: exportTotal,
          status: `Rendering "${ref.name}"...`,
        });

        const blob = await onRenderReference(ref);
        const filename = `${ref.name.replace(/[^a-zA-Z0-9-_]/g, "-")}.png`;
        zip.file(filename, blob);
      }

      setExportProgress({ current: exportTotal, total: exportTotal, status: "Creating ZIP..." });

      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(zipBlob);
      link.download = `cue-exports-${timestamp}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      onOpenChange(false);
    } catch (err) {
      console.error("Export failed:", err);
      setError("Export failed. Please try again.");
    } finally {
      setIsExporting(false);
      setExportProgress({ current: 0, total: 0, status: "" });
    }
  };

  const getFramesSummary = (frames: ExtractorFrame[]) => {
    const cueFrames = frames.filter(isCueFrame);
    return `${cueFrames.length} frame${cueFrames.length !== 1 ? "s" : ""}`;
  };

  // thumbnailVersion read to subscribe to updates (ESLint needs the reference)
  void thumbnailVersion;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Download Multiple References
          </DialogTitle>
          <DialogDescription>
            Select references to export as a ZIP file.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        {/* List */}
        {isLoading && references.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : references.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
            <ImageIcon className="h-10 w-10 text-muted-foreground/50 mb-2" />
            <p className="text-sm text-muted-foreground">No saved references found</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Save a layout in Image Extractor first
            </p>
          </div>
        ) : (
          <>
            {/* Select/Deselect buttons */}
            <div className="flex gap-2 pb-1 border-b">
              <Button variant="ghost" size="sm" onClick={handleSelectAll}>
                Select All
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDeselectAll}>
                Deselect All
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1 py-2">
              {references.map((ref) => {
                const thumbUrl = thumbnailUrls.current.get(ref.id);
                return (
                  <label
                    key={ref.id}
                    className="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={selectedIds.has(ref.id)}
                      onCheckedChange={() => handleToggle(ref.id)}
                      disabled={isExporting}
                    />
                    {/* 80×80 thumbnail */}
                    <div className="flex-shrink-0 w-20 h-20 rounded overflow-hidden bg-[#111827]">
                      {thumbUrl ? (
                        <img src={thumbUrl} alt={ref.name} className="w-full h-full object-contain" />
                      ) : (
                        <LayoutPreviewSvg frames={ref.frames} size={80} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{ref.name}</div>
                      <div className="text-xs text-muted-foreground">{getFramesSummary(ref.frames)}</div>
                    </div>
                  </label>
                );
              })}

              {/* Infinite scroll sentinel */}
              {hasMore && (
                <div ref={sentinelRef} className="py-2 flex justify-center">
                  {isFetchingMore && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </div>
              )}
            </div>
          </>
        )}

        {/* Progress indicator when exporting */}
        {isExporting && (
          <div className="py-2 space-y-2">
            <Progress value={(exportProgress.current / exportProgress.total) * 100} />
            <p className="text-xs text-muted-foreground text-center">
              {exportProgress.status} ({exportProgress.current}/{exportProgress.total})
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive text-center py-2">{error}</p>
        )}

        <DialogFooter className="border-t pt-4 flex items-center gap-2">
          <span className="text-xs text-muted-foreground flex-1">
            {selectedIds.size} of {total} selected
          </span>
          <Button
            onClick={handleExport}
            disabled={isExporting || selectedIds.size === 0 || isLoading}
            className="w-full sm:w-auto"
          >
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Export Selected ({selectedIds.size})
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
