"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Package, Loader2, Copy, CheckSquare, Square, Download } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateProductDialog } from "@/components/products/create-product-dialog";
import { ProductCard } from "@/components/products/product-card";
import { BulkExportDialog } from "@/components/products/bulk-export-dialog";
import type { Product, ProductType } from "@/types/product";

type FilterType = "all" | ProductType;
type SortOrder = "asc" | "desc" | null;

const PAGE_SIZE = 20;

interface ProductsGridProps {
  currentUserId: string;
}

export function ProductsGrid({ currentUserId }: ProductsGridProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isLoadingAll, setIsLoadingAll] = useState(false);
  const [isCloningBulk, setIsCloningBulk] = useState(false);
  const [cloneProgress, setCloneProgress] = useState({ done: 0, total: 0 });
  const [bulkExportOpen, setBulkExportOpen] = useState(false);
  const [isBulkRecording, setIsBulkRecording] = useState(false);
  const [search, setSearchRaw] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FilterType>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>(null);
  const [myOnly, setMyOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const offsetRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(async (offset: number, currentSearch: string, currentType: FilterType, currentSort: SortOrder, currentMyOnly: boolean, append: boolean) => {
    if (offset === 0) setIsLoading(true);
    else setIsFetchingMore(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (currentSearch) params.set("search", currentSearch);
      if (currentType !== "all") params.set("type", currentType);
      if (currentSort) params.set("sort", currentSort);
      if (currentMyOnly) params.set("owner", "me");

      const res = await fetch(`/api/products?${params}`);
      if (!res.ok) throw new Error("Failed");
      const { items, total: t }: { items: Product[]; total: number } = await res.json();

      setProducts((prev) => (append ? [...prev, ...items] : items));
      setTotal(t);
      offsetRef.current = offset + items.length;
    } catch (err) {
      console.error("Failed to load products:", err);
    } finally {
      setIsLoading(false);
      setIsFetchingMore(false);
    }
  }, []);

  // Reset + refetch when search/filter/sort/myOnly changes
  useEffect(() => {
    offsetRef.current = 0;
    setProducts([]);
    setSelectedIds(new Set());
    fetchPage(0, debouncedSearch, typeFilter, sortOrder, myOnly, false);
  }, [debouncedSearch, typeFilter, sortOrder, myOnly, fetchPage]);

  const hasMore = products.length < total;

  // IntersectionObserver sentinel
  const sentinelRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      if (!el) return;
      observerRef.current = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting && !isFetchingMore && hasMore) {
            fetchPage(offsetRef.current, debouncedSearch, typeFilter, sortOrder, myOnly, true);
          }
        },
        { threshold: 0.1 }
      );
      observerRef.current.observe(el);
    },
    [isFetchingMore, hasMore, fetchPage, debouncedSearch, typeFilter, sortOrder, myOnly]
  );

  const handleProductCreated = useCallback(() => {
    offsetRef.current = 0;
    setProducts([]);
    setSelectedIds(new Set());
    fetchPage(0, debouncedSearch, typeFilter, sortOrder, myOnly, false);
  }, [fetchPage, debouncedSearch, typeFilter, sortOrder, myOnly]);

  const handleProductDeleted = useCallback((id: string) => {
    setProducts((prev) => prev.filter((p) => p.id !== id));
    setTotal((prev) => prev - 1);
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  // Selection handlers
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(products.map((p) => p.id)));
  }, [products]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Load all remaining pages, then optionally select all
  const handleLoadAll = useCallback(async (andSelectAll = false) => {
    setIsLoadingAll(true);
    try {
      let accumulated = [...products];
      let currentOffset = products.length;
      const knownTotal = total;

      while (currentOffset < knownTotal) {
        const params = new URLSearchParams({ limit: "50", offset: String(currentOffset) });
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (typeFilter !== "all") params.set("type", typeFilter);
        if (sortOrder) params.set("sort", sortOrder);
        if (myOnly) params.set("owner", "me");

        const res = await fetch(`/api/products?${params}`);
        if (!res.ok) break;
        const { items }: { items: Product[] } = await res.json();
        if (items.length === 0) break;

        accumulated = [...accumulated, ...items];
        currentOffset += items.length;
      }

      setProducts(accumulated);
      offsetRef.current = accumulated.length;

      if (andSelectAll) {
        setSelectedIds(new Set(accumulated.map((p) => p.id)));
      }
    } catch (err) {
      console.error("Failed to load all products:", err);
    } finally {
      setIsLoadingAll(false);
    }
  }, [products, total, debouncedSearch, typeFilter, sortOrder, myOnly]);

  // Clone all selected products sequentially
  const handleCloneSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    setIsCloningBulk(true);
    setCloneProgress({ done: 0, total: ids.length });

    try {
      for (const id of ids) {
        await fetch(`/api/products/${id}/clone`, { method: "POST" });
        setCloneProgress((prev) => ({ ...prev, done: prev.done + 1 }));
      }
    } finally {
      setIsCloningBulk(false);
      setCloneProgress({ done: 0, total: 0 });
      // Refresh grid
      setSelectedIds(new Set());
      offsetRef.current = 0;
      setProducts([]);
      fetchPage(0, debouncedSearch, typeFilter, sortOrder, myOnly, false);
    }
  }, [selectedIds, fetchPage, debouncedSearch, typeFilter, sortOrder, myOnly]);

  const filters: { value: FilterType; label: string }[] = [
    { value: "all", label: "Tất Cả" },
    { value: "smooth", label: "Trơn" },
    { value: "leather", label: "Da" },
  ];

  const sortOptions: { value: "asc" | "desc"; label: string }[] = [
    { value: "asc", label: "A-Z" },
    { value: "desc", label: "Z-A" },
  ];

  const hasActiveFilter = debouncedSearch || typeFilter !== "all" || myOnly;
  const allLoadedSelected = products.length > 0 && selectedIds.size === products.length;

  return (
    <div>
      {/* Sticky toolbar */}
      <div
        className="sticky top-18 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pb-3 mb-6 -mx-4 px-4 z-10"
        style={{ borderColor: "rgba(255, 255, 255, 0) !important" }}
      >
        <div className="flex items-center justify-between gap-3 pt-4">
          <h2 className="text-2xl font-bold shrink-0">{myOnly ? "Bản Của Tôi" : "Tất Cả Sản Phẩm"}</h2>
          <div className="flex items-center gap-2">
            {/* Bulk clone action */}
            {selectedIds.size > 0 && (
              <Button
                size="sm"
                onClick={handleCloneSelected}
                disabled={isCloningBulk}
                className="gap-1.5"
              >
                {isCloningBulk ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {cloneProgress.done}/{cloneProgress.total}
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Clone {selectedIds.size} sản phẩm
                  </>
                )}
              </Button>
            )}
            {/* Bulk export action */}
            {selectedIds.size > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBulkExportOpen(true)}
                className="gap-1.5 border-zinc-600 text-zinc-200 hover:bg-zinc-700"
              >
                <Download className="h-3.5 w-3.5" />
                Tải xuống nhiều
              </Button>
            )}
            <CreateProductDialog onCreated={handleProductCreated} />
          </div>
        </div>
        <p className="text-muted-foreground text-sm mt-0.5">{myOnly ? "Các thiết kế cơ bi-da của bạn" : "Tất cả thiết kế cơ bi-da của đội nhóm"}</p>

        <div className="flex items-center gap-2 mt-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input type="text" placeholder="Tìm theo tên..." value={search} onChange={(e) => setSearchRaw(e.target.value)} className="pl-8" />
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            {/* Selection controls */}
            <Button
              variant={allLoadedSelected ? "default" : "outline"}
              size="sm"
              onClick={allLoadedSelected ? deselectAll : selectAll}
              disabled={products.length === 0}
              className="gap-1.5"
            >
              {allLoadedSelected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
              {allLoadedSelected ? "Bỏ chọn tất cả" : "Tick All"}
            </Button>
            {hasMore && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleLoadAll(false)}
                disabled={isLoadingAll || isCloningBulk}
                className="gap-1.5"
              >
                {isLoadingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Load All ({total})
              </Button>
            )}
            {selectedIds.size > 0 && (
              <span className="text-xs text-muted-foreground px-1">
                {selectedIds.size} đã chọn
              </span>
            )}

            <div className="w-px bg-border self-stretch" />
            <Button variant={myOnly ? "default" : "outline"} size="sm" onClick={() => setMyOnly((v) => !v)}>
              Bạn
            </Button>
            <div className="w-px bg-border self-stretch" />
            {filters.map((f) => (
              <Button key={f.value} variant={typeFilter === f.value ? "default" : "outline"} size="sm" onClick={() => setTypeFilter(f.value)}>
                {f.label}
              </Button>
            ))}
            <div className="w-px bg-border self-stretch mx-1" />
            {sortOptions.map((s) => (
              <Button key={s.value} variant={sortOrder === s.value ? "default" : "outline"} size="sm" onClick={() => setSortOrder((prev) => (prev === s.value ? null : s.value))}>
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Grid */}
      {isBulkRecording ? (
        // Unmount all product cards (and their <img> GPU textures) during bulk recording
        // to free GPU texture memory for the recording WebGL context.
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Đang ghi video, vui lòng chờ...</p>
        </div>
      ) : isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : products.length === 0 ? (
        hasActiveFilter ? (
          <div className="text-center py-16 bg-card rounded-xl border">
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-full bg-muted">
              <Search className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2 text-foreground">Không tìm thấy sản phẩm nào</h3>
            <p className="text-muted-foreground max-w-sm mx-auto">Thử thay đổi từ khóa hoặc bộ lọc để tìm kiếm</p>
          </div>
        ) : (
          <div className="text-center py-16 bg-card rounded-xl border">
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10">
              <Package className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-2 text-foreground">Chưa có sản phẩm</h3>
            <p className="text-muted-foreground mb-6 max-w-sm mx-auto">Tạo thiết kế cơ tùy chỉnh đầu tiên của bạn để bắt đầu</p>
            <CreateProductDialog onCreated={handleProductCreated} />
          </div>
        )
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                currentUserId={currentUserId}
                onDeleted={() => handleProductDeleted(product.id)}
                selected={selectedIds.has(product.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>

          {/* Infinite scroll sentinel */}
          {hasMore && !isLoadingAll && (
            <div ref={sentinelRef} className="py-8 flex justify-center">
              {isFetchingMore && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
            </div>
          )}

          {/* Loading all indicator */}
          {isLoadingAll && (
            <div className="py-8 flex justify-center items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-5 w-5 animate-spin" />
              Đang tải tất cả sản phẩm...
            </div>
          )}
        </>
      )}

      {/* Bulk export dialog */}
      <BulkExportDialog
        open={bulkExportOpen}
        onClose={() => setBulkExportOpen(false)}
        products={products.filter((p) => selectedIds.has(p.id))}
        onRecordingChange={setIsBulkRecording}
      />
    </div>
  );
}
