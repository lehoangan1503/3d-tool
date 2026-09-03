"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Loader2, ImageOff, Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LEATHER_COLORS, isLeatherLikeType } from "@/types/product";
import type { Product } from "@/types/product";

// Same page size as the dashboard grid so both lists page identically.
const PAGE_SIZE = 20;

interface PickProductDialogProps {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  onPick: (product: Product) => void;
}

/**
 * Product picker used by the dashboard's "Tham Chiếu 2D" tab. A reference layout
 * is not tied to any product, but the extractor needs a cue to render, so the
 * user picks which product to open the layout on.
 *
 * Paging mirrors ProductsGrid: newest first, 20 per page, infinite scroll plus a
 * "Load All" button — so the list is never silently capped.
 */
export function PickProductDialog({
  open,
  title,
  description,
  onClose,
  onPick,
}: PickProductDialogProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isLoadingAll, setIsLoadingAll] = useState(false);
  const offsetRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(
    async (offset: number, currentSearch: string, append: boolean) => {
      if (offset === 0) setIsLoading(true);
      else setIsFetchingMore(true);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        if (currentSearch) params.set("search", currentSearch);

        const res = await fetch(`/api/products?${params}`);
        if (!res.ok) throw new Error("Failed to fetch products");
        const { items, total: t }: { items: Product[]; total: number } = await res.json();

        setProducts((prev) => (append ? [...prev, ...items] : items));
        setTotal(t);
        offsetRef.current = offset + items.length;
      } catch (err) {
        console.error("PickProductDialog fetch error:", err);
        if (!append) {
          setProducts([]);
          setTotal(0);
        }
      } finally {
        setIsLoading(false);
        setIsFetchingMore(false);
      }
    },
    []
  );

  // Reset + refetch on open and whenever the search changes.
  useEffect(() => {
    if (!open) return;
    offsetRef.current = 0;
    setProducts([]);
    fetchPage(0, debouncedSearch, false);
  }, [open, debouncedSearch, fetchPage]);

  const hasMore = products.length < total;

  const handleLoadAll = useCallback(async () => {
    setIsLoadingAll(true);
    try {
      let accumulated = [...products];
      let currentOffset = offsetRef.current;
      let knownTotal = total;
      while (accumulated.length < knownTotal) {
        const params = new URLSearchParams({ limit: "50", offset: String(currentOffset) });
        if (debouncedSearch) params.set("search", debouncedSearch);

        const res = await fetch(`/api/products?${params}`);
        if (!res.ok) break;
        const { items, total: t }: { items: Product[]; total: number } = await res.json();
        knownTotal = t;
        if (items.length === 0) break;
        accumulated = [...accumulated, ...items];
        currentOffset += items.length;
      }
      setProducts(accumulated);
      setTotal(knownTotal);
      offsetRef.current = currentOffset;
    } catch (err) {
      console.error("PickProductDialog load-all error:", err);
    } finally {
      setIsLoadingAll(false);
    }
  }, [products, total, debouncedSearch]);

  // IntersectionObserver sentinel — same approach as ProductsGrid.
  const sentinelRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      if (!el) return;
      observerRef.current = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting && !isFetchingMore && !isLoadingAll && hasMore) {
            fetchPage(offsetRef.current, debouncedSearch, true);
          }
        },
        { threshold: 0.1 }
      );
      observerRef.current.observe(el);
    },
    [isFetchingMore, isLoadingAll, hasMore, fetchPage, debouncedSearch]
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md flex flex-col gap-0 p-0 overflow-hidden h-[560px]">
        <DialogHeader className="p-4 pb-3">
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>

        <div className="px-4 pb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Tìm sản phẩm..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleLoadAll}
              disabled={isLoadingAll}
              className="gap-1.5 shrink-0"
            >
              {isLoadingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Load All ({total})
            </Button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {isLoading && products.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : products.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Không tìm thấy sản phẩm nào.
            </p>
          ) : (
            <>
              {products.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onPick(p)}
                  className="w-full flex items-center gap-3 rounded-lg p-2 text-left hover:bg-muted transition-colors"
                >
                  {/* Surface thumbnail — same source and fit as the product card */}
                  <div className="flex-shrink-0 w-14 h-14 rounded overflow-hidden bg-muted">
                    {p.surface_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.surface_url}
                        alt={p.name}
                        loading="lazy"
                        draggable={false}
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <ImageOff className="h-4 w-4 text-muted-foreground/40" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{p.name}</div>
                    <div className="text-xs text-muted-foreground truncate capitalize">
                      {p.type} cue
                      {isLeatherLikeType(p.type) && p.color && (
                        <span className="ml-1">
                          · {LEATHER_COLORS[p.color]?.name || p.color}
                        </span>
                      )}
                      {(p.owner_nickname || p.owner_email) && (
                        <span className="ml-1.5 text-muted-foreground/60 normal-case">
                          · {p.owner_nickname || p.owner_email}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}

              {hasMore && (
                <div ref={sentinelRef} className="flex items-center justify-center py-4">
                  {(isFetchingMore || isLoadingAll) && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
