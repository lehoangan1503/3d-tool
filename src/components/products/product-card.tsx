"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Trash2, ArrowRight, ImageOff, ShoppingBag } from "lucide-react";
import type { Product } from "@/types/product";
import { LEATHER_COLORS, isLeatherLikeType } from "@/types/product";
import { ProductPreviewDialog } from "./product-preview-dialog";

interface ProductCardProps {
  product: Product;
  currentUserId: string;
  onDeleted?: () => void;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export function ProductCard({ product, currentUserId, onDeleted, selected, onToggleSelect }: ProductCardProps) {
  const router = useRouter();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  const isOwner = product.user_id === currentUserId;
  const ownerDisplay = product.owner_nickname || product.owner_email || "";
  const deployment = product.shopify_deployment ?? null;

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (!confirm(`Xóa "${product.name}"? Hành động này không thể hoàn tác.`)) return;

    try {
      const res = await fetch(`/api/products/${product.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      onDeleted?.();
      router.refresh();
    } catch (error) {
      console.error("Delete error:", error);
      alert("Không thể xóa sản phẩm");
    }
  }

  function handleCheckboxClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onToggleSelect?.(product.id);
  }

  const hasSurface = !!product.surface_url;

  const cardContent = (
    <Card className={`group cursor-pointer card-interactive overflow-hidden h-52 relative transition-all ${selected ? "ring-2 ring-primary" : ""}`}>
      {/* Checkbox overlay */}
      {onToggleSelect && (
        <div className="absolute top-2 left-2 z-10" onClick={handleCheckboxClick}>
          <Checkbox checked={selected ?? false} className="bg-background/80 backdrop-blur-sm shadow" />
        </div>
      )}

      <div className="flex h-full">
        {/* Left: Surface image */}
        <div className="relative w-2/5 flex-shrink-0 bg-muted overflow-hidden">
          {hasSurface ? (
            <>
              {!imageLoaded && <div className="absolute inset-0 animate-pulse bg-muted" />}
              <img
                src={product.surface_url!}
                alt={product.name}
                loading="lazy"
                onLoad={() => setImageLoaded(true)}
                className={`w-full h-full object-contain transition-opacity duration-300 ${imageLoaded ? "opacity-100" : "opacity-0"}`}
              />
            </>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-muted/60">
              <ImageOff className="h-6 w-6 text-muted-foreground/40" />
              <span className="text-[11px] text-muted-foreground/60 text-center leading-tight px-3">Chưa có bề mặt</span>
            </div>
          )}
        </div>

        {/* Right: Card info */}
        <div className="flex flex-col flex-1 min-w-0 p-4 gap-1">
          <div className="flex items-start justify-between gap-1">
            <div className="flex flex-col min-w-0 gap-0.5 flex-1">
              <p className="font-semibold text-sm leading-tight text-foreground break-words">{product.name}</p>

              <p className="text-xs text-muted-foreground capitalize">
                {product.type} cue
                {isLeatherLikeType(product.type) && product.color && <span className="ml-1">· {LEATHER_COLORS[product.color]?.name || product.color}</span>}
              </p>
            </div>
            {isOwner && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={handleDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {deployment && (
            <Badge variant="success" className="w-fit mt-0.5">
              <ShoppingBag className="h-3 w-3" />
              Đã kết nối Shopify
            </Badge>
          )}
          {deployment?.creator_nickname && (
            <p className="text-[11px] text-green-600/80 dark:text-green-400/80 truncate" title={`Shopify: ${deployment.creator_nickname}`}>
              Tạo bởi {deployment.creator_nickname}
            </p>
          )}
          <div className="mt-auto flex flex-col gap-1 pt-2">
            {ownerDisplay && (
              <p className="text-[11px] text-muted-foreground/70 truncate" title={ownerDisplay}>
                👤 {ownerDisplay}
              </p>
            )}

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{new Date(product.updated_at).toLocaleDateString("vi-VN")}</span>
              <span className="flex items-center gap-1 text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                {isOwner ? "Chỉnh sửa" : "Xem"}
                <ArrowRight className="h-3 w-3" />
              </span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );

  return (
    <>
      <Link href={`/dashboard/products/${product.id}`}>{cardContent}</Link>

      {hasSurface && <ProductPreviewDialog product={product} open={previewOpen} onOpenChange={setPreviewOpen} />}
    </>
  );
}

const LENS_SIZE = 220; // diameter px
const ZOOM = 1.8; // magnification factor — shows ~55% of image width, no letterbox
