/**
 * In-place Shopify product update.
 *
 * Replaces the old "delete + recreate" deploy path so a live product keeps its
 * Shopify product id (and therefore its order history) across re-deploys. The
 * product is ALWAYS updated, never deleted. Sub-resources that can't be updated
 * in place are deleted and the user's new version added in their place.
 *
 * Shopify's product PUT *appends* images instead of replacing them, so gallery
 * images are reconciled by hand. Variants, by contrast, ARE reconciled by the
 * product PUT itself:
 *
 *   • Core fields (title/body/tags/template/options) → PUT.
 *   • Variants → sent in the same PUT with the matching existing `id` injected
 *     by SKU. Shopify then UPDATES variants that carry an id (id + order history
 *     preserved), CREATES variants with no id (newly added by the user), and
 *     DELETES existing variants omitted from the array (removed by the user).
 *     A structural change (e.g. toggling laser shaft) changes every SKU, so no
 *     id matches and the whole variant set is cleanly replaced — product kept.
 *   • Gallery images → diffed by clean (query-stripped) CDN url: unchanged
 *     images are kept (id preserved), removed ones deleted, new ones added.
 *   • Video → old VIDEO media deleted, new one re-added by the post-create step
 *     (videos can't be reliably diffed by url, and there is at most one).
 *
 * The returned object mirrors `ShopifyCreatedProduct` (id/handle/images/
 * variants/options) so the existing post-create steps run unchanged.
 */

import {
  type ShopifyCreatedProduct,
  type ShopifyCreatedImage,
  updateShopifyProduct,
  getProductImages,
  addProductImage,
  deleteProductImage,
  getProductVariants,
  getProductMediaList,
  deleteProductMedia,
} from "./client";
import type { ShopifyProductPayload, ShopifyVariant } from "./product-builder";

/** A desired variant with an optional existing id merged in (id → update, no id → create). */
type VariantWithId = ShopifyVariant & { id?: number };

/** Strip the query string so two CDN urls for the same upload compare equal. */
function cleanUrl(url: string): string {
  return url.split("?")[0];
}

export interface UpdateInPlaceInput {
  shopifyProductId: number;
  payload: ShopifyProductPayload;
}

/**
 * Update an existing Shopify product in place and return a product shape
 * compatible with runPostCreateSteps (positions reflect the final gallery).
 */
export async function updateShopifyProductInPlace({
  shopifyProductId,
  payload,
}: UpdateInPlaceInput): Promise<ShopifyCreatedProduct> {
  const { product } = payload;

  // ── 1. Reconcile gallery images by clean CDN url ──
  // (Done before the PUT because the PUT does not carry images — Shopify's PUT
  // would append them rather than replace, so we manage the gallery directly.)
  const desired = product.images; // { src, alt, position }
  const existingImages = await getProductImages(shopifyProductId);
  const existingByUrl = new Map<string, ShopifyCreatedImage>();
  for (const img of existingImages) {
    if (img.src) existingByUrl.set(cleanUrl(img.src), img);
  }

  const desiredUrls = new Set(desired.map((d) => cleanUrl(d.src)));

  // Delete images no longer desired (changed or removed by the user).
  for (const img of existingImages) {
    if (!img.src) continue;
    if (!desiredUrls.has(cleanUrl(img.src))) {
      try {
        await deleteProductImage(shopifyProductId, img.id);
      } catch (err) {
        console.warn(`[update-in-place] delete image ${img.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // Build the final gallery in desired order: reuse unchanged images (keep their
  // id), add the new ones. `position` mirrors the desired payload so post-create
  // position lookups (laser-shaft / metafield images) stay correct.
  const finalImages: ShopifyCreatedImage[] = [];
  for (const d of desired) {
    const key = cleanUrl(d.src);
    const reused = existingByUrl.get(key);
    if (reused) {
      finalImages.push({ ...reused, position: d.position });
    } else {
      try {
        const added = await addProductImage(shopifyProductId, {
          src: d.src,
          alt: d.alt,
          position: d.position,
        });
        finalImages.push({ ...added, position: d.position });
      } catch (err) {
        console.warn(`[update-in-place] add image @${d.position}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // ── 2. Merge existing variant ids into the desired variants by SKU ──
  // id present → Shopify updates in place (preserves id/order history)
  // id absent  → Shopify creates the variant (user added it)
  // existing variant omitted here → Shopify deletes it (user removed it)
  const existingVariants = await getProductVariants(shopifyProductId);
  const existingBySku = new Map<string, number>();
  for (const v of existingVariants) {
    if (v.sku) existingBySku.set(v.sku, v.id);
  }

  const variantsWithIds: VariantWithId[] = product.variants.map((v) => {
    const id = v.sku ? existingBySku.get(v.sku) : undefined;
    return id ? { ...v, id } : { ...v };
  });

  // ── 3. PUT core fields + options + reconciled variants (NOT images) ──
  const updated = await updateShopifyProduct(shopifyProductId, {
    product: {
      id: shopifyProductId,
      title: product.title,
      body_html: product.body_html,
      vendor: product.vendor,
      product_type: product.product_type,
      tags: product.tags,
      status: product.status,
      ...(product.template_suffix ? { template_suffix: product.template_suffix } : {}),
      options: product.options,
      variants: variantsWithIds,
    },
  });

  // ── 4. Replace video media ──
  // Delete any existing VIDEO media; the post-create step re-adds the new one.
  try {
    const media = await getProductMediaList(shopifyProductId);
    const videoIds = media.filter((m) => m.mediaContentType === "VIDEO").map((m) => m.id);
    if (videoIds.length) await deleteProductMedia(shopifyProductId, videoIds);
  } catch (err) {
    console.warn("[update-in-place] delete old video:", err instanceof Error ? err.message : err);
  }

  // Return a ShopifyCreatedProduct-compatible shape for the post-create steps.
  // updated.variants reflects the reconciled set (new ids for created variants).
  return {
    id: updated.id,
    title: updated.title,
    handle: updated.handle,
    admin_graphql_api_id: updated.admin_graphql_api_id,
    images: finalImages,
    variants: updated.variants,
    options: updated.options,
  };
}
