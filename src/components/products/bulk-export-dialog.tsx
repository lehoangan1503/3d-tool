"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ImageIcon, Video } from "lucide-react";
import type { Product } from "@/types/product";
import { BulkImageTab } from "./bulk-image-tab";
import { BulkVideoTab } from "./bulk-video-tab";

interface Props {
  open: boolean;
  onClose: () => void;
  products: Product[];
}

type Tab = "image" | "video";

export function BulkExportDialog({ open, onClose, products }: Props) {
  const [tab, setTab] = useState<Tab>("image");

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="bg-zinc-900 border-zinc-700 text-zinc-100 max-w-xl w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Tải xuống nhiều</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Xuất ảnh hoặc ghi video cho {products.length} sản phẩm đã chọn.
          </DialogDescription>
        </DialogHeader>

        {/* Tab bar */}
        <div className="flex gap-1 mt-2 p-1 bg-zinc-800 rounded-lg border border-zinc-700">
          <button
            onClick={() => setTab("image")}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "image"
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <ImageIcon className="w-4 h-4" />
            Ảnh
          </button>
          <button
            onClick={() => setTab("video")}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "video"
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Video className="w-4 h-4" />
            Video
          </button>
        </div>

        <div className="mt-3">
          {tab === "image" ? (
            <BulkImageTab products={products} />
          ) : (
            <BulkVideoTab products={products} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
