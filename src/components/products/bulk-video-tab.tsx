"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Download, CheckCircle2, XCircle, Video, ChevronDown } from "lucide-react";
import JSZip from "jszip";
import type { Product } from "@/types/product";
import type { VideoStudioTemplate, VideoStudioConfig } from "@/types/video-studio";
import { ensureFullConfig, computeVideoDuration } from "@/types/video-studio";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { loadProductIntoEsm } from "@/lib/three/load-product-for-esm";

type ItemStatus = "pending" | "in_progress" | "done" | "failed";

interface QueueItem {
  product: Product;
  template: VideoStudioTemplate;
  status: ItemStatus;
  progress?: number;
  progressLabel?: string;
  blob?: Blob;
  videoUrl?: string;
  error?: string;
}

interface Props {
  products: Product[];
  /** Called when recording starts/stops so parent can free DOM resources */
  onRecordingChange?: (recording: boolean) => void;
}

function hasCamera(config: VideoStudioConfig): boolean {
  return !!(
    config.cameraStart &&
    config.cameraEnd &&
    (config.cameraStart.x !== 0 || config.cameraStart.y !== 0 || config.cameraStart.z !== 0) &&
    (config.cameraEnd.x !== 0 || config.cameraEnd.y !== 0 || config.cameraEnd.z !== 0)
  );
}

export function BulkVideoTab({ products, onRecordingChange }: Props) {
  const [templates, setTemplates] = useState<VideoStudioTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(new Set());

  const [items, setItems] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  // Tracks the current recording ESM so cancel can stop it immediately
  const activeEsmRef = useRef<ExtractorSceneManager | null>(null);
  const cancelledRef = useRef(false);

  const loadTemplates = useCallback(async () => {
    if (templatesLoaded) return;
    try {
      const res = await fetch("/api/video-studio-templates?limit=100");
      if (!res.ok) return;
      const json = await res.json();
      setTemplates((json.items ?? json.data ?? []) as VideoStudioTemplate[]);
    } catch (e) {
      console.error("BulkVideoTab: load templates error", e);
    } finally {
      setTemplatesLoaded(true);
    }
  }, [templatesLoaded]);

  const toggleTemplate = (id: string) => {
    setSelectedTemplateIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const readyTemplates = templates.filter((t) => selectedTemplateIds.has(t.id) && hasCamera(t.config));
  const canStart = readyTemplates.length > 0 && !running;

  const handleStart = useCallback(async () => {
    if (!canStart) return;

    const selectedTemplates = templates.filter((t) => selectedTemplateIds.has(t.id) && hasCamera(t.config));
    if (selectedTemplates.length === 0) return;

    // Build flat queue: for each product × each template
    const queue: QueueItem[] = [];
    for (const product of products) {
      for (const template of selectedTemplates) {
        queue.push({ product, template, status: "pending" });
      }
    }

    cancelledRef.current = false;
    setRunning(true);
    setDone(false);
    setItems(queue);
    // Signal parent to unmount product cards (free GPU texture memory)
    onRecordingChange?.(true);

    for (let i = 0; i < queue.length; i++) {
      if (cancelledRef.current) break;
      const { product, template } = queue[i];
      setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "in_progress", progress: 0 }; return n; });

      // Let browser fully release the previous WebGL context before starting next recording
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 600));
      if (cancelledRef.current) break;

      const esm = new ExtractorSceneManager(2048, 2048);
      activeEsmRef.current = esm;

      // Mount canvas to DOM so Chrome uses hardware-accelerated frame capture for captureStream().
      // Without this the canvas is off-screen and Chrome falls back to software capture → choppy video.
      const hiddenContainer = document.createElement("div");
      hiddenContainer.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;visibility:hidden;";
      hiddenContainer.appendChild(esm.getCanvas());
      document.body.appendChild(hiddenContainer);

      try {
        await loadProductIntoEsm(product, esm);
        if (cancelledRef.current) break;

        const config = ensureFullConfig(template.config);

        // Show estimated duration in the progress label using same formula as VideoStudio
        const totalDuration = computeVideoDuration(config.cameraStart, config.cameraEnd, config.cameraSpeed, "xyz");

        // Throttle progress state updates to max 100ms intervals — same pattern as VideoStudio.
        // Updating state at 60-120fps causes React to re-render every frame, stealing CPU from
        // the recording rAF loop and producing choppy output.
        let lastProgressMs = 0;
        const blob = await esm.startStudioRecording(config, (progressPct) => {
          if (cancelledRef.current) {
            esm.stopRecording();
            return;
          }
          const now = performance.now();
          if (progressPct >= 100 || now - lastProgressMs >= 100) {
            lastProgressMs = now;
            const elapsed = (progressPct / 100) * totalDuration;
            const fmt = (s: number) => s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
            setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], progress: progressPct / 100, progressLabel: `${fmt(elapsed)} / ${fmt(totalDuration)} (${Math.round(progressPct)}%)` }; return n; });
          }
        });

        // Store blob but don't create the video URL yet — video elements playing during recording
        // compete for GPU resources. All URLs are created after the full queue finishes.
        setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "done", blob, progress: 1 }; return n; });
      } catch (err) {
        if (!cancelledRef.current) {
          console.error("BulkVideoTab: record error", err);
          const msg = err instanceof Error ? err.message : String(err);
          setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "failed", error: msg }; return n; });
        }
      } finally {
        activeEsmRef.current = null;
        esm.dispose();
        if (hiddenContainer.parentNode) hiddenContainer.parentNode.removeChild(hiddenContainer);
      }
    }

    // All recordings done — now create object URLs and show videos all at once.
    // This guarantees no video decode was competing with the recording GPU.
    setItems((prev) => prev.map((item) => ({
      ...item,
      videoUrl: item.blob && !item.videoUrl ? URL.createObjectURL(item.blob) : item.videoUrl,
    })));
    setRunning(false);
    setDone(true);
    // Signal parent to re-render product cards
    onRecordingChange?.(false);
  }, [canStart, templates, selectedTemplateIds, products, onRecordingChange]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    // Immediately stop and dispose the current in-flight recording
    if (activeEsmRef.current) {
      activeEsmRef.current.stopRecording();
    }
  }, []);

  const handleDownloadAll = useCallback(async () => {
    const zip = new JSZip();
    for (const item of items) {
      if (item.blob) {
        const safeName = (item.product.name ?? item.product.id).replace(/[^a-zA-Z0-9-_]/g, "_");
        const safeTemplate = (item.template.name).replace(/[^a-zA-Z0-9-_]/g, "_");
        zip.file(`${safeName}_${safeTemplate}.webm`, item.blob);
      }
    }
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bulk_videos.zip";
    a.click();
    URL.revokeObjectURL(url);
  }, [items]);

  const downloadItem = (item: QueueItem) => {
    if (!item.blob) return;
    const url = URL.createObjectURL(item.blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = (item.product.name ?? item.product.id).replace(/[^a-zA-Z0-9-_]/g, "_");
    const safeTemplate = item.template.name.replace(/[^a-zA-Z0-9-_]/g, "_");
    a.download = `${safeName}_${safeTemplate}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doneCount = items.filter((i) => i.status === "done").length;
  const selCount = selectedTemplateIds.size;
  const totalJobs = products.length * readyTemplates.length;
  const currentItem = items.find((i) => i.status === "in_progress");
  const currentIdx = items.findIndex((i) => i.status === "in_progress");

  // ── Recording overlay ─────────────────────────────────────────────────────
  // When recording is active, show ONLY the progress overlay.
  // This avoids re-rendering product card images which consume GPU texture memory.
  if (running) {
    return (
      <div className="flex flex-col gap-5 p-2">
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="h-10 w-10 animate-spin text-purple-400" />
          <p className="text-sm font-medium text-zinc-200">
            Đang ghi video {currentIdx + 1}/{items.length}
          </p>
          {currentItem && (
            <div className="w-full max-w-sm space-y-1.5">
              <p className="text-xs text-zinc-400 text-center truncate">
                {currentItem.product.name} — {currentItem.template.name}
              </p>
              <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-purple-500 transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.round((currentItem.progress ?? 0) * 100))}%` }}
                />
              </div>
              {currentItem.progressLabel && (
                <p className="text-xs text-zinc-500 text-center">{currentItem.progressLabel}</p>
              )}
            </div>
          )}
          <p className="text-xs text-zinc-500">{doneCount} / {items.length} video hoàn thành</p>
        </div>

        {/* Compact queue status list */}
        <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
          {items.map((item) => (
            <div key={`${item.product.id}-${item.template.id}`} className="flex items-center gap-2 px-2 py-1 rounded bg-zinc-800/50 text-xs">
              {item.status === "pending" && <div className="w-3 h-3 rounded-full border border-zinc-600 shrink-0" />}
              {item.status === "in_progress" && <Loader2 className="w-3 h-3 text-purple-400 animate-spin shrink-0" />}
              {item.status === "done" && <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />}
              {item.status === "failed" && <XCircle className="w-3 h-3 text-red-400 shrink-0" />}
              <span className="text-zinc-300 truncate">{item.product.name}</span>
              <span className="text-zinc-600 shrink-0">·</span>
              <span className="text-zinc-500 truncate">{item.template.name}</span>
            </div>
          ))}
        </div>

        <Button size="sm" variant="destructive" onClick={handleCancel} className="w-full">
          Hủy
        </Button>
      </div>
    );
  }

  // ── Results view ──────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="flex flex-col gap-4 p-1">
        <div className="flex items-center justify-between">
          <span className="text-sm text-green-400 font-medium">✓ Hoàn thành {doneCount}/{items.length} video</span>
          {doneCount > 0 && (
            <Button size="sm" variant="outline" onClick={handleDownloadAll} className="border-zinc-600 text-zinc-200">
              <Download className="w-4 h-4 mr-1.5" />
              Tải tất cả (.zip)
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
          {items.map((item, idx) => (
            <div key={`${item.product.id}-${item.template.id}`} className="flex flex-col gap-1.5 rounded-lg bg-zinc-800/60 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />}
                  {item.status === "failed" && <XCircle className="w-4 h-4 text-red-400 shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-sm text-zinc-200 truncate">{item.product.name}</p>
                    <p className="text-xs text-zinc-500 truncate">{item.template.name}</p>
                  </div>
                </div>
                {item.status === "done" && (
                  <button
                    onClick={() => downloadItem(item)}
                    className="text-xs px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-white shrink-0"
                  >
                    ↓ .webm
                  </button>
                )}
              </div>
              {item.status === "failed" && (
                <p className="text-xs text-red-400 truncate">{item.error}</p>
              )}
              {item.status === "done" && item.videoUrl && (
                <video
                  key={`video-${idx}`}
                  src={item.videoUrl}
                  className="w-full rounded-md border border-zinc-700"
                  controls
                  muted
                  loop
                  playsInline
                />
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-1">
      {/* Template multi-select */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-zinc-300">Chọn mẫu video</label>
        <Popover onOpenChange={(open) => { if (open) loadTemplates(); }}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-between bg-zinc-800 border-zinc-600 text-zinc-100 hover:bg-zinc-700 hover:text-white">
              {selCount === 0 ? "Chọn mẫu..." : `${selCount} mẫu đã chọn`}
              <ChevronDown className="w-4 h-4 ml-2 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 bg-zinc-800 border-zinc-700 p-2 max-h-60 overflow-y-auto">
            {!templatesLoaded && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-zinc-400">
                <Loader2 className="w-3 h-3 animate-spin" /> Đang tải...
              </div>
            )}
            {templatesLoaded && templates.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-zinc-500">Chưa có mẫu nào</div>
            )}
            {templates.map((t) => {
              const ready = hasCamera(t.config);
              return (
                <label key={t.id} className={`flex items-center gap-2.5 px-2 py-1.5 rounded text-sm ${ready ? "cursor-pointer hover:bg-zinc-700 text-zinc-100" : "opacity-50 cursor-not-allowed text-zinc-400"}`}>
                  <Checkbox
                    checked={selectedTemplateIds.has(t.id)}
                    onCheckedChange={() => ready && toggleTemplate(t.id)}
                    disabled={!ready}
                    className="border-zinc-500"
                  />
                  <span className="flex-1 truncate">{t.name}</span>
                  {!ready && <span className="text-xs text-zinc-500 shrink-0">chưa có camera</span>}
                </label>
              );
            })}
          </PopoverContent>
        </Popover>
        {selCount > 0 && readyTemplates.length < selCount && (
          <p className="text-xs text-yellow-400">{selCount - readyTemplates.length} mẫu chưa có vị trí camera sẽ bị bỏ qua.</p>
        )}
        {readyTemplates.length > 0 && (
          <p className="text-xs text-zinc-500">{products.length} sản phẩm × {readyTemplates.length} mẫu = {totalJobs} video</p>
        )}
      </div>

      {/* Action bar */}
      <Button
        size="sm"
        disabled={!canStart}
        onClick={handleStart}
        className="bg-purple-600 hover:bg-purple-700 text-white"
      >
        <Video className="w-4 h-4 mr-1.5" />
        Bắt đầu ghi ({totalJobs || products.length} video)
      </Button>
    </div>
  );
}
