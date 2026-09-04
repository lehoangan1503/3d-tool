"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Download, CheckCircle2, XCircle, ImageIcon, ChevronDown } from "lucide-react";
import JSZip from "jszip";
import type { Product, LeatherColor, LeatherTextureType, ProductConfig, ThreeJSSettingsJson } from "@/types/product";
import { MODEL_PATHS, settingsJsonToConfig } from "@/types/product";
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

/** Render one reference for a product, applying the product's surface to both the
 *  cue 3D instances (overrideSurfaceUrl) and any dynamic-surface image frames
 *  (productSurfaceUrl). Delegates to the shared renderReferenceToBlob so bulk export
 *  and the editor stay in lock-step. */
function renderRefForProduct(
  model: ReturnType<SceneManager["getModelForClone"]>,
  reference: ExtractorReference,
  overrideSurfaceUrl?: string,
  /** Engraved logo id, so a snapshot's "auto" backdrop plate matches the cue. */
  productLogoId?: string | null,
): Promise<Blob> {
  return renderReferenceToBlob(
    model,
    reference,
    overrideSurfaceUrl,
    overrideSurfaceUrl ?? null,
    productLogoId,
  );
}

async function fetchProductConfig(productId: string): Promise<ProductConfig | null> {
  try {
    const res = await fetch(`/api/products/${productId}/settings`);
    if (!res.ok) return null;
    const json = await res.json() as ThreeJSSettingsJson;
    return settingsJsonToConfig(json);
  } catch {
    return null;
  }
}

export function BulkImageTab({ products }: Props) {
  const [groups, setGroups] = useState<ExtractorReferenceGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());

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
      setGroups((json.items ?? json.data ?? json) as ExtractorReferenceGroup[]);
    } catch (e) {
      console.error("BulkImageTab: load groups error", e);
    } finally {
      setGroupsLoaded(true);
    }
  }, [groupsLoaded]);

  const toggleGroup = (id: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fetchReferencesForGroups = useCallback(async (groupList: ExtractorReferenceGroup[]): Promise<ExtractorReference[]> => {
    const seen = new Set<string>();
    const results: ExtractorReference[] = [];
    for (const group of groupList) {
      for (const refId of group.referenceIds) {
        if (seen.has(refId)) continue;
        seen.add(refId);
        try {
          const res = await fetch(`/api/extractor-references/${refId}`);
          if (!res.ok) continue;
          const ref = await res.json() as ExtractorReference;
          results.push(ref);
        } catch (e) {
          console.error(`BulkImageTab: fetch reference ${refId} error`, e);
        }
      }
    }
    return results;
  }, []);

  const handleStart = useCallback(async () => {
    if (selectedGroupIds.size === 0 || running) return;
    const selectedGroups = groups.filter((g) => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) return;

    cancelledRef.current = false;
    setRunning(true);
    setDone(false);
    setItems(products.map((p) => ({ product: p, status: "pending" })));

    const references = await fetchReferencesForGroups(selectedGroups);

    for (let i = 0; i < products.length; i++) {
      if (cancelledRef.current) break;
      const product = products[i];
      setItems((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "in_progress" }; return n; });

      const container = document.createElement("div");
      container.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;";
      document.body.appendChild(container);
      const sm = new SceneManager(container);
      try {
        await sm.loadModel(MODEL_PATHS[product.type]);
        const productConfig = await fetchProductConfig(product.id);
        await sm.applySurface({
          surfaceUrl: product.surface_url,
          productType: product.type,
          leatherColor: product.color as LeatherColor | null,
          leatherTexture: product.texture_type as LeatherTextureType | null,
          textureScale: productConfig?.textureScale ?? 1,
          logoId: productConfig?.logoId ?? "uni",
        });

        // Apply product-specific material settings so joint roughness/metalness
        // matches the editor render (otherwise joint defaults to roughness=1.0 → flat black).
        if (productConfig) {
          sm.updateBodyRoughness(productConfig.bodyRoughness);
          sm.updateJointConfig({
            roughness: productConfig.jointRoughness,
            clearcoat: productConfig.jointClearcoat,
            metalness: productConfig.jointMetalness,
          });
        }

        const model = sm.getModelForClone();
        const blobs: { name: string; blob: Blob }[] = [];

        for (const ref of references) {
          if (cancelledRef.current) break;
          const blob = await renderRefForProduct(
            model,
            ref,
            product.surface_url ?? undefined,
            productConfig?.logoId ?? null,
          );
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
  }, [selectedGroupIds, running, groups, products, fetchReferencesForGroups]);

  const handleCancel = useCallback(() => { cancelledRef.current = true; }, []);

  const handleDownloadAll = useCallback(async () => {
    const zip = new JSZip();
    const usedFolders = new Set<string>();
    for (const item of items) {
      if (!item.blobs || item.blobs.length === 0) continue;
      // Each product gets its own folder, named after the product.
      const baseFolder = (item.product.name ?? item.product.id).replace(/[^a-zA-Z0-9-_]/g, "_") || item.product.id;
      let folderName = baseFolder;
      let dup = 1;
      while (usedFolders.has(folderName)) folderName = `${baseFolder}_${++dup}`;
      usedFolders.add(folderName);
      const folder = zip.folder(folderName);
      if (!folder) continue;
      for (const { name, blob } of item.blobs) {
        folder.file(name, blob);
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
  const selCount = selectedGroupIds.size;

  return (
    <div className="flex flex-col gap-4 p-1">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-zinc-300">Chọn nhóm khung ảnh</label>
        <Popover onOpenChange={(open) => { if (open) loadGroups(); }}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-between bg-zinc-800 border-zinc-600 text-zinc-100 hover:bg-zinc-700 hover:text-white">
              {selCount === 0 ? "Chọn nhóm..." : `${selCount} nhóm đã chọn`}
              <ChevronDown className="w-4 h-4 ml-2 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 bg-zinc-800 border-zinc-700 p-2">
            {!groupsLoaded && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-zinc-400">
                <Loader2 className="w-3 h-3 animate-spin" /> Đang tải...
              </div>
            )}
            {groupsLoaded && groups.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-zinc-500">Chưa có nhóm nào</div>
            )}
            {groups.map((g) => (
              <label key={g.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer hover:bg-zinc-700 text-zinc-100 text-sm">
                <Checkbox
                  checked={selectedGroupIds.has(g.id)}
                  onCheckedChange={() => toggleGroup(g.id)}
                  className="border-zinc-500"
                />
                {g.name}
              </label>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {!running ? (
          <Button
            size="sm"
            disabled={selCount === 0 || done}
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
                      className="text-xs px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-white"
                    >
                      ↓ {name.split("_").pop()}
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
