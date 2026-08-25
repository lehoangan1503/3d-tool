import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";
import { getStore } from "@/lib/shopify/stores";
import type { ShopifyDeploymentSummary } from "@/types/product";

// GET /api/shopify/deployment?productId=…&storeId=… — the deployment row for a
// single product on a specific store (or null if not deployed there). Used by the
// deploy dialog to reflect the currently-selected store's state.
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId");
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });
  const storeId = getStore(searchParams.get("storeId"))?.id ?? "main";

  const { isToolAdmin, isMode } = await getSessionRole();
  if (!isToolAdmin && !isMode) return NextResponse.json({ deployment: null });

  // mode users only see their own product's deployment.
  if (isMode && !isToolAdmin) {
    const { data: prod } = await supabase
      .from("products")
      .select("user_id")
      .eq("id", productId)
      .single();
    if (!prod || prod.user_id !== user.id) return NextResponse.json({ deployment: null });
  }

  // Per-store deployment (live links) + the SHARED draft (form_data) fetched
  // together. The draft is store-independent so the form prefills the same way
  // no matter which store is selected.
  const [{ data: dep }, { data: draft }] = await Promise.all([
    supabase
      .from("shopify_deployments")
      .select("shopify_product_id, admin_url, storefront_url, title, created_by, created_at, form_data, deploy_template_id, image_group_id, video_template_id")
      .eq("product_id", productId)
      .eq("store_id", storeId)
      .maybeSingle(),
    supabase
      .from("shopify_drafts")
      .select("form_data")
      .eq("product_id", productId)
      .maybeSingle(),
  ]);

  // Prefer the shared draft, but fall back to the per-store deployment row's
  // own form_data. Older deployments (and store2 rows) saved form_data on the
  // deployment row and never wrote a shopify_drafts row, so a drafts-only read
  // returns null → the form renders empty even though the data exists.
  const formData =
    (draft?.form_data as ShopifyDeploymentSummary["form_data"]) ??
    (dep?.form_data as ShopifyDeploymentSummary["form_data"]) ??
    null;

  // What THIS store's last deploy used: price table + mockup group + video.
  // Read from the per-store deployment row, NOT the shared draft — the draft is
  // store-independent, so a product deployed with different price tables on two
  // stores would otherwise reopen on whichever was saved last.
  const deployTemplateId =
    (dep?.deploy_template_id as string | null | undefined) ?? formData?.deployTemplateId ?? null;
  const imageGroupId = (dep?.image_group_id as string | null | undefined) ?? null;
  const videoTemplateId = (dep?.video_template_id as string | null | undefined) ?? null;

  // No live deployment on this store: still return the shared draft so the editor
  // can edit/deploy. shopify_product_id stays null → shows as "not deployed here".
  if (!dep) {
    if (!formData) return NextResponse.json({ deployment: null });
    return NextResponse.json({
      deployment: {
        shopify_product_id: null,
        admin_url: null,
        storefront_url: null,
        title: null,
        form_data: formData,
        created_by: null,
        creator_nickname: null,
        created_at: null,
        deploy_template_id: deployTemplateId,
        image_group_id: imageGroupId,
        video_template_id: videoTemplateId,
      } satisfies ShopifyDeploymentSummary,
    });
  }

  let creatorNickname: string | null = null;
  if (dep.created_by) {
    const { data: creator } = await supabase
      .from("user_profiles")
      .select("nickname")
      .eq("user_id", dep.created_by)
      .single();
    creatorNickname = creator?.nickname ?? null;
  }

  const deployment: ShopifyDeploymentSummary = {
    shopify_product_id: dep.shopify_product_id,
    admin_url: dep.admin_url,
    storefront_url: dep.storefront_url,
    title: dep.title,
    form_data: formData,
    created_by: dep.created_by,
    creator_nickname: creatorNickname,
    created_at: dep.created_at,
    deploy_template_id: deployTemplateId,
    image_group_id: imageGroupId,
    video_template_id: videoTemplateId,
  };
  return NextResponse.json({ deployment });
}
