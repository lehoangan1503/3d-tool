import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";
import { buildFormData, type ShopifyDeployRequest } from "@/lib/shopify/form-data";

// POST — save the deploy form as a DRAFT without touching Shopify.
// Writes form_data into the shopify_deployments row (insert if new, update if
// one already exists) so a not-yet-deployed product keeps its config across
// dialog reopens. A later Deploy fills in the live Shopify link on the same row.
// Role: admin any / mode own — identical scope to create-product.
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { isAdmin, isMode } = await getSessionRole();
    if (!isAdmin && !isMode) {
      return NextResponse.json(
        { error: "Forbidden — saving a draft requires admin or mode role" },
        { status: 403 }
      );
    }

    const body = await request.json() as ShopifyDeployRequest;
    const { productId } = body;

    if (!productId) {
      return NextResponse.json({ error: "productId is required" }, { status: 400 });
    }

    // Validate product exists and enforce role scope:
    // admin → any product; mode → own products only.
    const { data: productRow, error: prodError } = await supabase
      .from("products")
      .select("id, user_id")
      .eq("id", productId)
      .single();

    if (prodError || !productRow) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    if (!isAdmin && productRow.user_id !== user.id) {
      return NextResponse.json(
        { error: "Forbidden — mode users can only save their own products" },
        { status: 403 }
      );
    }

    // A draft can be incomplete — no required-field validation here. The
    // snapshot is stored verbatim and validated later when the user deploys.
    const formData = buildFormData(body);

    // Service-role client (bypasses RLS) so admins can save drafts on products
    // they don't own; ownership/role already enforced above.
    const service = createAdminServiceClient();

    // The draft is SHARED across stores — one row per product in shopify_drafts.
    const { error: upsertError } = await service
      .from("shopify_drafts")
      .upsert(
        {
          product_id: productId,
          form_data: formData,
          title: formData.title || null,
          updated_by: user.id,
        },
        { onConflict: "product_id" },
      );
    if (upsertError) {
      return NextResponse.json({ error: upsertError.message }, { status: 500 });
    }

    // Persist any new collections for the picker (best-effort) — same as deploy.
    if (formData.collections.length) {
      const { data: existingCols } = await service
        .from("shopify_collections")
        .select("value_lower");
      const seen = new Set((existingCols ?? []).map((r) => r.value_lower as string));
      const toInsert = formData.collections
        .filter((c) => !seen.has(c.toLowerCase()))
        .map((value) => ({ value, created_by: user.id }));
      if (toInsert.length) {
        const { error: colError } = await service.from("shopify_collections").insert(toInsert);
        if (colError && !colError.message.includes("duplicate")) {
          console.error("Failed to save collections:", colError.message);
        }
      }
    }

    return NextResponse.json({ success: true, formData });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    console.error("POST /api/shopify/save-draft error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
