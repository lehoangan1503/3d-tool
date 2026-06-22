"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Download, CheckCircle2, XCircle, Video, ChevronDown, RotateCcw, ExternalLink } from "lucide-react";
import JSZip from "jszip";
import type { Product } from "@/types/product";
import type { VideoStudioTemplate, VideoStudioConfig } from "@/types/video-studio";
import { ensureFullConfig, computeVideoDuration, isCameraFixed } from "@/types/video-studio";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { loadProductIntoEsm } from "@/lib/three/load-product-for-esm";

/** Max videos storable in browser RAM without auto-download before OOM risk */
const MAX_STORED_VIDEOS = 10;

type ItemStatus = "pending" | "in_progress" | "done" | "failed";

interface QueueItem {
  id: string;
  product: Product;
  template: VideoStudioTemplate;
  status: ItemStatus;
  progress?: number;
  progressLabel?: string;
  blob?: Blob;
  /** Object URL for preview / open-in-new-tab. Revoked on cleanup. */
  videoUrl?: string;
  /** Set when auto-download fired. videoUrl is still kept alive for viewing. */
  autoDownloaded?: boolean;
  error?: string;
}

interface Props {
  products: Product[];
  onRecordingChange?: (recording: boolean) => void;
}

function hasCamera(config: VideoStudioConfig): boolean {
  return !!(
    config.cameraStart && config.cameraEnd &&
    (config.cameraStart.x !== 0 || config.cameraStart.y !== 0 || config.cameraStart.z !== 0) &&
    (config.cameraEnd.x !== 0 || config.cameraEnd.y !== 0 || config.cameraEnd.z !== 0)
  );
}

function parseAspect(ratio: string): number {
  const [w, h] = ratio.split(":").map(Number);
  return (w && h) ? w / h : 16 / 9;
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
  const liveQueueRef = useRef<QueueItem[]>([]);
  const autoDownloadRef = useRef(true);
  autoDownloadRef.current = autoDownload;

  /**
   * Directory handle obtained via showDirectoryPicker() — Chrome File System
   * Access API. When set, each finished video is written directly to this folder
   * without triggering Chrome's "Allow multiple downloads" prompt. Falls back
   * to <a>.click() if the API is unavailable (Firefox) or user cancels picker.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirHandleRef = useRef<any>(null);

  /**
   * The visible canvas host inside the recording overlay.
   * The ESM canvas is imperatively appended here — same pattern as VideoStudio —
   * so Chrome schedules rAF with full GPU priority (off-screen / visibility:hidden
   * containers cause rAF throttling, leading to choppy recording).
   */
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);

  /** All object URLs created this session — revoked on unmount / "Ghi thêm" */
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      blobUrlsRef.current = [];
    };
  }, []);

  const revokeAllUrls = () => {
    blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrlsRef.current = [];
  };

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
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const readyTemplates = templates.filter((t) => selectedTemplateIds.has(t.id) && hasCamera(t.config));
  const canStart = readyTemplates.length > 0 && !running && (autoDownload || products.length * readyTemplates.length <= MAX_STORED_VIDEOS);

  /**
   * Record one item.
   *
   * The ESM canvas is mounted into `canvasContainerRef` — a real visible DOM node
   * rendered by the recording overlay. This mirrors VideoStudio's approach where
   * the canvas lives inside a visible preview container, ensuring Chrome gives the
   * canvas full GPU scheduling priority and unthrottled requestAnimationFrame.
   */
  const recordOne = useCallback(async (item: QueueItem) => {
    const esm = new ExtractorSceneManager(2048, 2048);
    activeEsmRef.current = esm;

    // Mount canvas to the VISIBLE overlay container (not off-screen/hidden).
    // Chrome throttles rAF for visibility:hidden / off-viewport canvases, which
    // causes frame drops and choppy encoding. Being in the live DOM with no
    // visibility override ensures the GPU compositor treats it as an active surface.
    const canvas = esm.getCanvas();
    canvas.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;";
    if (canvasContainerRef.current) {
      canvasContainerRef.current.innerHTML = "";
      canvasContainerRef.current.appendChild(canvas);
    }

    const updateById = (patch: Partial<QueueItem>) =>
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, ...patch } : it)));

    try {
      // Load product model + surface into the fresh ESM.
      // This creates a temporary SceneManager for GLTF + texture loading and
      // disposes it before recording starts — same pattern as VideoStudio setup.
      await loadProductIntoEsm(item.product, esm);
      if (cancelledRef.current) return;

      const config = ensureFullConfig(item.template.config);
      const totalDuration = computeVideoDuration(
        config.cameraStart, config.cameraEnd, config.cameraSpeed, "xyz",
        isCameraFixed(config.cameraStart, config.cameraEnd) ? config.fixedCameraDuration : undefined
      );

      // Throttle React state updates: at most every 100ms to avoid re-rendering
      // at 60-120fps while the GPU is under full recording load.
      let lastProgressMs = 0;
      const blob = await esm.startStudioRecording(config, (progressPct) => {
        if (cancelledRef.current) { esm.stopRecording(); return; }
        const now = performance.now();
        if (progressPct >= 100 || now - lastProgressMs >= 100) {
          lastProgressMs = now;
          const elapsed = (progressPct / 100) * totalDuration;
          const fmt = (s: number) => s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
          updateById({
            progress: progressPct / 100,
            progressLabel: `${fmt(elapsed)} / ${fmt(totalDuration)} (${Math.round(progressPct)}%)`,
          });
        }
      });

      // Create a persistent object URL — kept alive so the user can click the card
      // to view the recorded video in a new tab even after auto-download fires.
      // All URLs are tracked in blobUrlsRef and revoked on cleanup / "Ghi thêm".
      const videoUrl = URL.createObjectURL(blob);
      blobUrlsRef.current.push(videoUrl);

      if (autoDownloadRef.current) {
        const safeName = (item.product.name ?? item.product.id).replace(/[^a-zA-Z0-9-_]/g, "_");
        const safeTpl = item.template.name.replace(/[^a-zA-Z0-9-_]/g, "_");
        const fileName = `${safeName}_${safeTpl}.webm`;

        if (dirHandleRef.current) {
          // File System Access API — write directly to user-chosen folder.
          // No Chrome "allow multiple downloads" dialog.
          try {
            const fileHandle = await dirHandleRef.current.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
          } catch (writeErr) {
            console.warn("BulkVideoTab: FSA write failed, falling back to <a>", writeErr);
            const a = document.createElement("a");
            a.href = videoUrl; a.download = fileName;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
          }
        } else {
          // Fallback: trigger browser save (Firefox / no FSA support).
          const a = document.createElement("a");
          a.href = videoUrl; a.download = fileName;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
        }
        // Keep videoUrl alive so the result card links to it for "open in new tab".
        updateById({ status: "done", progress: 1, videoUrl, autoDownloaded: true });
      } else {
        updateById({ status: "done", blob, progress: 1, videoUrl });
      }
    } catch (err) {
      if (!cancelledRef.current) {
        console.error("BulkVideoTab: record error", err);
        updateById({ status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      activeEsmRef.current = null;
      esm.dispose();
      // Clear the canvas from the visible container to clean the preview area
      if (canvasContainerRef.current) canvasContainerRef.current.innerHTML = "";
    }
  }, []);

  const runQueue = useCallback(async (initialItems: QueueItem[]) => {
    liveQueueRef.current = [...initialItems];
    cancelledRef.current = false;
    setRunning(true);
    setDone(false);
    setItems([...initialItems]);
    onRecordingChange?.(true);

    // Wait one frame for React to commit the recording overlay to the DOM —
    // canvasContainerRef.current must be set before recordOne mounts the canvas.
    await new Promise<void>((r) => setTimeout(r, 50));

    let i = 0;
    while (i < liveQueueRef.current.length) {
      if (cancelledRef.current) break;
      const current = liveQueueRef.current[i];

      setItems((prev) => prev.map((it) => it.id === current.id ? { ...it, status: "in_progress", progress: 0 } : it));

      // Between recordings: give the browser time to fully release the previous
      // WebGL context (loseContext() in dispose() is async in Chrome).
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 1200));
      if (cancelledRef.current) break;

      await recordOne(current);
      i++;
    }

    setRunning(false);
    setDone(true);
    onRecordingChange?.(false);
  }, [recordOne, onRecordingChange]);

  const handleStart = useCallback(async () => {
    if (!canStart) return;
    const selected = templates.filter((t) => selectedTemplateIds.has(t.id) && hasCamera(t.config));
    if (selected.length === 0) return;

    // If auto-download is on, ask user to pick a save folder via the File System
    // Access API. This is the only user-gesture opportunity — must happen here,
    // synchronously in the click handler, before any async operations.
    dirHandleRef.current = null;
    if (autoDownload && typeof window !== "undefined" && "showDirectoryPicker" in window) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dirHandleRef.current = await (window as any).showDirectoryPicker({ mode: "readwrite" });
      } catch {
        // User cancelled the folder picker — abort recording.
        return;
      }
    }

    const queue: QueueItem[] = [];
    for (const product of products) {
      for (const template of selected) {
        queue.push(makeItem(product, template));
      }
    }
    await runQueue(queue);
  }, [canStart, templates, selectedTemplateIds, products, autoDownload, runQueue]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    activeEsmRef.current?.stopRecording();
  }, []);

  const handleRecordAgain = useCallback(async (item: QueueItem) => {
    const retry = makeItem(item.product, item.template);
    if (running) {
      liveQueueRef.current = [...liveQueueRef.current, retry];
      setItems((prev) => [...prev, retry]);
      setQueuedNotice(`Đã thêm vào hàng đợi: ${item.product.name} — ${item.template.name}`);
      setTimeout(() => setQueuedNotice(null), 3000);
    } else {
      // If auto-download is on and we don't have a folder yet, pick one first.
      if (autoDownloadRef.current && !dirHandleRef.current &&
          typeof window !== "undefined" && "showDirectoryPicker" in window) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          dirHandleRef.current = await (window as any).showDirectoryPicker({ mode: "readwrite" });
        } catch { return; }
      }
      revokeAllUrls();
      setDone(false);
      runQueue([retry]);
    }
  }, [running, runQueue]);

  const handleDownloadAll = useCallback(async () => {
    const zip = new JSZip();
    const folders = new Map<string, JSZip>();
    for (const item of items) {
      if (!item.blob) continue;
      const safeName = (item.product.name ?? item.product.id).replace(/[^a-zA-Z0-9-_]/g, "_") || item.product.id;
      // Each product gets its own folder; multiple templates land inside it.
      let folder = folders.get(safeName);
      if (!folder) {
        folder = zip.folder(safeName) ?? zip;
        folders.set(safeName, folder);
      }
      const safeTpl = item.template.name.replace(/[^a-zA-Z0-9-_]/g, "_");
      folder.file(`${safeName}_${safeTpl}.webm`, item.blob);
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
  const currentAspect = currentItem
    ? parseAspect(currentItem.template.config.videoRatio ?? "16:9")
    : 16 / 9;

  // ── Recording overlay ─────────────────────────────────────────────────────
  if (running) {
    return (
      <div className="flex flex-col gap-4 p-2">
        {/* Live recording canvas — ESM canvas is imperatively appended here */}
        <div
          ref={canvasContainerRef}
          className="w-full rounded-lg overflow-hidden bg-black"
          style={{ aspectRatio: currentAspect }}
        />

        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-medium text-zinc-200">
            Đang ghi video {currentIdx + 1}/{liveQueueRef.current.length}
          </p>
          {currentItem && (
            <div className="w-full space-y-1">
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

        <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
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
                >+lại</button>
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
              onClick={() => { revokeAllUrls(); dirHandleRef.current = null; setDone(false); setItems([]); }}
              className="border-zinc-600 text-zinc-400 hover:text-zinc-200"
            >
              Ghi thêm
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
          {items.map((item) => (
            <div key={item.id} className="flex flex-col gap-1.5 rounded-lg bg-zinc-800/60 overflow-hidden">
              {/* Clickable header area — opens video in new tab */}
              {item.videoUrl ? (
                <a
                  href={item.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1 hover:bg-zinc-700/40 transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />}
                    {item.status === "failed" && <XCircle className="w-4 h-4 text-red-400 shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200 truncate group-hover:text-white">{item.product.name}</p>
                      <p className="text-xs text-zinc-500 truncate">{item.template.name}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {item.autoDownloaded && <span className="text-xs text-green-500/70">✓ đã tải</span>}
                    <ExternalLink className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300" />
                  </div>
                </a>
              ) : (
                <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />}
                    {item.status === "failed" && <XCircle className="w-4 h-4 text-red-400 shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200 truncate">{item.product.name}</p>
                      <p className="text-xs text-zinc-500 truncate">{item.template.name}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-1.5 px-3 pb-2.5">
                {item.status === "done" && !item.autoDownloaded && item.blob && (
                  <button
                    onClick={() => downloadItem(item)}
                    className="text-xs px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-white flex items-center gap-1"
                  >
                    <Download className="w-3 h-3" /> .webm
                  </button>
                )}
                <button
                  onClick={() => handleRecordAgain(item)}
                  className="text-xs px-2 py-0.5 rounded bg-zinc-700 hover:bg-purple-700 text-zinc-400 hover:text-white flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" /> ghi lại
                </button>
                {item.status === "failed" && (
                  <p className="text-xs text-red-400 truncate ml-1">{item.error}</p>
                )}
              </div>

              {/* Inline video player (non-auto-download only, to avoid memory bloat) */}
              {item.status === "done" && item.videoUrl && !item.autoDownloaded && (
                <video
                  src={item.videoUrl}
                  className="w-full border-t border-zinc-700"
                  controls muted loop playsInline
                />
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Setup view ────────────────────────────────────────────────────────────
  const overLimit = !autoDownload && totalJobs > MAX_STORED_VIDEOS;

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
          <p className="text-xs text-zinc-500">
            {products.length} sản phẩm × {readyTemplates.length} mẫu = {totalJobs} video
          </p>
        )}
      </div>

      {/* Auto-download toggle */}
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
              ? "Khi bắt đầu, trình duyệt sẽ hỏi chọn thư mục lưu. Mỗi video tự lưu vào thư mục đó khi xong."
              : `Video lưu trong RAM để xem trực tiếp. Tối đa ${MAX_STORED_VIDEOS} video — trên ${MAX_STORED_VIDEOS} có thể crash trình duyệt.`}
          </p>
        </div>
      </div>

      {overLimit && (
        <div className="rounded-lg bg-red-900/30 border border-red-800/50 px-3 py-2 text-xs text-red-300">
          ⚠ {totalJobs} video vượt giới hạn {MAX_STORED_VIDEOS} khi tắt tự động tải. Bật lại &ldquo;Tự động tải xuống&rdquo; hoặc giảm số sản phẩm/mẫu.
        </div>
      )}

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
