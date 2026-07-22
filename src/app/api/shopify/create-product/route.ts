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
import { updateShopifyProductInPlace } from "@/lib/shopify/update-in-place";
import { runPostCreateSteps } from "@/lib/shopify/post-create";
import { buildFormData, type ShopifyDeployRequest } from "@/lib/shopify/form-data";
import { withStore, activeStore } from "@/lib/shopify/store-context";
import { getStore } from "@/lib/shopify/stores";
import { getProductCodeFormat } from "@/lib/shopify/product-code";
import { parseProductTitle } from "@/lib/shopify/parse-title";
import type { ShaftConfig, SurfaceSlotsConfig, ThreeJSSettingsJson } from "@/types/product";

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

    const rawBody = await request.json() as ShopifyDeployRequest & {
      surface_slots?: SurfaceSlotsConfig | null;
      surface_image_url?: string | null;
      shaft_config?: ShaftConfig | null;
    };
    const body = rawBody as ShopifyDeployRequest;

    // All Shopify API calls below run against the store selected in the request
    // (defaults to the configured default store when storeId is omitted).
    return await withStore(body.storeId, async () => {

    const {
      productId,
      productCode,
      title,
      description,
      collections,
      imageUrls,
      imageNames = [],
      videoUrl = null,
      videoUrls,
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
    const hasRequestSurfaceSlots =
      Object.prototype.hasOwnProperty.call(rawBody, "surfaceSlots") ||
      Object.prototype.hasOwnProperty.call(rawBody, "surface_slots");
    const requestSurfaceSlots = Object.prototype.hasOwnProperty.call(rawBody, "surfaceSlots")
      ? body.surfaceSlots
      : rawBody.surface_slots;
    const hasRequestSurfaceImageUrl =
      Object.prototype.hasOwnProperty.call(rawBody, "surfaceImageUrl") ||
      Object.prototype.hasOwnProperty.call(rawBody, "surface_image_url");
    const requestSurfaceImageUrl = Object.prototype.hasOwnProperty.call(rawBody, "surfaceImageUrl")
      ? body.surfaceImageUrl
      : rawBody.surface_image_url;
    const hasRequestShaftConfig =
      Object.prototype.hasOwnProperty.call(rawBody, "shaftConfig") ||
      Object.prototype.hasOwnProperty.call(rawBody, "shaft_config");
    const requestShaftConfig = Object.prototype.hasOwnProperty.call(rawBody, "shaftConfig")
      ? body.shaftConfig
      : rawBody.shaft_config;

    // Auto tags (sku, wrap, laser shaft, col_<collection>) come from the builder;
    // these are the editor's extra freeform/test tags.
    const tags: string[] = manualTags;
    // Either free or paid custom text supplies the label/example metafields.
    const activeCustomText = customTextPaid ?? customText;

    // Validate product exists and enforce role scope:
    // admin → any product; mode → own products only.
    const { data: productRow, error: prodError } = await supabase
      .from("products")
      .select("id, user_id, name, type, surface_url, surface_slots, shaft_config, texture_type, color, threejs_settings_id")
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

    let threejsSettings: ThreeJSSettingsJson | null = null;
    if (productRow.threejs_settings_id) {
      const { data: settingsRow, error: settingsError } = await supabase
        .from("threejs_settings")
        .select("settings")
        .eq("id", productRow.threejs_settings_id)
        .maybeSingle();

      if (settingsError) {
        console.warn("Failed to load threejs_settings for Shopify 3D metafield:", settingsError.message);
      } else {
        threejsSettings = (settingsRow?.settings as ThreeJSSettingsJson | null) ?? null;
      }
    }

    // Resolve + validate the product code against the ACTIVE store's format.
    // Prime-cues uses nXX-YY; Wow cue uses W{initial}{number} (e.g. WA1). The
    // code becomes the variant SKU base and an auto-created tag downstream.
    //
    // Fall back to parsing it from the product name when the client sends an
    // empty/invalid code — guards against the client resolving the store format
    // late (which would otherwise drop the auto-tag).
    const codeFormat = getProductCodeFormat(activeStore().codeFormat);
    let resolvedCode = productCode?.trim() ?? "";
    if (!codeFormat.pattern.test(resolvedCode)) {
      resolvedCode = parseProductTitle(productRow.name ?? "", activeStore().codeFormat).code ?? "";
    }
    if (!codeFormat.pattern.test(resolvedCode)) {
      return NextResponse.json(
        { error: `Product code must match format ${codeFormat.label}` },
        { status: 400 }
      );
    }

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

    // Videos deploy as gallery media right after the 1st image (positions 2,3...).
    // Accept the new ordered videoUrls[]; fall back to the legacy single videoUrl.
    const resolvedVideoUrls = (videoUrls && videoUrls.length ? videoUrls : videoUrl ? [videoUrl] : []).filter(Boolean);

    const resolvedSurfaceSlots = hasRequestSurfaceSlots ? requestSurfaceSlots ?? null : productRow.surface_slots ?? null;
    const resolvedSurfaceImageUrl =
      !hasRequestSurfaceImageUrl
        ? productRow.surface_url ?? null
        : requestSurfaceImageUrl?.trim() || null;
    const resolvedShaftConfig = hasRequestShaftConfig ? requestShaftConfig ?? null : productRow.shaft_config ?? null;

    const payload = buildShopifyProduct({
      productCode: resolvedCode.toLowerCase(),
      productType: productRow.type,
      title: title.trim(),
      descriptionHtml,
      collections: collections ?? "",
      manualTags: tags,
      imageUrls,
      imageNames,
      // The dialog now controls gallery order explicitly (drag order wins).
      preserveImageOrder: true,
      versions,
      wrapType,
      laserShaft: Boolean(laserShaft),
      customImage: Boolean(customImage),
      customText: activeCustomText,
      customTextPaid: Boolean(customTextPaid),
      // Surface slot design (customer-fillable frames) + the surface image it
      // overlays — deployed as custom.surface_slots / custom.surface_image.
      surfaceSlots: resolvedSurfaceSlots,
      surfaceImageUrl: resolvedSurfaceImageUrl,
      shaftConfig: resolvedShaftConfig,
      textureType: productRow.texture_type ?? null,
      color: productRow.color ?? null,
      threejsSettings,
    });

    // Build the full form snapshot to persist for later edit / re-deploy.
    // Shared with the save-draft route via buildFormData() to avoid drift.
    const collectionList = (collections ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    // Persist the resolved code (server may have derived it from the name) so a
    // re-open shows the same code that was actually deployed.
    const formData = buildFormData({
      ...body,
      productCode: resolvedCode,
      manualTags: tags,
      surfaceSlots: resolvedSurfaceSlots,
      surfaceImageUrl: resolvedSurfaceImageUrl,
      shaftConfig: resolvedShaftConfig,
    });

    // Genuine service-role client (bypasses RLS) so admins can record
    // deployments on products they don't own; ownership/role enforced above.
    const service = createAdminServiceClient();

    // Re-deploy updates the live product IN PLACE so it keeps its Shopify
    // product id (and order history) — we never delete it, because deleting
    // loses the id of products that have already been ordered.
    //
    // Shopify's product PUT appends images rather than replacing them and may
    // recreate variant rows, so updateShopifyProductInPlace reconciles each
    // resource explicitly (images diffed by url, variants matched by SKU,
    // video old-deleted then re-added). First-time deploys still create fresh.
    const deployStoreId = activeStore().id;
    const { data: existing } = await service
      .from("shopify_deployments")
      .select("id, shopify_product_id")
      .eq("product_id", productId)
      .eq("store_id", deployStoreId)
      .maybeSingle();

    const hadLiveProduct = Boolean(existing?.shopify_product_id);

    const result = hadLiveProduct
      ? await updateShopifyProductInPlace({
          shopifyProductId: existing!.shopify_product_id as number,
          payload,
        })
      : await createShopifyProduct(payload);
    const isUpdate = hadLiveProduct; // reported to the UI as a re-deploy

    // Post-create: image metafields (Details/Package), laser-shaft variant
    // image mapping, variant metafields, collections, channel publishing, video.
    // Best-effort — the product already exists, so failures are logged not thrown.
    try {
      await runPostCreateSteps({
        product: result,
        metadata: payload._metadata,
        videoUrl: videoUrl ?? null,
        videoUrls: resolvedVideoUrls,
        title: title.trim(),
      });
    } catch (err) {
      console.error("Post-create steps failed:", err instanceof Error ? err.message : err);
    }

    const adminUrl = shopifyProductAdminUrl(result.id);
    const storefrontUrl = shopifyProductStorefrontUrl(result.handle);

    if (existing) {
      // Row exists (re-deploy) → point this store's row at the fresh product.
      const { error: updateError } = await service
        .from("shopify_deployments")
        .update({
          shopify_product_id: result.id,
          shopify_handle: result.handle,
          admin_url: adminUrl,
          storefront_url: storefrontUrl,
          title: result.title,
        })
        .eq("id", existing.id);
      if (updateError) console.error("Failed to update shopify_deployment:", updateError.message);
    } else {
      const { error: insertError } = await service
        .from("shopify_deployments")
        .insert({
          product_id: productId,
          store_id: deployStoreId,
          shopify_product_id: result.id,
          shopify_handle: result.handle,
          admin_url: adminUrl,
          storefront_url: storefrontUrl,
          title: result.title,
          created_by: user.id,
        });
      if (insertError) {
        // The Shopify product was created/updated successfully; surface the
        // tracking failure but don't fail the whole request.
        console.error("Failed to record shopify_deployment:", insertError.message);
      }
    }

    // Persist the SHARED draft (one per product, store-independent) so the form
    // reopens prefilled regardless of which store is selected next time.
    const { error: draftError } = await service
      .from("shopify_drafts")
      .upsert(
        { product_id: productId, form_data: formData, title: formData.title || null, updated_by: user.id },
        { onConflict: "product_id" },
      );
    if (draftError) console.error("Failed to save shared draft:", draftError.message);

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

    const { productId, storeId } = await request.json() as { productId: string; storeId?: string };
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

    const targetStoreId = getStore(storeId)?.id ?? "main";
    const service = createAdminServiceClient();
    const { data: existing } = await service
      .from("shopify_deployments")
      .select("id, shopify_product_id")
      .eq("product_id", productId)
      .eq("store_id", targetStoreId)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: "No Shopify deployment found" }, { status: 404 });
    }

    // Delete from Shopify (ignore if it was already gone).
    if (existing.shopify_product_id) {
      try {
        await withStore(storeId, () => deleteShopifyProduct(existing.shopify_product_id as number));
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
