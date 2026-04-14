"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Package, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateProductDialog } from "@/components/products/create-product-dialog";
import { ProductCard } from "@/components/products/product-card";
import type { Product, ProductType } from "@/types/product";

type FilterType = "all" | ProductType;
type SortOrder = "asc" | "desc" | null;

const PAGE_SIZE = 20;

export function ProductsGrid() {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [search, setSearchRaw] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FilterType>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>(null);
  const offsetRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(async (offset: number, currentSearch: string, currentType: FilterType, currentSort: SortOrder, append: boolean) => {
    if (offset === 0) setIsLoading(true);
    else setIsFetchingMore(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (currentSearch) params.set("search", currentSearch);
      if (currentType !== "all") params.set("type", currentType);
      if (currentSort) params.set("sort", currentSort);

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

  // Reset + refetch when search/filter/sort changes
  useEffect(() => {
    offsetRef.current = 0;
    setProducts([]);
    fetchPage(0, debouncedSearch, typeFilter, sortOrder, false);
  }, [debouncedSearch, typeFilter, sortOrder, fetchPage]);

  const hasMore = products.length < total;

  // IntersectionObserver sentinel
  const sentinelRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      if (!el) return;
      observerRef.current = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting && !isFetchingMore && hasMore) {
            fetchPage(offsetRef.current, debouncedSearch, typeFilter, sortOrder, true);
          }
        },
        { threshold: 0.1 }
      );
      observerRef.current.observe(el);
    },
    [isFetchingMore, hasMore, fetchPage, debouncedSearch, typeFilter, sortOrder]
  );

  const handleProductCreated = useCallback(() => {
    offsetRef.current = 0;
    setProducts([]);
    fetchPage(0, debouncedSearch, typeFilter, sortOrder, false);
  }, [fetchPage, debouncedSearch, typeFilter, sortOrder]);

  const handleProductDeleted = useCallback((id: string) => {
    setProducts((prev) => prev.filter((p) => p.id !== id));
    setTotal((prev) => prev - 1);
  }, []);

  const filters: { value: FilterType; label: string }[] = [
    { value: "all", label: "Tất Cả" },
    { value: "smooth", label: "Trơn" },
    { value: "leather", label: "Da" },
  ];

  const sortOptions: { value: "asc" | "desc"; label: string }[] = [
    { value: "asc", label: "A-Z" },
    { value: "desc", label: "Z-A" },
  ];

  return (
    <div>
      {/* Sticky toolbar */}

      <div
        className="sticky top-18 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pb-3 mb-6 -mx-4 px-4  z-10"
        style={{ borderColor: "rgba(255, 255, 255, 0) !important" }}
      >
        <div className="flex items-center justify-between gap-3 pt-4">
          <h2 className="text-2xl font-bold shrink-0">Sản Phẩm Của Tôi</h2>
          <CreateProductDialog onCreated={handleProductCreated} />
        </div>
        <p className="text-muted-foreground text-sm mt-0.5">Tạo và tùy chỉnh thiết kế cơ bi-da của bạn</p>
        <div className="flex items-center gap-2 mt-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input type="text" placeholder="Tìm theo tên..." value={search} onChange={(e) => setSearchRaw(e.target.value)} className="pl-8" />
          </div>
          <div className="flex gap-2">
            {filters.map((f) => (
              <Button key={f.value} variant={typeFilter === f.value ? "default" : "outline"} size="sm" onClick={() => setTypeFilter(f.value)}>
                {f.label}
              </Button>
            ))}
            <div className="w-px bg-border self-stretch mx-1" />
            {sortOptions.map((s) => (
              <Button
                key={s.value}
                variant={sortOrder === s.value ? "default" : "outline"}
                size="sm"
                onClick={() => setSortOrder((prev) => (prev === s.value ? null : s.value))}
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : products.length === 0 ? (
        debouncedSearch || typeFilter !== "all" ? (
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
              <ProductCard key={product.id} product={product} onDeleted={() => handleProductDeleted(product.id)} />
            ))}
          </div>

          {/* Infinite scroll sentinel */}
          {hasMore && (
            <div ref={sentinelRef} className="py-8 flex justify-center">
              {isFetchingMore && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
