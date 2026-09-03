"use client";

/**
 * Multi-select product list for /renders.
 *
 * Paging and thumbnails follow PickProductDialog / ProductsGrid rather than
 * inventing a third convention: newest first, 20 per page, infinite scroll plus
 * an explicit "Load All" so the list is never silently capped — the products
 * API clamps `limit` to 50, so a single fetch cannot show everything anyway.
 *
 * The surface thumbnail is the point of the list: cue names (n01-96, n02-81)
 * are indistinguishable from each other, so picking by name alone means
 * guessing. Same image source and object-fit as the product card, so a cue
 * looks the same wherever it appears.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ImageOff, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LEATHER_COLORS, isLeatherLikeType } from "@/types/product";
import type { Product } from "@/types/product";

/** Same page size as the dashboard grid, so both lists page identically. */
const PAGE_SIZE = 20;

interface RenderProductPickerProps {
  selectedIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
}

export function RenderProductPicker({
  selectedIds,
  onSelectionChange,
}: RenderProductPickerProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);
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
        console.error("RenderProductPicker fetch error:", err);
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

  useEffect(() => {
    offsetRef.current = 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPage(0, debouncedSearch, false);
  }, [debouncedSearch, fetchPage]);

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
      console.error("RenderProductPicker load-all error:", err);
    } finally {
      setIsLoadingAll(false);
    }
  }, [products, total, debouncedSearch]);

  const sentinelRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      if (!el) return;
      observerRef.current = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting && !isFetchingMore && !isLoadingAll && hasMore) {
            void fetchPage(offsetRef.current, debouncedSearch, true);
          }
        },
        { threshold: 0.1 }
      );
      observerRef.current.observe(el);
    },
    [isFetchingMore, isLoadingAll, hasMore, fetchPage, debouncedSearch]
  );

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  }

  /** Selects every product currently loaded — not the ones still unfetched,
   *  which would be a promise the list cannot keep. */
  function selectAllLoaded() {
    const next = new Set(selectedIds);
    for (const p of products) next.add(p.id);
    onSelectionChange(next);
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b p-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm sản phẩm theo tên..."
              className="pl-8"
            />
          </div>
          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleLoadAll()}
              disabled={isLoadingAll}
              className="shrink-0 gap-1.5"
            >
              {isLoadingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Tất cả ({total})
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Đã chọn {selectedIds.size}
            {total > 0 && <span className="ml-1 opacity-60">/ {total} sản phẩm</span>}
          </span>
          <span className="flex items-center gap-2">
            {products.length > 0 && (
              <button onClick={selectAllLoaded} className="hover:text-foreground">
                Chọn {products.length} đang hiện
              </button>
            )}
            {selectedIds.size > 0 && (
              <button
                onClick={() => onSelectionChange(new Set())}
                className="hover:text-foreground"
              >
                Bỏ chọn
              </button>
            )}
          </span>
        </div>
      </div>

      <div className="max-h-[480px] overflow-y-auto p-2">
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
            {products.map((p) => {
              const checked = selectedIds.has(p.id);
              return (
                // A div, not a button: Radix's Checkbox renders a <button>, and
                // HTML forbids nesting one button inside another — React reports
                // it as a hydration error. role/tabIndex/onKeyDown restore the
                // keyboard behaviour a real button would have given us.
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={checked}
                  onClick={() => toggle(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(p.id);
                    }
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    checked ? "bg-primary/10" : "hover:bg-muted"
                  )}
                >
                  {/* The row handles the toggle, so the checkbox is display
                      only — pointer-events-none keeps a click from firing the
                      toggle twice and cancelling itself out. */}
                  <Checkbox
                    checked={checked}
                    tabIndex={-1}
                    aria-hidden
                    className="pointer-events-none shrink-0"
                  />

                  {/* Surface thumbnail — same source and fit as the product card.
                      Tall on purpose: a cue wrap is a long vertical strip, and a
                      square crop of one is unreadable. */}
                  <div className="h-20 w-12 shrink-0 overflow-hidden rounded bg-muted">
                    {p.surface_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.surface_url}
                        alt={p.name}
                        loading="lazy"
                        draggable={false}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <ImageOff className="h-4 w-4 text-muted-foreground/40" />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="truncate text-xs capitalize text-muted-foreground">
                      {p.type} cue
                      {isLeatherLikeType(p.type) && p.color && (
                        <span className="ml-1">
                          · {LEATHER_COLORS[p.color]?.name || p.color}
                        </span>
                      )}
                    </div>
                    {(p.owner_nickname || p.owner_email) && (
                      <div className="truncate text-xs text-muted-foreground/60">
                        {p.owner_nickname || p.owner_email}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

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
    </div>
  );
}
