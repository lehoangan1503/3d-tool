"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Download, CheckCircle2, XCircle, Video, ChevronDown, RotateCcw } from "lucide-react";
import JSZip from "jszip";
import type { Product } from "@/types/product";
import type { VideoStudioTemplate, VideoStudioConfig } from "@/types/video-studio";
import { ensureFullConfig, computeVideoDuration } from "@/types/video-studio";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { loadProductIntoEsm } from "@/lib/three/load-product-for-esm";

type ItemStatus = "pending" | "in_progress" | "done" | "failed";

interface QueueItem {
  /** Unique per-enqueue ID so retries are tracked separately */
  id: string;
  product: Product;
  template: VideoStudioTemplate;
  status: ItemStatus;
  progress?: number;
  progressLabel?: string;
  blob?: Blob;
  videoUrl?: string;
  /** Set when auto-download fired; blob is already revoked */
  autoDownloaded?: boolean;
  error?: string;
}

interface Props {
  products: Product[];
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

let _seq = 0;
function makeItem(product: Product, template: VideoStudioTemplate): QueueItem {
  return { id: `${product.id}-${template.id}-${++_seq}`, product, template, status: "pending" };
}

export function BulkVideoTab({ products, onRecordingChange }: Props) {
  const [templates, setTemplates] = useState<VideoStudioTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(new Set());
  const [autoDownload, setAutoDownload] = useState(true);

  const [items, setItems] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [queuedNotice, setQueuedNotice] = useState<string | null>(null);

  const activeEsmRef = useRef<ExtractorSceneManager | null>(null);
  const cancelledRef = useRef(false);
  /** Live queue — can grow mid-recording when user queues a retry */
  const liveQueueRef = useRef<QueueItem[]>([]);
  const autoDownloadRef = useRef(true);
  autoDownloadRef.current = autoDownload;

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

  /** Record a single item, updating its status in `items` state by id. */
  const recordOne = useCallback(async (item: QueueItem) => {
    const esm = new ExtractorSceneManager(2048, 2048);
    activeEsmRef.current = esm;

    const hiddenContainer = document.createElement("div");
    hiddenContainer.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;visibility:hidden;";
    hiddenContainer.appendChild(esm.getCanvas());
    document.body.appendChild(hiddenContainer);

    const updateById = (patch: Partial<QueueItem>) =>
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, ...patch } : it)));

    try {
      await loadProductIntoEsm(item.product, esm);
      if (cancelledRef.current) return;

      const config = ensureFullConfig(item.template.config);
      const totalDuration = computeVideoDuration(config.cameraStart, config.cameraEnd, config.cameraSpeed, "xyz");

      let lastProgressMs = 0;
      const blob = await esm.startStudioRecording(config, (progressPct) => {
        if (cancelledRef.current) { esm.stopRecording(); return; }
        const now = performance.now();
        if (progressPct >= 100 || now - lastProgressMs >= 100) {
          lastProgressMs = now;
          const elapsed = (progressPct / 100) * totalDuration;
          const fmt = (s: number) => s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
          updateById({ progress: progressPct / 100, progressLabel: `${fmt(elapsed)} / ${fmt(totalDuration)} (${Math.round(progressPct)}%)` });
        }
      });

      if (autoDownloadRef.current) {
        // Download immediately then revoke — frees blob memory before next recording.
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const safeName = (item.product.name ?? item.product.id).replace(/[^a-zA-Z0-9-_]/g, "_");
        const safeTpl = item.template.name.replace(/[^a-zA-Z0-9-_]/g, "_");
        a.download = `${safeName}_${safeTpl}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        updateById({ status: "done", progress: 1, autoDownloaded: true });
      } else {
        updateById({ status: "done", blob, progress: 1 });
      }
    } catch (err) {
      if (!cancelledRef.current) {
        console.error("BulkVideoTab: record error", err);
        updateById({ status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      activeEsmRef.current = null;
      esm.dispose();
      if (hiddenContainer.parentNode) hiddenContainer.parentNode.removeChild(hiddenContainer);
    }
  }, []);

  /** Run the live queue from the start index, processing items sequentially. */
  const runQueue = useCallback(async (initialItems: QueueItem[]) => {
    liveQueueRef.current = [...initialItems];
    cancelledRef.current = false;
    setRunning(true);
    setDone(false);
    setItems([...initialItems]);
    onRecordingChange?.(true);

    let i = 0;
    while (i < liveQueueRef.current.length) {
      if (cancelledRef.current) break;
      const current = liveQueueRef.current[i];

      setItems((prev) => prev.map((it) => it.id === current.id ? { ...it, status: "in_progress", progress: 0 } : it));

      // Give the browser time to fully release the previous WebGL context.
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 1000));
      if (cancelledRef.current) break;

      await recordOne(current);
      i++;
    }

    // Create video preview URLs for non-auto-downloaded items all at once (after recording ends).
    setItems((prev) => prev.map((it) => ({
      ...it,
      videoUrl: it.blob && !it.videoUrl ? URL.createObjectURL(it.blob) : it.videoUrl,
    })));
    setRunning(false);
    setDone(true);
    onRecordingChange?.(false);
  }, [recordOne, onRecordingChange]);

  const handleStart = useCallback(async () => {
    if (!canStart) return;
    const selected = templates.filter((t) => selectedTemplateIds.has(t.id) && hasCamera(t.config));
    if (selected.length === 0) return;
    const queue: QueueItem[] = [];
    for (const product of products) {
      for (const template of selected) {
        queue.push(makeItem(product, template));
      }
    }
    await runQueue(queue);
  }, [canStart, templates, selectedTemplateIds, products, runQueue]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    activeEsmRef.current?.stopRecording();
  }, []);

  /** Queue a single item for re-recording. Adds to live queue if running, else starts fresh. */
  const handleRecordAgain = useCallback((item: QueueItem) => {
    const retry = makeItem(item.product, item.template);
    if (running) {
      liveQueueRef.current = [...liveQueueRef.current, retry];
      setItems((prev) => [...prev, retry]);
      const label = `${item.product.name} — ${item.template.name}`;
      setQueuedNotice(`Đã thêm vào hàng đợi: ${label}`);
      setTimeout(() => setQueuedNotice(null), 3000);
    } else {
      setDone(false);
      runQueue([retry]);
    }
  }, [running, runQueue]);

  const handleDownloadAll = useCallback(async () => {
    const zip = new JSZip();
    for (const item of items) {
      if (item.blob) {
        const safeName = (item.product.name ?? item.product.id).replace(/[^a-zA-Z0-9-_]/g, "_");
        const safeTpl = item.template.name.replace(/[^a-zA-Z0-9-_]/g, "_");
        zip.file(`${safeName}_${safeTpl}.webm`, item.blob);
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
    const safeTpl = item.template.name.replace(/[^a-zA-Z0-9-_]/g, "_");
    a.download = `${safeName}_${safeTpl}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const doneCount = items.filter((i) => i.status === "done").length;
  const selCount = selectedTemplateIds.size;
  const totalJobs = products.length * readyTemplates.length;
  const currentItem = items.find((i) => i.status === "in_progress");
  const currentIdx = items.findLastIndex((i) => i.status === "in_progress");
  const hasStoredBlobs = items.some((i) => i.status === "done" && !i.autoDownloaded && i.blob);

  // ── Recording overlay ─────────────────────────────────────────────────────
  if (running) {
    return (
      <div className="flex flex-col gap-5 p-2">
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="h-10 w-10 animate-spin text-purple-400" />
          <p className="text-sm font-medium text-zinc-200">
            Đang ghi video {currentIdx + 1}/{liveQueueRef.current.length}
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
          <p className="text-xs text-zinc-500">{doneCount} / {liveQueueRef.current.length} video hoàn thành</p>
        </div>

        {queuedNotice && (
          <div className="text-xs text-purple-300 bg-purple-900/30 rounded px-2 py-1.5 text-center">
            {queuedNotice}
          </div>
        )}

        <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 px-2 py-1 rounded bg-zinc-800/50 text-xs">
              {item.status === "pending" && <div className="w-3 h-3 rounded-full border border-zinc-600 shrink-0" />}
              {item.status === "in_progress" && <Loader2 className="w-3 h-3 text-purple-400 animate-spin shrink-0" />}
              {item.status === "done" && <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />}
              {item.status === "failed" && <XCircle className="w-3 h-3 text-red-400 shrink-0" />}
              <span className="text-zinc-300 truncate flex-1">{item.product.name}</span>
              <span className="text-zinc-600 shrink-0">·</span>
              <span className="text-zinc-500 truncate">{item.template.name}</span>
              {item.status === "failed" && (
                <button
                  onClick={() => handleRecordAgain(item)}
                  className="ml-1 text-xs text-purple-400 hover:text-purple-300 shrink-0"
                  title="Thêm vào hàng đợi"
                >
                  +lại
                </button>
              )}
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
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-sm text-green-400 font-medium">✓ Hoàn thành {doneCount}/{items.length} video</span>
          <div className="flex gap-2">
            {hasStoredBlobs && (
              <Button size="sm" variant="outline" onClick={handleDownloadAll} className="border-zinc-600 text-zinc-200">
                <Download className="w-4 h-4 mr-1.5" />
                Tải tất cả (.zip)
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setDone(false); setItems([]); }}
              className="border-zinc-600 text-zinc-400 hover:text-zinc-200"
            >
              Ghi thêm
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
          {items.map((item) => (
            <div key={item.id} className="flex flex-col gap-1.5 rounded-lg bg-zinc-800/60 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />}
                  {item.status === "failed" && <XCircle className="w-4 h-4 text-red-400 shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-sm text-zinc-200 truncate">{item.product.name}</p>
                    <p className="text-xs text-zinc-500 truncate">{item.template.name}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {item.status === "done" && item.autoDownloaded && (
                    <span className="text-xs text-green-500/70 px-1">✓ đã tải</span>
                  )}
                  {item.status === "done" && !item.autoDownloaded && item.blob && (
                    <button
                      onClick={() => downloadItem(item)}
                      className="text-xs px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-white"
                    >
                      ↓ .webm
                    </button>
                  )}
                  <button
                    onClick={() => handleRecordAgain(item)}
                    className="text-xs px-2 py-0.5 rounded bg-zinc-700 hover:bg-purple-700 text-zinc-400 hover:text-white flex items-center gap-1"
                    title="Ghi lại video này"
                  >
                    <RotateCcw className="w-3 h-3" /> ghi lại
                  </button>
                </div>
              </div>
              {item.status === "failed" && (
                <p className="text-xs text-red-400 truncate">{item.error}</p>
              )}
              {item.status === "done" && item.videoUrl && (
                <video
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

  // ── Setup view ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 p-1">
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

      {/* Auto-download toggle — keeps memory free between recordings */}
      <div className="flex items-start gap-2.5 rounded-lg bg-zinc-800/50 px-3 py-2.5">
        <Checkbox
          id="auto-dl"
          checked={autoDownload}
          onCheckedChange={(v) => setAutoDownload(!!v)}
          className="border-zinc-500 mt-0.5"
        />
        <div className="flex flex-col gap-0.5">
          <label htmlFor="auto-dl" className="text-sm text-zinc-200 cursor-pointer font-medium">
            Tự động tải xuống
          </label>
          <p className="text-xs text-zinc-500">
            {autoDownload
              ? "Mỗi video tải ngay khi xong và giải phóng bộ nhớ cho video tiếp theo."
              : totalJobs > 5
                ? `⚠ ${totalJobs} video sẽ lưu trong RAM trình duyệt — có thể gây crash.`
                : "Video sẽ hiện trong kết quả để xem trước trước khi tải."}
          </p>
        </div>
      </div>

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
