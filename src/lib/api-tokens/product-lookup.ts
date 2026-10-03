/**
 * Shared lookups for the /api/v1/products/[product] routes.
 *
 * Every function here runs on the service key, so none of them decides who may
 * touch a product — the calling route does, from the token context.
 */

import { NextResponse } from "next/server";
import type { RenderStorageClient } from "@/lib/render/supabase-surface";
import { looksLikeId, resolveTargetName } from "@/lib/api-tokens/render-catalog";
import { RenderPayloadError } from "@/lib/render/build-payload";
import type { ApiShopifyDeployment, ApiTokenContext } from "@/types/api-token";

export interface ProductRow {
  id: string;
  name: string;
  user_id: string;
  surface_url: string | null;
  threejs_settings_id: string | null;
}

interface DeploymentRow {
  store_id: string;
  shopify_product_id: number | null;
  title: string | null;
  shopify_handle: string | null;
  admin_url: string | null;
  storefront_url: string | null;
  updated_at: string | null;
}

const PRODUCT_COLUMNS = "id, name, user_id, surface_url, threejs_settings_id";

const DEPLOYMENT_COLUMNS =
  "store_id, shopify_product_id, title, shopify_handle, admin_url, storefront_url, updated_at";

export type LookupResult<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

export function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Finds the product named in the URL.
 *
 * An id is looked up unscoped and the CALLER decides who may touch it. A name
 * is resolved only against the token owner's products — two users may well
 * share a name, and matching someone else's by name would be a guess.
 *
 * Any product that exists but is out of reach should be reported by the caller
 * as 404, never 403, so a token cannot probe which ids exist.
 */
export async function findProduct(
  db: RenderStorageClient,
  ctx: ApiTokenContext,
  wanted: string
): Promise<LookupResult<ProductRow>> {
  const trimmed = wanted.trim();
  if (trimmed.length === 0) {
    return { ok: false, response: errorResponse("Missing product name or id.", 400) };
  }

  if (looksLikeId(trimmed)) {
    const { data, error } = await db
      .from("products")
      .select<ProductRow>(PRODUCT_COLUMNS)
      .eq("id", trimmed.toLowerCase())
      .maybeSingle();

    if (error) {
      console.error("api/v1/products: lookup failed:", error.message);
      return { ok: false, response: errorResponse("Could not load the product.", 500) };
    }
    if (!data) {
      return { ok: false, response: errorResponse(`Product not found: ${trimmed}`, 404) };
    }
    return { ok: true, value: data };
  }

  const { data, error } = await db
    .from("products")
    .select<ProductRow>(PRODUCT_COLUMNS)
    .eq("user_id", ctx.userId);

  if (error) {
    console.error("api/v1/products: lookup failed:", error.message);
    return { ok: false, response: errorResponse("Could not load products.", 500) };
  }

  try {
    return { ok: true, value: resolveTargetName("product", trimmed, data ?? []) };
  } catch (resolveError) {
    if (resolveError instanceof RenderPayloadError) {
      return { ok: false, response: errorResponse(resolveError.message, resolveError.status) };
    }
    throw resolveError;
  }
}

/** Whether the token may act on this product at all (owner, or any admin). */
export function canActOn(ctx: ApiTokenContext, product: ProductRow): boolean {
  return product.user_id === ctx.userId || ctx.canActOnAnyProduct;
}

/**
 * The product's LIVE Shopify deployments, one per store.
 *
 * A shopify_deployments row alone does not mean "live": the deploy dialog's
 * Save button writes a draft row with no Shopify product (migration 020), and
 * removing a product from Shopify clears `shopify_product_id` but keeps the
 * row. Only rows that still carry a Shopify product id count.
 *
 * Filtered in code rather than with a NOT NULL filter because the narrowed
 * client surface (supabase-surface.ts) has no `.not()`; a product has at most
 * one row per store, so the extra rows read are negligible.
 */
export async function loadLiveDeployments(
  db: RenderStorageClient,
  productId: string
): Promise<LookupResult<ApiShopifyDeployment[]>> {
  const { data, error } = await db
    .from("shopify_deployments")
    .select<DeploymentRow>(DEPLOYMENT_COLUMNS)
    .eq("product_id", productId);

  if (error) {
    console.error("api/v1/products: deployment check failed:", error.message);
    return {
      ok: false,
      response: errorResponse("Could not check whether the product is live on Shopify.", 500),
    };
  }

  const live = (data ?? [])
    .filter((row) => row.shopify_product_id !== null)
    .map((row) => ({
      store: row.store_id,
      shopify_product_id: Number(row.shopify_product_id),
      title: row.title,
      handle: row.shopify_handle,
      admin_url: row.admin_url,
      storefront_url: row.storefront_url,
      deployed_at: row.updated_at,
    }));
  return { ok: true, value: live };
}
