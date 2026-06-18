"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ImageOff, ShoppingBag, Ban } from "lucide-react";
import type { Product } from "@/types/product";
import { LEATHER_COLORS, isLeatherLikeType } from "@/types/product";

interface AutoDeployProductCardProps {
  product: Product;
  selected: boolean;
  /** False when the product has no valid nXX-YY code — shown but not selectable. */
  selectable: boolean;
  onToggleSelect: (id: string) => void;
}

/**
 * A selection-focused product card for /auto-deploy. Unlike the dashboard ProductCard,
 * clicking anywhere toggles selection (no navigation). No-code products render
 * dimmed with a badge and cannot be selected.
 */
export function AutoDeployProductCard({ product, selected, selectable, onToggleSelect }: AutoDeployProductCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);

  const hasSurface = !!product.surface_url;
  const deployment = product.shopify_deployment ?? null;

  function handleClick() {
    if (!selectable) return;
    onToggleSelect(product.id);
  }

  return (
    <Card
      onClick={handleClick}
      aria-disabled={!selectable}
      className={[
        "group overflow-hidden h-52 relative transition-all",
        selectable ? "cursor-pointer card-interactive" : "cursor-not-allowed opacity-60",
        selected ? "ring-2 ring-primary" : "",
      ].join(" ")}
    >
      {/* Checkbox overlay */}
      <div className="absolute top-2 left-2 z-10">
        <Checkbox checked={selected} disabled={!selectable} className="bg-background/80 backdrop-blur-sm shadow" />
      </div>

      {!selectable && (
        <div className="absolute top-2 right-2 z-10">
          <Badge variant="outline" className="gap-1 bg-background/80 backdrop-blur-sm">
            <Ban className="h-3 w-3" />
            Chưa có mã
          </Badge>
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
          <p className="font-semibold text-sm leading-tight text-foreground break-words">{product.name}</p>
          <p className="text-xs text-muted-foreground capitalize">
            {product.type} cue
            {isLeatherLikeType(product.type) && product.color && (
              <span className="ml-1">· {LEATHER_COLORS[product.color]?.name || product.color}</span>
            )}
          </p>
          {deployment && (
            <Badge variant="success" className="w-fit mt-0.5">
              <ShoppingBag className="h-3 w-3" />
              Đã kết nối Shopify
            </Badge>
          )}
          <div className="mt-auto flex items-center justify-between text-xs pt-2">
            <span className="text-muted-foreground">{new Date(product.updated_at).toLocaleDateString("vi-VN")}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
