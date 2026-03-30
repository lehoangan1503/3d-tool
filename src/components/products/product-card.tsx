"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Trash2, ArrowRight, Eye } from "lucide-react";
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

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (!confirm(`Delete "${product.name}"? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/products/${product.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error("Failed to delete");
      }

      onDeleted?.();
      router.refresh();
    } catch (error) {
      console.error("Delete error:", error);
      alert("Failed to delete product");
    }
  }

  function handlePreview(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setPreviewOpen(true);
  }

  const hasSurface = !!product.surface_url;

  return (
    <>
      <Link href={`/dashboard/products/${product.id}`}>
        <Card className="group cursor-pointer card-interactive">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-col min-w-0 gap-1">
                {/* Always rendered to keep card height consistent */}
                <button
                  onClick={hasSurface ? handlePreview : undefined}
                  className={`self-start flex items-center gap-1 text-[11px] whitespace-nowrap rounded px-1 -ml-1 transition-colors ${
                    hasSurface
                      ? "text-muted-foreground hover:text-primary hover:bg-accent cursor-pointer"
                      : "invisible pointer-events-none"
                  }`}
                >
                  <Eye className="h-3 w-3" />
                  Preview
                </button>
                <CardTitle className="text-base truncate leading-tight">{product.name}</CardTitle>
                <CardDescription className="capitalize">
                  {product.type} cue
                  {product.type === "leather" && product.color && (
                    <span className="ml-1">
                      · {LEATHER_COLORS[product.color]?.name || product.color}
                    </span>
                  )}
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={handleDelete}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Updated {new Date(product.updated_at).toLocaleDateString()}
              </span>
              <span className="flex items-center gap-1 text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                Edit
                <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </div>
          </CardContent>
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
