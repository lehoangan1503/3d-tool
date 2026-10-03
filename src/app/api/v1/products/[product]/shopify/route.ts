import { NextResponse } from "next/server";
import { createAdminServiceClient } from "@/lib/supabase/server";
import { asRenderStorageClient } from "@/lib/render/supabase-surface";
import { requireApiToken } from "@/lib/api-tokens/auth";
import { getStores } from "@/lib/shopify/stores";
import {
  canActOn,
  errorResponse,
  findProduct,
  loadLiveDeployments,
} from "@/lib/api-tokens/product-lookup";
import type { ApiShopifyStatus } from "@/types/api-token";

/**
 * GET /api/v1/products/[product]/shopify — has this product been deployed?
 *
 *   curl https://app/api/v1/products/n02-dragon-gold/shopify \
 *        -H "Authorization: Bearer cue_live_..."
 *   → { "deployed": true, "deployments": [{ "store": "main", ... }], ... }
 *
 * `deployed` is the answer; `deployments` says where. `?store=<id>` narrows the
 * question to one store. A product saved as a draft in the deploy dialog, or
 * one removed from Shopify, is `false` (see loadLiveDeployments).
 *
 * Answered from this app's deployment records, not by asking Shopify: those
 * records are what every other route (and the dashboard) treat as truth, and
 * a product deleted by hand in Shopify admin is outside what the app tracks.
 */

interface RouteParams {
  params: Promise<{ product: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    // Validated against the configured stores rather than passed through:
    // a typo would otherwise read as a confident `false`.
    const rawStore = new URL(request.url).searchParams.get("store")?.trim() || null;
    if (rawStore && !getStores().some((store) => store.id === rawStore)) {
      return errorResponse(
        `Unknown store "${rawStore}". Available: ${getStores()
          .map((store) => store.id)
          .join(", ")}.`,
        400
      );
    }

    const db = asRenderStorageClient(createAdminServiceClient());

    const { product: wanted } = await params;
    const found = await findProduct(db, ctx, wanted);
    if (!found.ok) return found.response;
    const product = found.value;

    if (!canActOn(ctx, product)) {
      return errorResponse(`Product not found: ${wanted}`, 404);
    }

    const live = await loadLiveDeployments(db, product.id);
    if (!live.ok) return live.response;

    const deployments = rawStore
      ? live.value.filter((deployment) => deployment.store === rawStore)
      : live.value;

    const body: ApiShopifyStatus = {
      product_id: product.id,
      name: product.name,
      deployed: deployments.length > 0,
      store: rawStore,
      deployments,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error("GET /api/v1/products/[product]/shopify error:", error);
    return errorResponse("Internal server error", 500);
  }
}
