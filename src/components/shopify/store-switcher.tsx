"use client";

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { Store, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DEFAULT_PRODUCT_CODE_FORMAT, type ProductCodeFormatKey } from "@/lib/shopify/product-code";

export interface StoreOption {
  id: string;
  name: string;
  isDefault: boolean;
  /** Product-code format this store enforces (nXX-YY vs WA1). */
  codeFormat: ProductCodeFormatKey;
}

interface StoreContextValue {
  stores: StoreOption[];
  /** Currently selected store id (persisted in localStorage). */
  storeId: string | null;
  setStoreId: (id: string) => void;
  loading: boolean;
  /** Product-code format of the currently selected store. */
  codeFormat: ProductCodeFormatKey;
}

const Ctx = createContext<StoreContextValue | null>(null);
const LS_KEY = "shopify.activeStoreId";

/**
 * Shares the selected Shopify store across the app (dashboard header, generate-
 * content dialog, /auto-deploy). Wrap the tree once; the switcher + consumers
 * read from this context. Selection persists in localStorage.
 */
export function StoreProvider({ children }: { children: ReactNode }) {
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storeId, setStoreIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetch("/api/shopify/stores")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        if (!mounted || !json?.items) return;
        const items = json.items as StoreOption[];
        setStores(items);
        const saved = typeof window !== "undefined" ? window.localStorage.getItem(LS_KEY) : null;
        const valid = saved && items.some((s) => s.id === saved) ? saved : null;
        const fallback = items.find((s) => s.isDefault)?.id ?? items[0]?.id ?? null;
        setStoreIdState(valid ?? fallback);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const setStoreId = useCallback((id: string) => {
    setStoreIdState(id);
    if (typeof window !== "undefined") window.localStorage.setItem(LS_KEY, id);
  }, []);

  const codeFormat = stores.find((s) => s.id === storeId)?.codeFormat ?? DEFAULT_PRODUCT_CODE_FORMAT;

  return <Ctx.Provider value={{ stores, storeId, setStoreId, loading, codeFormat }}>{children}</Ctx.Provider>;
}

export function useStore(): StoreContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used within a StoreProvider");
  return ctx;
}

/** Optional variant for components that may render outside a provider. */
export function useStoreOptional(): StoreContextValue | null {
  return useContext(Ctx);
}

/** Dropdown shown in headers to switch the active Shopify store. */
export function StoreSwitcher({ className }: { className?: string }) {
  const { stores, storeId, setStoreId, loading } = useStore();

  // Hide entirely when there's nothing to switch between.
  if (!loading && stores.length <= 1) return null;

  const current = stores.find((s) => s.id === storeId);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={className}>
          <Store className="h-4 w-4" />
          <span className="hidden sm:inline max-w-[10rem] truncate">
            {loading ? "..." : current?.name ?? "Chọn store"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="end">
        <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Shopify store</div>
        {stores.map((s) => (
          <button
            key={s.id}
            onClick={() => setStoreId(s.id)}
            className="flex items-center justify-between w-full px-2 py-1.5 rounded text-sm hover:bg-muted/60 text-left"
          >
            <span className="truncate">{s.name}</span>
            {s.id === storeId && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
