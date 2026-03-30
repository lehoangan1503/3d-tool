"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Pencil, Loader2, RefreshCw, ImageOff } from "lucide-react";
import type { Product } from "@/types/product";

interface ProductPreviewDialogProps {
  product: Product;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProductPreviewDialog({ product, open, onOpenChange }: ProductPreviewDialogProps) {
  const router = useRouter();
  const [imgState, setImgState] = useState<"loading" | "loaded" | "error">("loading");
  // key is used to force re-mount the img on retry
  const [retryKey, setRetryKey] = useState(0);

  const handleEdit = () => {
    onOpenChange(false);
    router.push(`/dashboard/products/${product.id}`);
  };

  const handleRetry = useCallback(() => {
    setImgState("loading");
    setRetryKey((k) => k + 1);
  }, []);

  // Reset state when dialog opens
  const handleOpenChange = (open: boolean) => {
    if (open) {
      setImgState("loading");
      setRetryKey((k) => k + 1);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl w-[calc(100vw-2rem)] h-[85vh] p-0 overflow-hidden flex flex-col">
        <DialogHeader className="p-4 pb-2 flex flex-row items-center justify-between shrink-0">
          <DialogTitle className="pr-16">{product.name}</DialogTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={handleEdit}
            className="absolute right-12 top-4"
          >
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
        </DialogHeader>

        <div className="flex-1 min-h-0 bg-muted/30 flex items-center justify-center relative">
          {/* Loading spinner */}
          {imgState === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-sm">Loading surface...</span>
              </div>
            </div>
          )}

          {/* Error state */}
          {imgState === "error" && (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <ImageOff className="h-10 w-10" />
              <p className="text-sm">Failed to load surface image</p>
              <Button variant="outline" size="sm" onClick={handleRetry}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Try Again
              </Button>
            </div>
          )}

          {/* Image — plain <img> bypasses Next.js optimizer to avoid 500 errors */}
          {product.surface_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={retryKey}
              src={product.surface_url}
              alt={product.name}
              className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${
                imgState === "loaded" ? "opacity-100" : "opacity-0"
              }`}
              style={{ maxHeight: "calc(85vh - 72px)" }}
              onLoad={() => setImgState("loaded")}
              onError={() => setImgState("error")}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
