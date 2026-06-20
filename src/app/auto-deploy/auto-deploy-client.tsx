"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ArrowLeft, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Product } from "@/types/product";
import { ProductSelector } from "@/components/auto-deploy/product-selector";
import { AutoDeployConfigForm } from "@/components/auto-deploy/config-form";
import { RunProgress } from "@/components/auto-deploy/run-progress";
import { emptyRunConfig, isRunConfigValid, type AutoDeployConfig } from "@/lib/auto-deploy/types";
import { canDeployProduct } from "@/lib/auto-deploy/group-products";
import { useRunDriver } from "@/lib/auto-deploy/use-run-driver";
import { StoreSwitcher, useStore } from "@/components/shopify/store-switcher";

type Step = "select" | "config" | "run";

interface ProductsResponse {
  items: Product[];
  total: number;
}

const PAGE_SIZE = 50; // API caps limit at 50

/** Load every product by walking the paginated /api/products endpoint. */
async function fetchAllProducts(signal: AbortSignal): Promise<Product[]> {
  const all: Product[] = [];
  let offset = 0;
  // Guard against an unexpected runaway loop.
  for (let page = 0; page < 200; page++) {
    const res = await fetch(`/api/products?limit=${PAGE_SIZE}&offset=${offset}&sort=asc`, { signal });
    if (!res.ok) throw new Error(`Failed to load products (${res.status})`);
    const json = (await res.json()) as ProductsResponse;
    all.push(...json.items);
    offset += json.items.length;
    if (json.items.length < PAGE_SIZE || offset >= json.total) break;
  }
  return all;
}

export function AutoDeployClient() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>("select");
  const [config, setConfig] = useState<AutoDeployConfig>(emptyRunConfig);

  const load = useCallback((signal: AbortSignal) => {
    return fetchAllProducts(signal)
      .then((items) => {
        if (!signal.aborted) setProducts(items);
      })
      .catch((e: unknown) => {
        if (signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    const ctrl = new AbortController();
    void load(ctrl.signal);
  }, [load]);

  const driver = useRunDriver();
  const { storeId, stores } = useStore();
  const activeStoreName = stores.find((s) => s.id === storeId)?.name ?? null;

  // Resolve the selected ids into products that can actually be deployed
  // (no-code products are unselectable, but guard anyway).
  const selectedProducts = useMemo(
    () => products.filter((p) => selectedIds.has(p.id) && canDeployProduct(p)),
    [products, selectedIds],
  );

  const selectedCount = selectedIds.size;
  const configValid = isRunConfigValid(config);

  // The active store is injected into the config at run time.
  const handleRun = useCallback(() => {
    setStep("run");
    void driver.start(selectedProducts, { ...config, storeId });
  }, [driver, selectedProducts, config, storeId]);

  const handleRetry = useCallback(() => {
    void driver.retryFailed({ ...config, storeId });
  }, [driver, config, storeId]);

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto px-4 py-8">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Triển khai tự động</h1>
          <p className="text-sm text-muted-foreground">
            Chọn sản phẩm, chọn nhóm khung &amp; cấu hình Shopify, rồi chạy tự động: render → tạo nội dung AI → tạo sản phẩm Shopify.
          </p>
        </div>
        <StoreSwitcher />
      </header>

      {step === "select" && (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">1. Chọn sản phẩm</h2>
              <span className="text-sm text-muted-foreground">Đã chọn {selectedCount} sản phẩm</span>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" /> Đang tải sản phẩm...
              </div>
            ) : error ? (
              <div className="flex flex-col items-center gap-3 py-16">
                <p className="text-sm text-destructive">{error}</p>
                <Button variant="outline" size="sm" onClick={retry}>
                  Thử lại
                </Button>
              </div>
            ) : (
              <ProductSelector
                products={products}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
              />
            )}
          </section>

          <div className="flex items-center justify-end border-t border-border pt-4">
            <Button disabled={selectedCount === 0} onClick={() => setStep("config")}>
              Tiếp theo: Chọn nhóm để render
            </Button>
          </div>
        </>
      )}

      {step === "config" && (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">2. Chọn nhóm để render &amp; cấu hình Shopify</h2>
              <span className="text-sm text-muted-foreground">{selectedCount} sản phẩm đã chọn</span>
            </div>
            <AutoDeployConfigForm value={config} onChange={setConfig} />
          </section>

          <div className="flex items-center justify-between border-t border-border pt-4">
            <Button variant="outline" onClick={() => setStep("select")}>
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Quay lại chọn sản phẩm
            </Button>
            <Button disabled={!configValid || selectedProducts.length === 0} onClick={handleRun}>
              <Rocket className="h-4 w-4 mr-1.5" />
              Triển khai tự động ({selectedProducts.length})
            </Button>
          </div>
        </>
      )}

      {step === "run" && (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">3. Triển khai</h2>
              {driver.running && (
                <Button variant="destructive" size="sm" onClick={driver.cancel}>
                  Hủy
                </Button>
              )}
            </div>
            {driver.prepError && (
              <p className="text-sm text-destructive">{driver.prepError}</p>
            )}
            <RunProgress
              items={driver.items}
              running={driver.running}
              finished={driver.finished}
              storeName={activeStoreName}
              onRetryFailed={handleRetry}
            />
          </section>

          <div className="flex items-center justify-between border-t border-border pt-4">
            <Button
              variant="outline"
              onClick={() => setStep("config")}
              disabled={driver.running}
            >
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Quay lại cấu hình
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
