"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Package, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateProductDialog } from "@/components/products/create-product-dialog";
import { ProductCard } from "@/components/products/product-card";
import type { Product, ProductType } from "@/types/product";

type FilterType = "all" | ProductType;

const PAGE_SIZE = 20;

export function ProductsGrid() {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [search, setSearchRaw] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FilterType>("all");
  const offsetRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(async (offset: number, currentSearch: string, currentType: FilterType, append: boolean) => {
    if (offset === 0) setIsLoading(true);
    else setIsFetchingMore(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (currentSearch) params.set("search", currentSearch);
      if (currentType !== "all") params.set("type", currentType);

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

  // Reset + refetch when search/filter changes
  useEffect(() => {
    offsetRef.current = 0;
    setProducts([]);
    fetchPage(0, debouncedSearch, typeFilter, false);
  }, [debouncedSearch, typeFilter, fetchPage]);

  const hasMore = products.length < total;

  // IntersectionObserver sentinel
  const sentinelRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      if (!el) return;
      observerRef.current = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting && !isFetchingMore && hasMore) {
            fetchPage(offsetRef.current, debouncedSearch, typeFilter, true);
          }
        },
        { threshold: 0.1 }
      );
      observerRef.current.observe(el);
    },
    [isFetchingMore, hasMore, fetchPage, debouncedSearch, typeFilter]
  );

  const handleProductCreated = useCallback(() => {
    offsetRef.current = 0;
    setProducts([]);
    fetchPage(0, debouncedSearch, typeFilter, false);
  }, [fetchPage, debouncedSearch, typeFilter]);

  const handleProductDeleted = useCallback((id: string) => {
    setProducts((prev) => prev.filter((p) => p.id !== id));
    setTotal((prev) => prev - 1);
  }, []);

  const filters: { value: FilterType; label: string }[] = [
    { value: "all", label: "All" },
    { value: "smooth", label: "Smooth" },
    { value: "leather", label: "Leather" },
  ];

  return (
    <div>
      {/* Sticky toolbar */}

      <div
        className="sticky top-18 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pb-3 mb-6 -mx-4 px-4  z-0"
        style={{ borderColor: "rgba(255, 255, 255, 0) !important" }}
      >
        <div className="flex items-center justify-between gap-3 pt-4">
          <h2 className="text-2xl font-bold shrink-0">My Products</h2>
          <CreateProductDialog onCreated={handleProductCreated} />
        </div>
        <p className="text-muted-foreground text-sm mt-0.5">Create and customize your pool cue designs</p>
        <div className="flex items-center gap-2 mt-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input type="text" placeholder="Search by name..." value={search} onChange={(e) => setSearchRaw(e.target.value)} className="pl-8" />
          </div>
          <div className="flex gap-2">
            {filters.map((f) => (
              <Button key={f.value} variant={typeFilter === f.value ? "default" : "outline"} size="sm" onClick={() => setTypeFilter(f.value)}>
                {f.label}
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
            <h3 className="text-lg font-semibold mb-2 text-foreground">No products match your search</h3>
            <p className="text-muted-foreground max-w-sm mx-auto">Try adjusting your search or filter to find what you&apos;re looking for</p>
          </div>
        ) : (
          <div className="text-center py-16 bg-card rounded-xl border">
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10">
              <Package className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-2 text-foreground">No products yet</h3>
            <p className="text-muted-foreground mb-6 max-w-sm mx-auto">Create your first custom cue design to get started</p>
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
