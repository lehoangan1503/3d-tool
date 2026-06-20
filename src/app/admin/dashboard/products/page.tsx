import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Package } from "lucide-react";
import type { ShopifyDeployment } from "@/types/product";
import { DeployedProductsTable, type DeployedProductRow } from "./deployed-products-table";

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
        </CardTitle>
      </CardHeader>
      <CardContent>
        <DeployedProductsTable rows={rows} />
      </CardContent>
    </Card>
  );
}
