"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { StoreSwitcher, useStore } from "@/components/shopify/store-switcher";
import type { ShopifyDeployment } from "@/types/product";

export interface DeployedProductRow {
  deployment: ShopifyDeployment;
  productName: string;
  productUserId: string | null;
  creatorNickname: string | null;
  creatorEmail: string | null;
}

/**
 * Admin table of Shopify-deployed products, filtered to the currently-selected
 * store (matches the main dashboard). Each store's deployments are isolated.
 */
export function DeployedProductsTable({ rows }: { rows: DeployedProductRow[] }) {
  const { storeId, stores } = useStore();
  const storeName = stores.find((s) => s.id === storeId)?.name ?? null;

  const visible = useMemo(
    // Only live deployments (have a Shopify id) on the selected store.
    () => rows.filter((r) => r.deployment.shopify_product_id && (r.deployment.store_id ?? "main") === (storeId ?? "main")),
    [rows, storeId],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {storeName ? `Store: ${storeName} · ` : ""}
          {visible.length} sản phẩm
        </span>
        <StoreSwitcher />
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Chưa có sản phẩm nào được triển khai lên store này.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3 px-2 font-medium text-muted-foreground">Sản phẩm</th>
                <th className="text-left py-3 px-2 font-medium text-muted-foreground">Tiêu đề Shopify</th>
                <th className="text-left py-3 px-2 font-medium text-muted-foreground">Người tạo</th>
                <th className="text-left py-3 px-2 font-medium text-muted-foreground">Cập nhật</th>
                <th className="text-left py-3 px-2 font-medium text-muted-foreground">Liên kết</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.deployment.id} className="border-b last:border-0 hover:bg-muted/50">
                  <td className="py-3 px-2">
                    <Link href={`/dashboard/products/${r.deployment.product_id}`} className="text-primary hover:underline">
                      {r.productName}
                    </Link>
                  </td>
                  <td className="py-3 px-2 text-muted-foreground">{r.deployment.title ?? "—"}</td>
                  <td className="py-3 px-2">
                    <Badge variant="outline">{r.creatorNickname || r.creatorEmail || "—"}</Badge>
                  </td>
                  <td className="py-3 px-2 text-muted-foreground">
                    {new Date(r.deployment.updated_at).toLocaleDateString("vi-VN", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })}
                  </td>
                  <td className="py-3 px-2">
                    <div className="flex items-center gap-3">
                      {r.deployment.admin_url && (
                        <a href={r.deployment.admin_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          Admin <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {r.deployment.storefront_url && (
                        <a href={r.deployment.storefront_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          Store <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
