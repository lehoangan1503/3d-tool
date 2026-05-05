"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Download, CheckCircle2, XCircle, Video } from "lucide-react";
import JSZip from "jszip";
import type { Product } from "@/types/product";
import type { VideoStudioTemplate, VideoStudioConfig } from "@/types/video-studio";
import { ensureFullConfig } from "@/types/video-studio";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { loadProductIntoEsm } from "@/lib/three/load-product-for-esm";

type ItemStatus = "pending" | "in_progress" | "done" | "failed";

interface BulkItem {
  product: Product;
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
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  const [items, setItems] = useState<BulkItem[]>(() =>
    products.map((p) => ({ product: p, status: "pending" as ItemStatus }))
  );
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const cancelledRef = useRef(false);

  const loadTemplates = useCallback(async () => {
    if (templatesLoaded) return;
    try {
      const res = await fetch("/api/video-studio-templates?limit=100");
      if (!res.ok) return;
      const json = await res.json();
      setTemplates((json.data ?? json.items ?? []) as VideoStudioTemplate[]);
    } catch (e) {
      console.error("BulkVideoTab: load templates error", e);
    } finally {
      setTemplatesLoaded(true);
    }
  }, [templatesLoaded]);

  const selectedTemplate = selectedTemplateId
    ? templates.find((t) => t.id === selectedTemplateId)
    : null;
  const templateReady = !!(selectedTemplate && hasCamera(selectedTemplate.config));

  const handleStart = useCallback(async () => {
    if (!selectedTemplate || !templateReady || running) return;

    cancelledRef.current = false;
    setRunning(true);
    setDone(false);
    setItems(products.map((p) => ({ product: p, status: "pending" })));

    const config = ensureFullConfig(selectedTemplate.config);

    for (let i = 0; i < products.length; i++) {
      if (cancelledRef.current) break;
      const product = products[i];
      setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "in_progress", progress: 0 }; return n; });

      const esm = new ExtractorSceneManager(2048, 2048);
      try {
        await loadProductIntoEsm(product, esm);

        const blob = await esm.startStudioRecording(config, (progress) => {
          setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], progress }; return n; });
        });

        const videoUrl = URL.createObjectURL(blob);
        setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "done", blob, videoUrl, progress: 1 }; return n; });
      } catch (err) {
        console.error("BulkVideoTab: product record error", err);
        setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "failed", error: String(err) }; return n; });
      } finally {
        esm.dispose();
      }
    }

    setRunning(false);
    setDone(true);
  }, [selectedTemplate, templateReady, running, products]);

  const handleCancel = useCallback(() => { cancelledRef.current = true; }, []);

  const handleDownloadAll = useCallback(async () => {
    const zip = new JSZip();
    for (const item of items) {
      if (item.blob && item.product) {
        const safeName = (item.product.name ?? item.product.id).replace(/[^a-zA-Z0-9-_]/g, "_");
        const safeTemplate = (selectedTemplate?.name ?? "video").replace(/[^a-zA-Z0-9-_]/g, "_");
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
  }, [items, selectedTemplate]);

  const downloadItem = (item: BulkItem) => {
    if (!item.blob) return;
    const url = URL.createObjectURL(item.blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = (item.product.name ?? item.product.id).replace(/[^a-zA-Z0-9-_]/g, "_");
    const safeTemplate = (selectedTemplate?.name ?? "video").replace(/[^a-zA-Z0-9-_]/g, "_");
    a.download = `${safeName}_${safeTemplate}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doneCount = items.filter((i) => i.status === "done").length;

  return (
    <div className="flex flex-col gap-4 p-1">
      {/* Template selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-zinc-300">Chọn mẫu video</label>
        <Select
          value={selectedTemplateId ?? ""}
          onValueChange={(v) => setSelectedTemplateId(v)}
          onOpenChange={(open) => { if (open) loadTemplates(); }}
        >
          <SelectTrigger className="bg-zinc-800 border-zinc-600 text-zinc-100">
            <SelectValue placeholder="Chọn mẫu..." />
          </SelectTrigger>
          <SelectContent className="bg-zinc-800 border-zinc-700">
            {templates.map((t) => (
              <SelectItem
                key={t.id}
                value={t.id}
                className="text-zinc-100 focus:bg-zinc-700"
                disabled={!hasCamera(t.config)}
              >
                {t.name}
                {!hasCamera(t.config) && <span className="ml-1 text-xs text-zinc-500">(chưa có vị trí camera)</span>}
              </SelectItem>
            ))}
            {templatesLoaded && templates.length === 0 && (
              <div className="px-3 py-2 text-xs text-zinc-500">Chưa có mẫu nào</div>
            )}
          </SelectContent>
        </Select>
        {selectedTemplate && !templateReady && (
          <p className="text-xs text-yellow-400">Mẫu này chưa có vị trí camera bắt đầu/kết thúc.</p>
        )}
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2">
        {!running ? (
          <Button
            size="sm"
            disabled={!templateReady || done}
            onClick={handleStart}
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            <Video className="w-4 h-4 mr-1.5" />
            Bắt đầu ghi ({products.length} sản phẩm)
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
        {running && <span className="text-sm text-zinc-400">{doneCount}/{products.length} video hoàn thành</span>}
        {done && <span className="text-sm text-green-400">Hoàn thành {doneCount}/{products.length}</span>}
      </div>

      {/* Product list */}
      <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
        {items.map((item, idx) => (
          <div key={item.product.id} className="flex items-start gap-3 rounded-lg bg-zinc-800/60 px-3 py-2.5">
            <div className="mt-0.5 shrink-0">
              {item.status === "pending" && <div className="w-4 h-4 rounded-full border border-zinc-600" />}
              {item.status === "in_progress" && <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />}
              {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-400" />}
              {item.status === "failed" && <XCircle className="w-4 h-4 text-red-400" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-zinc-200 truncate">{item.product.name}</p>
                {item.status === "done" && (
                  <button
                    onClick={() => downloadItem(item)}
                    className="text-xs px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-white shrink-0"
                  >
                    ↓ .webm
                  </button>
                )}
              </div>
              {/* Progress bar */}
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
              {/* Inline video preview */}
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
