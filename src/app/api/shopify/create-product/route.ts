import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";
import { buildShopifyProduct, markdownToHtml } from "@/lib/shopify/product-builder";
import {
  createShopifyProduct,
  deleteShopifyProduct,
  shopifyProductAdminUrl,
  shopifyProductStorefrontUrl,
  isShopifyConfigured,
} from "@/lib/shopify/client";
import { runPostCreateSteps } from "@/lib/shopify/post-create";
import { buildFormData, type ShopifyDeployRequest } from "@/lib/shopify/form-data";

const PRODUCT_CODE_PATTERN = /^(n\d{2})-(\d{2})$/i;

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
        { error: "Forbidden — Shopify deploy requires admin or mode role" },
        { status: 403 }
      );
    }

    if (!isShopifyConfigured()) {
      return NextResponse.json(
        { error: "Shopify credentials are not configured on the server." },
        { status: 503 }
      );
    }

    const body = await request.json() as ShopifyDeployRequest;

    const {
      productId,
      productCode,
      title,
      description,
      collections,
      imageUrls,
      imageNames = [],
      videoUrl = null,
      versions,
      wrapType,
      laserShaft,
      customImage = false,
      customText = null,
      customTextPaid = null,
      aiHint = "",
      aiModel = "",
      manualTags = [],
      skillIds = [],
    } = body;

    // Auto tags (sku, wrap, laser shaft, col_<collection>) come from the builder;
    // these are the editor's extra freeform/test tags.
    const tags: string[] = manualTags;
    // Either free or paid custom text supplies the label/example metafields.
    const activeCustomText = customTextPaid ?? customText;

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
        { error: "Forbidden — mode users can only deploy their own products" },
        { status: 403 }
      );
    }

    // Validate product code
    const codeMatch = productCode?.trim().match(PRODUCT_CODE_PATTERN);
    if (!codeMatch) {
      return NextResponse.json(
        { error: "Product code must match format nXX-YY (e.g. n01-05)" },
        { status: 400 }
      );
    }
    const employeeCode = codeMatch[1].toLowerCase();

    if (!title?.trim()) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    if (!versions?.length) {
      return NextResponse.json({ error: "At least one version is required" }, { status: 400 });
    }
    if (!wrapType) {
      return NextResponse.json({ error: "wrapType (wrap or wrapless) is required" }, { status: 400 });
    }
    if (!imageUrls?.length) {
      return NextResponse.json({ error: "At least one image URL is required" }, { status: 400 });
    }

    const descriptionHtml = markdownToHtml(description ?? "");

    const payload = buildShopifyProduct({
      productCode: productCode.toLowerCase(),
      employeeCode,
      title: title.trim(),
      descriptionHtml,
      collections: collections ?? "",
      manualTags: tags,
      imageUrls,
      imageNames,
      versions,
      wrapType,
      laserShaft: Boolean(laserShaft),
      customImage: Boolean(customImage),
      customText: activeCustomText,
      customTextPaid: Boolean(customTextPaid),
    });

    // Build the full form snapshot to persist for later edit / re-deploy.
    // Shared with the save-draft route via buildFormData() to avoid drift.
    const collectionList = (collections ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    const formData = buildFormData({ ...body, manualTags: tags });

    // Genuine service-role client (bypasses RLS) so admins can record
    // deployments on products they don't own; ownership/role enforced above.
    const service = createAdminServiceClient();

    // We NEVER update a Shopify product in place — Shopify's product PUT
    // appends images rather than replacing them. Instead, if a live product
    // already exists, delete it and create a fresh one. Our DB row persists
    // (form_data is the source of truth); only the Shopify side is recreated.
    const { data: existing } = await service
      .from("shopify_deployments")
      .select("id, shopify_product_id")
      .eq("product_id", productId)
      .maybeSingle();

    const hadLiveProduct = Boolean(existing?.shopify_product_id);

    // Delete the previous Shopify product first (best-effort; ignore 404).
    if (hadLiveProduct) {
      try {
        await deleteShopifyProduct(existing!.shopify_product_id as number);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (!m.includes("404")) {
          console.error("Failed to delete previous Shopify product before recreate:", m);
        }
      }
    }

    const result = await createShopifyProduct(payload);
    const isUpdate = hadLiveProduct; // reported to the UI as a re-deploy

    // Post-create: image metafields (Details/Package), laser-shaft variant
    // image mapping, variant metafields, collections, channel publishing, video.
    // Best-effort — the product already exists, so failures are logged not thrown.
    try {
      await runPostCreateSteps({
        product: result,
        metadata: payload._metadata,
        videoUrl: videoUrl ?? null,
        title: title.trim(),
      });
    } catch (err) {
      console.error("Post-create steps failed:", err instanceof Error ? err.message : err);
    }

    const adminUrl = shopifyProductAdminUrl(result.id);
    const storefrontUrl = shopifyProductStorefrontUrl(result.handle);

    if (existing) {
      // Row exists (re-deploy) → point it at the freshly created product.
      const { error: updateError } = await service
        .from("shopify_deployments")
        .update({
          shopify_product_id: result.id,
          shopify_handle: result.handle,
          admin_url: adminUrl,
          storefront_url: storefrontUrl,
          title: result.title,
          form_data: formData,
        })
        .eq("id", existing.id);
      if (updateError) console.error("Failed to update shopify_deployment:", updateError.message);
    } else {
      const { error: insertError } = await service
        .from("shopify_deployments")
        .insert({
          product_id: productId,
          shopify_product_id: result.id,
          shopify_handle: result.handle,
          admin_url: adminUrl,
          storefront_url: storefrontUrl,
          title: result.title,
          form_data: formData,
          created_by: user.id,
        });
      if (insertError) {
        // The Shopify product was created/updated successfully; surface the
        // tracking failure but don't fail the whole request.
        console.error("Failed to record shopify_deployment:", insertError.message);
      }
    }

    // Persist any new collections for the picker (best-effort).
    if (collectionList.length) {
      const { data: existingCols } = await service
        .from("shopify_collections")
        .select("value_lower");
      const seen = new Set((existingCols ?? []).map((r) => r.value_lower as string));
      const toInsert = collectionList
        .filter((c) => !seen.has(c.toLowerCase()))
        .map((value) => ({ value, created_by: user.id }));
      if (toInsert.length) {
        const { error: colError } = await service.from("shopify_collections").insert(toInsert);
        if (colError && !colError.message.includes("duplicate")) {
          console.error("Failed to save collections:", colError.message);
        }
      }
    }

    return NextResponse.json({
      success: true,
      isUpdate,
      productId: result.id,
      adminUrl,
      storefrontUrl,
      title: result.title,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    console.error("POST /api/shopify/create-product error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE — remove the Shopify product so it can be re-created. Keeps our saved
// form_data and the deployment row (clears the Shopify link) so the user can
// tweak and re-deploy. Role: admin any / mode own (same as deploy).
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { isAdmin, isMode } = await getSessionRole();
    if (!isAdmin && !isMode) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { productId } = await request.json() as { productId: string };
    if (!productId) {
      return NextResponse.json({ error: "productId is required" }, { status: 400 });
    }

    // Ownership scope for mode users.
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
        { error: "Forbidden — mode users can only delete their own products" },
        { status: 403 }
      );
    }

    const service = createAdminServiceClient();
    const { data: existing } = await service
      .from("shopify_deployments")
      .select("id, shopify_product_id")
      .eq("product_id", productId)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: "No Shopify deployment found" }, { status: 404 });
    }

    // Delete from Shopify (ignore if it was already gone).
    if (existing.shopify_product_id) {
      try {
        await deleteShopifyProduct(existing.shopify_product_id as number);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        // 404 = already deleted on Shopify; treat as success and clear our link.
        if (!m.includes("404")) {
          return NextResponse.json({ error: `Shopify delete failed: ${m}` }, { status: 502 });
        }
      }
    }

    // Clear the Shopify link but KEEP form_data for re-deploy.
    const { error: clearError } = await service
      .from("shopify_deployments")
      .update({
        shopify_product_id: null,
        shopify_handle: null,
        admin_url: null,
        storefront_url: null,
      })
      .eq("id", existing.id);
    if (clearError) {
      return NextResponse.json({ error: clearError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    console.error("DELETE /api/shopify/create-product error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
