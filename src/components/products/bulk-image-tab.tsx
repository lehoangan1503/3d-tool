"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Download, CheckCircle2, XCircle, ImageIcon } from "lucide-react";
import JSZip from "jszip";
import type { Product } from "@/types/product";
import { MODEL_PATHS } from "@/types/product";
import type { ExtractorReference, ExtractorReferenceGroup } from "@/types/extractor";
import { SceneManager } from "@/lib/three/scene-manager";
import { renderReferenceToBlob } from "@/components/editor/image-extractor";

type ItemStatus = "pending" | "in_progress" | "done" | "failed";

interface BulkItem {
  product: Product;
  status: ItemStatus;
  blobs?: { name: string; blob: Blob }[];
  error?: string;
}

interface Props {
  products: Product[];
}

export function BulkImageTab({ products }: Props) {
  const [groups, setGroups] = useState<ExtractorReferenceGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const [items, setItems] = useState<BulkItem[]>(() =>
    products.map((p) => ({ product: p, status: "pending" as ItemStatus }))
  );
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const cancelledRef = useRef(false);

  const loadGroups = useCallback(async () => {
    if (groupsLoaded) return;
    try {
      const res = await fetch("/api/extractor-reference-groups");
      if (!res.ok) return;
      const json = await res.json();
      setGroups((json.data ?? json) as ExtractorReferenceGroup[]);
    } catch (e) {
      console.error("BulkImageTab: load groups error", e);
    } finally {
      setGroupsLoaded(true);
    }
  }, [groupsLoaded]);

  const fetchReferences = useCallback(async (group: ExtractorReferenceGroup): Promise<ExtractorReference[]> => {
    const results: ExtractorReference[] = [];
    for (const refId of group.referenceIds) {
      try {
        const res = await fetch(`/api/extractor-references/${refId}`);
        if (!res.ok) continue;
        const ref = await res.json() as ExtractorReference;
        results.push(ref);
      } catch (e) {
        console.error(`BulkImageTab: fetch reference ${refId} error`, e);
      }
    }
    return results;
  }, []);

  const handleStart = useCallback(async () => {
    if (!selectedGroupId || running) return;
    const group = groups.find((g) => g.id === selectedGroupId);
    if (!group) return;

    cancelledRef.current = false;
    setRunning(true);
    setDone(false);
    setItems(products.map((p) => ({ product: p, status: "pending" })));

    const references = await fetchReferences(group);

    for (let i = 0; i < products.length; i++) {
      if (cancelledRef.current) break;
      const product = products[i];
      setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "in_progress" }; return n; });

      // Create a tiny off-screen container + SceneManager to load the product model
      const container = document.createElement("div");
      container.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;";
      document.body.appendChild(container);
      const sm = new SceneManager(container);
      try {
        await sm.loadModel(MODEL_PATHS[product.type]);
        await sm.applySurface({
          surfaceUrl: product.surface_url,
          productType: product.type,
          leatherColor: product.color as import("@/types/product").LeatherColor | null,
          leatherTexture: product.texture_type as import("@/types/product").LeatherTextureType | null,
          textureScale: 1,
        });

        const model = sm.getModelForClone();
        const blobs: { name: string; blob: Blob }[] = [];

        for (const ref of references) {
          if (cancelledRef.current) break;
          const blob = await renderReferenceToBlob(model, ref);
          const safeName = (product.name ?? product.id).replace(/[^a-zA-Z0-9-_]/g, "_");
          const safeRef = (ref.name ?? ref.id).replace(/[^a-zA-Z0-9-_]/g, "_");
          blobs.push({ name: `${safeName}_${safeRef}.png`, blob });
        }

        setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "done", blobs }; return n; });
      } catch (err) {
        console.error("BulkImageTab: product render error", err);
        setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "failed", error: String(err) }; return n; });
      } finally {
        sm.dispose();
        if (container.parentNode) container.parentNode.removeChild(container);
      }
    }

    setRunning(false);
    setDone(true);
  }, [selectedGroupId, running, groups, products, fetchReferences]);

  const handleCancel = useCallback(() => { cancelledRef.current = true; }, []);

  const handleDownloadAll = useCallback(async () => {
    const zip = new JSZip();
    for (const item of items) {
      if (item.blobs) {
        for (const { name, blob } of item.blobs) {
          zip.file(name, blob);
        }
      }
    }
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bulk_images.zip";
    a.click();
    URL.revokeObjectURL(url);
  }, [items]);

  const downloadBlob = (name: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doneCount = items.filter((i) => i.status === "done").length;

  return (
    <div className="flex flex-col gap-4 p-1">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-zinc-300">Chọn nhóm khung ảnh</label>
        <Select
          value={selectedGroupId ?? ""}
          onValueChange={(v) => setSelectedGroupId(v)}
          onOpenChange={(open) => { if (open) loadGroups(); }}
        >
          <SelectTrigger className="bg-zinc-800 border-zinc-600 text-zinc-100">
            <SelectValue placeholder="Chọn nhóm..." />
          </SelectTrigger>
          <SelectContent className="bg-zinc-800 border-zinc-700">
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id} className="text-zinc-100 focus:bg-zinc-700">
                {g.name}
              </SelectItem>
            ))}
            {groupsLoaded && groups.length === 0 && (
              <div className="px-3 py-2 text-xs text-zinc-500">Chưa có nhóm nào</div>
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {!running ? (
          <Button
            size="sm"
            disabled={!selectedGroupId || done}
            onClick={handleStart}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            <ImageIcon className="w-4 h-4 mr-1.5" />
            Xuất ảnh ({products.length} sản phẩm)
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
        {running && <span className="text-sm text-zinc-400">{doneCount}/{products.length} sản phẩm hoàn thành</span>}
        {done && <span className="text-sm text-green-400">Hoàn thành {doneCount}/{products.length}</span>}
      </div>

      <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
        {items.map((item) => (
          <div key={item.product.id} className="flex items-start gap-3 rounded-lg bg-zinc-800/60 px-3 py-2.5">
            <div className="mt-0.5 shrink-0">
              {item.status === "pending" && <div className="w-4 h-4 rounded-full border border-zinc-600" />}
              {item.status === "in_progress" && <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />}
              {item.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-400" />}
              {item.status === "failed" && <XCircle className="w-4 h-4 text-red-400" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-zinc-200 truncate">{item.product.name}</p>
              {item.status === "failed" && (
                <p className="text-xs text-red-400 mt-0.5 truncate">{item.error}</p>
              )}
              {item.blobs && item.blobs.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {item.blobs.map(({ name, blob }) => (
                    <button
                      key={name}
                      onClick={() => downloadBlob(name, blob)}
                      className="text-xs px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-white truncate max-w-[160px]"
                      title={name}
                    >
                      ↓ {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
