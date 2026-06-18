"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, CheckSquare, Square } from "lucide-react";
import type { Product } from "@/types/product";
import { AutoDeployProductCard } from "./product-card";
import { groupProductsByPrefix, canDeployProduct, NO_CODE_GROUP } from "@/lib/auto-deploy/group-products";

interface ProductSelectorProps {
  products: Product[];
  /** Selected product ids — lifted to the parent so selection persists across tabs/search. */
  selectedIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
}

const SEARCH_TAB = "__search__";

/**
 * Multi-select product browser for /auto-deploy. Products are grouped into tabs by their
 * nXX prefix; a search tab filters across all products. Selection lives in the
 * parent and is NEVER reset on tab/search change, so picks persist. Choose-all /
 * Unchoose-all act only on the currently-visible, selectable subset.
 */
export function ProductSelector({ products, selectedIds, onSelectionChange }: ProductSelectorProps) {
  const groups = useMemo(() => groupProductsByPrefix(products), [products]);
  const [activeTab, setActiveTab] = useState<string>(() => groups[0]?.prefix ?? "");
  const [search, setSearch] = useState("");

  const searching = search.trim().length > 0;

  // The products visible in the current view (search overrides the active tab).
  const visibleProducts = useMemo(() => {
    if (searching) {
      const q = search.trim().toLowerCase();
      return products.filter((p) => p.name.toLowerCase().includes(q));
    }
    return groups.find((g) => g.prefix === activeTab)?.products ?? [];
  }, [searching, search, products, groups, activeTab]);

  // Only selectable (coded) products participate in choose-all / counts.
  const selectableVisible = useMemo(
    () => visibleProducts.filter(canDeployProduct),
    [visibleProducts],
  );
  const selectedVisibleCount = selectableVisible.filter((p) => selectedIds.has(p.id)).length;
  const allVisibleSelected = selectableVisible.length > 0 && selectedVisibleCount === selectableVisible.length;

  function toggleOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  }

  function chooseAllVisible() {
    const next = new Set(selectedIds);
    for (const p of selectableVisible) next.add(p.id);
    onSelectionChange(next);
  }

  function unchooseAllVisible() {
    const next = new Set(selectedIds);
    for (const p of selectableVisible) next.delete(p.id);
    onSelectionChange(next);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm sản phẩm theo tên..."
          className="pl-9"
        />
      </div>

      {/* Tabs (hidden while searching) */}
      {!searching && (
        <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
          {groups.map((g) => {
            const groupSelected = g.products.filter((p) => selectedIds.has(p.id)).length;
            const isActive = g.prefix === activeTab;
            return (
              <button
                key={g.prefix}
                onClick={() => setActiveTab(g.prefix)}
                className={[
                  "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                  isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
                  g.prefix === NO_CODE_GROUP ? "italic" : "",
                ].join(" ")}
              >
                {g.label}
                <span className="ml-1.5 opacity-70">({g.products.length})</span>
                {groupSelected > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center rounded-full bg-background/30 px-1.5 text-[10px]">
                    {groupSelected}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Choose all / Unchoose all for the visible subset */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {searching ? `Kết quả: ${visibleProducts.length}` : `Hiển thị: ${visibleProducts.length}`}
          {selectableVisible.length > 0 && ` · Đã chọn ${selectedVisibleCount}/${selectableVisible.length}`}
        </span>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={chooseAllVisible}
            disabled={selectableVisible.length === 0 || allVisibleSelected}
          >
            <CheckSquare className="h-3.5 w-3.5 mr-1.5" />
            Chọn tất cả
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={unchooseAllVisible}
            disabled={selectedVisibleCount === 0}
          >
            <Square className="h-3.5 w-3.5 mr-1.5" />
            Bỏ chọn
          </Button>
        </div>
      </div>

      {/* Cards */}
      {visibleProducts.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Không có sản phẩm nào</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-tab={searching ? SEARCH_TAB : activeTab}>
          {visibleProducts.map((p) => (
            <AutoDeployProductCard
              key={p.id}
              product={p}
              selected={selectedIds.has(p.id)}
              selectable={canDeployProduct(p)}
              onToggleSelect={toggleOne}
            />
          ))}
        </div>
      )}
    </div>
  );
}
