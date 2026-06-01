import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, ExternalLink } from "lucide-react";
import type { ShopifyDeployment } from "@/types/product";

interface DeployedProductRow {
  deployment: ShopifyDeployment;
  productName: string;
  productUserId: string | null;
  creatorNickname: string | null;
  creatorEmail: string | null;
}

async function getDeployedProducts(): Promise<DeployedProductRow[]> {
  const supabase = await createServiceClient();

  const { data: deployments, error } = await supabase
    .from("shopify_deployments")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[admin] Failed to fetch shopify_deployments:", error.message);
    return [];
  }
  if (!deployments || deployments.length === 0) return [];

  const productIds = [...new Set(deployments.map((d) => d.product_id))];
  const creatorIds = [...new Set(deployments.map((d) => d.created_by).filter(Boolean))] as string[];

  const [{ data: products }, { data: profiles }] = await Promise.all([
    supabase.from("products").select("id, name, user_id").in("id", productIds),
    creatorIds.length
      ? supabase.from("user_profiles").select("user_id, nickname, email").in("user_id", creatorIds)
      : Promise.resolve({ data: [] as { user_id: string; nickname: string | null; email: string }[] }),
  ]);

  const productMap = new Map((products ?? []).map((p) => [p.id, p]));
  const profileMap = new Map((profiles ?? []).map((p) => [p.user_id, p]));

  return (deployments as ShopifyDeployment[]).map((d) => {
    const product = productMap.get(d.product_id);
    const creator = d.created_by ? profileMap.get(d.created_by) : undefined;
    return {
      deployment: d,
      productName: product?.name ?? "—",
      productUserId: product?.user_id ?? null,
      creatorNickname: creator?.nickname ?? null,
      creatorEmail: creator?.email ?? null,
    };
  });
}

export default async function AdminProductsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.app_metadata?.role !== "admin") {
    redirect("/admin/login");
  }

  const rows = await getDeployedProducts();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Package className="h-5 w-5" />
          Sản phẩm Shopify
          <span className="ml-auto text-sm font-normal text-muted-foreground">
            {rows.length} sản phẩm
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Chưa có sản phẩm nào được triển khai lên Shopify.
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
                {rows.map((r) => (
                  <tr key={r.deployment.id} className="border-b last:border-0 hover:bg-muted/50">
                    <td className="py-3 px-2">
                      <Link
                        href={`/dashboard/products/${r.deployment.product_id}`}
                        className="text-primary hover:underline"
                      >
                        {r.productName}
                      </Link>
                    </td>
                    <td className="py-3 px-2 text-muted-foreground">{r.deployment.title ?? "—"}</td>
                    <td className="py-3 px-2">
                      <Badge variant="outline">
                        {r.creatorNickname || r.creatorEmail || "—"}
                      </Badge>
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
                          <a
                            href={r.deployment.admin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            Admin <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {r.deployment.storefront_url && (
                          <a
                            href={r.deployment.storefront_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
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
      </CardContent>
    </Card>
  );
}
