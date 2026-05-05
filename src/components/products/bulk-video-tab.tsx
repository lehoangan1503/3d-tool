"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Download, CheckCircle2, XCircle, Video, ChevronDown } from "lucide-react";
import JSZip from "jszip";
import type { Product } from "@/types/product";
import type { VideoStudioTemplate, VideoStudioConfig } from "@/types/video-studio";
import { ensureFullConfig } from "@/types/video-studio";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { loadProductIntoEsm } from "@/lib/three/load-product-for-esm";

type ItemStatus = "pending" | "in_progress" | "done" | "failed";

interface QueueItem {
  product: Product;
  template: VideoStudioTemplate;
  status: ItemStatus;
  progress?: number;
  blob?: Blob;
  videoUrl?: string;
  error?: string;
}

interface Props {
  products: Product[];
}

function hasCamera(config: VideoStudioConfig): boolean {
  return !!(
    config.cameraStart &&
    config.cameraEnd &&
    (config.cameraStart.x !== 0 || config.cameraStart.y !== 0 || config.cameraStart.z !== 0) &&
    (config.cameraEnd.x !== 0 || config.cameraEnd.y !== 0 || config.cameraEnd.z !== 0)
  );
}

export function BulkVideoTab({ products }: Props) {
  const [templates, setTemplates] = useState<VideoStudioTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(new Set());

  const [items, setItems] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
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

    for (let i = 0; i < queue.length; i++) {
      if (cancelledRef.current) break;
      const { product, template } = queue[i];
      setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "in_progress", progress: 0 }; return n; });

      const esm = new ExtractorSceneManager(2048, 2048);
      try {
        await loadProductIntoEsm(product, esm);
        const config = ensureFullConfig(template.config);

        const blob = await esm.startStudioRecording(config, (progress) => {
          setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], progress }; return n; });
        });

        const videoUrl = URL.createObjectURL(blob);
        setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "done", blob, videoUrl, progress: 1 }; return n; });
      } catch (err) {
        console.error("BulkVideoTab: record error", err);
        setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "failed", error: String(err) }; return n; });
      } finally {
        esm.dispose();
      }
    }

    setRunning(false);
    setDone(true);
  }, [canStart, templates, selectedTemplateIds, products]);

  const handleCancel = useCallback(() => { cancelledRef.current = true; }, []);

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
      <div className="flex items-center gap-2 flex-wrap">
        {!running ? (
          <Button
            size="sm"
            disabled={!canStart || done}
            onClick={handleStart}
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            <Video className="w-4 h-4 mr-1.5" />
            Bắt đầu ghi ({totalJobs || products.length} video)
          </Button>
        ) : (
          <Button size="sm" variant="destructive" onClick={handleCancel}>Hủy</Button>
        )}
        {done && doneCount > 0 && (
          <Button size="sm" variant="outline" onClick={handleDownloadAll} className="border-zinc-600 text-zinc-200">
            <Download className="w-4 h-4 mr-1.5" />
            Tải tất cả (.zip)
          </Button>
        )}
        {running && <span className="text-sm text-zinc-400">{doneCount}/{items.length} video hoàn thành</span>}
        {done && <span className="text-sm text-green-400">Hoàn thành {doneCount}/{items.length}</span>}
      </div>

      {/* Queue list */}
      <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
        {items.map((item, idx) => (
          <div key={`${item.product.id}-${item.template.id}`} className="flex items-start gap-3 rounded-lg bg-zinc-800/60 px-3 py-2.5">
            <div className="mt-0.5 shrink-0">
              {item.status === "pending" && <div className="w-4 h-4 rounded-full border border-zinc-600" />}
              {item.status === "in_progress" && <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />}
              {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-400" />}
              {item.status === "failed" && <XCircle className="w-4 h-4 text-red-400" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate">{item.product.name}</p>
                  <p className="text-xs text-zinc-500 truncate">{item.template.name}</p>
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
              {item.status === "in_progress" && typeof item.progress === "number" && (
                <div className="mt-1.5 w-full bg-zinc-700 rounded-full h-1">
                  <div
                    className="h-1 rounded-full bg-purple-500 transition-all duration-200"
                    style={{ width: `${Math.round(item.progress * 100)}%` }}
                  />
                </div>
              )}
              {item.status === "failed" && (
                <p className="text-xs text-red-400 mt-0.5 truncate">{item.error}</p>
              )}
              {item.status === "done" && item.videoUrl && (
                <video
                  key={`video-${idx}`}
                  src={item.videoUrl}
                  className="mt-2 w-full max-w-[220px] rounded-md border border-zinc-700"
                  controls
                  muted
                  loop
                  playsInline
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
