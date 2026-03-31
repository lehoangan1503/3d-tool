"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Trash2, ArrowRight, ImageOff } from "lucide-react";
import type { Product } from "@/types/product";
import { LEATHER_COLORS } from "@/types/product";
import { ProductPreviewDialog } from "./product-preview-dialog";

interface ProductCardProps {
  product: Product;
  onDeleted?: () => void;
}

export function ProductCard({ product, onDeleted }: ProductCardProps) {
  const router = useRouter();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (!confirm(`Delete "${product.name}"? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/products/${product.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      onDeleted?.();
      router.refresh();
    } catch (error) {
      console.error("Delete error:", error);
      alert("Failed to delete product");
    }
  }

  // Preview button temporarily disabled (keep code for re-enabling)
  // function handlePreview(e: React.MouseEvent) {
  //   e.preventDefault();
  //   e.stopPropagation();
  //   setPreviewOpen(true);
  // }

  const hasSurface = !!product.surface_url;

  return (
    <>
      <Link href={`/dashboard/products/${product.id}`}>
        <Card className="group cursor-pointer card-interactive overflow-hidden h-52">
          <div className="flex h-full">
            {/* Left: Surface image */}
            <div className="relative w-2/5 flex-shrink-0 bg-muted overflow-hidden">
              {hasSurface ? (
                <>
                  {!imageLoaded && (
                    <div className="absolute inset-0 animate-pulse bg-muted" />
                  )}
                  <img
                    src={product.surface_url!}
                    alt={product.name}
                    loading="lazy"
                    onLoad={() => setImageLoaded(true)}
                    className={`w-full h-full object-contain transition-opacity duration-300 ${
                      imageLoaded ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-muted/60">
                  <ImageOff className="h-6 w-6 text-muted-foreground/40" />
                  <span className="text-[11px] text-muted-foreground/60 text-center leading-tight px-3">
                    No surface yet
                  </span>
                </div>
              )}
            </div>

            {/* Right: Card info */}
            <div className="flex flex-col flex-1 min-w-0 p-4 gap-1">
              <div className="flex items-start justify-between gap-1">
                <div className="flex flex-col min-w-0 gap-0.5 flex-1">
                  {/* Preview button — temporarily disabled, not removed */}
                  {/* <button
                    onClick={hasSurface ? handlePreview : undefined}
                    className="self-start flex items-center gap-1 text-[11px] whitespace-nowrap rounded px-1 -ml-1 text-muted-foreground hover:text-primary hover:bg-accent cursor-pointer transition-colors"
                  >
                    <Eye className="h-3 w-3" />
                    Preview
                  </button> */}
                  <p className="font-semibold text-sm leading-tight text-foreground break-words">
                    {product.name}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {product.type} cue
                    {product.type === "leather" && product.color && (
                      <span className="ml-1">
                        · {LEATHER_COLORS[product.color]?.name || product.color}
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  onClick={handleDelete}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="mt-auto flex items-center justify-between text-xs pt-2">
                <span className="text-muted-foreground">
                  {new Date(product.updated_at).toLocaleDateString()}
                </span>
                <span className="flex items-center gap-1 text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                  Edit
                  <ArrowRight className="h-3 w-3" />
                </span>
              </div>
            </div>
          </div>
        </Card>
      </Link>

      {hasSurface && (
        <ProductPreviewDialog
          product={product}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        />
      )}
    </>
  );
}


const LENS_SIZE = 220;  // diameter px
const ZOOM       = 1.8; // magnification factor — shows ~55% of image width, no letterbox

