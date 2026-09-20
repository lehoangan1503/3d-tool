import { NextResponse } from "next/server";
import { createAdminServiceClient } from "@/lib/supabase/server";
import { asRenderDbClient } from "@/lib/render/supabase-surface";
import { requireApiToken } from "@/lib/api-tokens/auth";
import { loadRenderCatalog } from "@/lib/api-tokens/render-catalog";
import { errorResponse } from "@/lib/render/enqueue";
import { RenderPayloadError } from "@/lib/render/build-payload";
import { getStore } from "@/lib/shopify/stores";
import type { ApiDeployedProduct, ApiDeployedProductsResponse } from "@/types/api-token";

/**
 * GET /api/v1/shopify/products — what is live on a store, and from which group.
 *
 * The lookup step. An operator points at a product by whatever they have in
 * front of them — a storefront tab, a title in a screenshot, a code like
 * `n05-26` — and none of those is the product id the other endpoints take. This
 * turns any of them into one.
 *
 *   GET /api/v1/shopify/products?q=skull
 *   GET /api/v1/shopify/products?q=Novera%20Dragon%20Skull%20Wings   (tiêu đề dán từ store)
 *   GET /api/v1/shopify/products?store=main&limit=200
 *
 * `image_group_name` is carried here because it is what makes a sweep
 * actionable: "9 sản phẩm thiếu ảnh" is a shrug, "9 sản phẩm nhóm Novera chính
 * thức thiếu custom.package_box" is a fix. The audit groups by exactly this.
 *
 * Scoped to the token's owner, like every /api/v1 route — an admin's token sees
 * the whole catalogue, matching that person's reach in the dashboard.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

interface DeploymentRow {
  product_id: string;
  store_id: string | null;
  shopify_product_id: number | null;
  title: string | null;
  admin_url: string | null;
  storefront_url: string | null;
  image_group_id: string | null;
  created_at: string | null;
  shopify_handle: string | null;
}

export async function GET(request: Request) {
  try {
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const storeId = getStore(searchParams.get("store"))?.id ?? "main";
    const query = searchParams.get("q")?.trim().toLowerCase() ?? "";
    const limit = Math.min(
      Math.max(1, Number(searchParams.get("limit")) || DEFAULT_LIMIT),
      MAX_LIMIT
    );

    const db = createAdminServiceClient();

    let productQuery = db.from("products").select("id, name");
    if (!auth.ctx.canActOnAnyProduct) productQuery = productQuery.eq("user_id", auth.ctx.userId);
    const { data: productRows, error: productError } = await productQuery;
    if (productError) {
      throw new RenderPayloadError(`Failed to load products: ${productError.message}`, 500);
    }

    const products = (productRows ?? []) as Array<{ id: string; name: string | null }>;
    if (products.length === 0) {
      return NextResponse.json({
        store: storeId,
        count: 0,
        products: [],
        usage: { note: "Token này chưa có sản phẩm nào." },
      } satisfies ApiDeployedProductsResponse);
    }

    const nameById = new Map(products.map((row) => [row.id, row.name]));

    const { data: deploymentRows, error: deploymentError } = await db
      .from("shopify_deployments")
      .select(
        "product_id, store_id, shopify_product_id, title, shopify_handle, admin_url, storefront_url, image_group_id, created_at"
      )
      .eq("store_id", storeId)
      .not("shopify_product_id", "is", null)
      .in(
        "product_id",
        products.map((row) => row.id)
      )
      .order("created_at", { ascending: false })
      .limit(MAX_LIMIT);

    if (deploymentError) {
      throw new RenderPayloadError(`Failed to load deployments: ${deploymentError.message}`, 500);
    }

    const catalog = await loadRenderCatalog(asRenderDbClient(db));
    const groupNameById = new Map(catalog.groups.map((group) => [group.id, group.name]));

    const all: ApiDeployedProduct[] = ((deploymentRows ?? []) as DeploymentRow[])
      .filter((row): row is DeploymentRow & { shopify_product_id: number } =>
        typeof row.shopify_product_id === "number"
      )
      .map((row) => ({
        product_id: row.product_id,
        product_name: nameById.get(row.product_id) ?? null,
        shopify_product_id: row.shopify_product_id,
        title: row.title,
        handle: row.shopify_handle,
        store: row.store_id ?? storeId,
        admin_url: row.admin_url,
        storefront_url: row.storefront_url,
        image_group_id: row.image_group_id,
        image_group_name: row.image_group_id ? (groupNameById.get(row.image_group_id) ?? null) : null,
        deployed_at: row.created_at,
      }));

    // Substring match across everything a person might quote: the product name
    // (n05-26-skull), the Shopify title, the group name, and the handle — so
    // "skull", "Dragon Skull Wings", "Novera chính thức" and a handle copied
    // out of a storefront URL all find something.
    //
    // Accent-insensitive, because half these titles are Vietnamese and an
    // operator searching "gay danh" should find "GẬY ĐÁNH".
    const normalize = (value: string) =>
      value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const needle = normalize(query);
    // A pasted URL is matched by its handle, not as a whole string.
    const urlHandle = query.includes("/products/")
      ? normalize(decodeURIComponent(query.match(/\/products\/([^/?#]+)/i)?.[1] ?? ""))
      : "";
    const filtered = query
      ? all.filter((item) => {
          const haystack = [item.product_name, item.title, item.image_group_name, item.handle]
            .filter((value): value is string => Boolean(value))
            .map(normalize);
          if (urlHandle) return haystack.some((value) => value === urlHandle);
          return (
            haystack.some((value) => value.includes(needle)) ||
            String(item.shopify_product_id) === query
          );
        })
      : all;

    return NextResponse.json({
      store: storeId,
      count: filtered.length,
      products: filtered.slice(0, limit),
      usage: {
        note:
          "Truyền `product_name`, `product_id`, `title`, `handle` hoặc `shopify_product_id` " +
          "vào `product` của POST /api/v1/shopify/media-audit và media-repair — cả năm đều " +
          "được chấp nhận, kể cả link sản phẩm dán nguyên. `image_group_name` là nhóm ảnh " +
          "đã render ra sản phẩm này — audit dùng nó để suy ra ảnh nào đáng lẽ phải có.",
      },
    } satisfies ApiDeployedProductsResponse);
  } catch (error) {
    return errorResponse(error, "GET /api/v1/shopify/products");
  }
}
