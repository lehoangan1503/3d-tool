/**
 * Post-create Shopify steps — TypeScript port of the post-creation logic in
 * up_web_python/app/services/trello_shopify_service.py (process_card).
 *
 * After a product is created we:
 *   1. Map laser-shaft variant images (Yes → Mockup-Web-5, others → Mockup-Web-1)
 *   2. Promote Details/Package images to product metafields (custom.*), then
 *      delete those temporary images from the gallery
 *   3. Set the per-variant cue_spec metafield (already inlined at create time;
 *      kept here only for parity / future use)
 *   4. Publish the product to all sales channels
 *   5. Assign the product to collections (custom or smart; create smart if absent)
 *   6. Attach the rendered video (best-effort)
 *
 * Every step is best-effort: the product already exists, so we log failures
 * rather than aborting the whole deploy.
 */

import {
  type ShopifyCreatedProduct,
  setProductMetafield,
  setVariantImage,
  createFileFromImageUrl,
  getProductMediaGids,
  deleteProductImage,
  addProductToCollection,
  createSmartCollection,
  getAllCustomCollections,
  getAllSmartCollections,
  publishProductToAllChannels,
  publishCollectionToAllChannels,
  addProductVideo,
  moveProductMedia,
  type ShopifyCollectionRecord,
} from "./client";
import type { ShopifyProductPayload } from "./product-builder";

type PostCreateMetadata = ShopifyProductPayload["_metadata"];

interface PostCreateInput {
  product: ShopifyCreatedProduct;
  metadata: PostCreateMetadata;
  videoUrl: string | null;
  title: string;
}

/** Normalize a collection name for duplicate/lookup matching (case, apostrophes, spacing). */
function normalizeCollectionName(text: string): string {
  if (!text) return "";
  return text
    .normalize("NFKC")
    .replace(/[‘’‛′`´']/g, "")
    .trim()
    .split(/\s+/)
    .join(" ")
    .toLowerCase();
}

/** The same col_ tag the builder writes onto the product (lowercase, underscores). */
function collectionTag(name: string): string {
  return `col_${name.toLowerCase().trim().replace(/\s+/g, "_")}`;
}

export async function runPostCreateSteps({ product, metadata, videoUrl, title }: PostCreateInput): Promise<void> {
  const productId = product.id;

  // ── 1. Laser-shaft variant image mapping ──
  await mapLaserShaftImages(product, metadata);

  // ── 2. Image metafields (Details / Package) ──
  await setImageMetafields(product, metadata, title);

  // ── 3. Publish to all sales channels ──
  try {
    await publishProductToAllChannels(productId);
  } catch (err) {
    console.warn("[post-create] publish product:", err instanceof Error ? err.message : err);
  }

  // ── 4. Collections ──
  if (metadata.collections.length) {
    try {
      await assignToCollections(metadata.collections, productId);
    } catch (err) {
      console.warn("[post-create] assign collections:", err instanceof Error ? err.message : err);
    }
  }

  // ── 5. Video (best-effort) ──
  // Note: Shopify only accepts MP4/MOV for product video. The studio renders
  // WebM, so this may be rejected at processing time — logged, not fatal.
  if (videoUrl) {
    const contentType = videoUrl.toLowerCase().includes(".mp4") ? "video/mp4" : "video/webm";
    try {
      const videoMediaId = await addProductVideo(productId, videoUrl, title, contentType);
      // Place the video second in the gallery (index 1 = after the first image),
      // so it sits where the 2nd image would be. Best-effort: a reorder failure
      // (e.g. video still processing) just leaves it appended at the end.
      if (videoMediaId) {
        try {
          await moveProductMedia(productId, videoMediaId, 1);
        } catch (err) {
          console.warn("[post-create] move video to position 2:", err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.warn("[post-create] add video:", err instanceof Error ? err.message : err);
    }
  }
}

// ── Laser-shaft image mapping ────────────────────────────────────────────────

async function mapLaserShaftImages(product: ShopifyCreatedProduct, metadata: PostCreateMetadata): Promise<void> {
  const { laserShaftImagePosition, laserShaftDefaultImagePosition } = metadata;
  if (!laserShaftImagePosition) return;

  const posToImg = new Map(product.images.map((img) => [img.position, img]));
  const targetImgId = posToImg.get(laserShaftImagePosition)?.id;
  const defaultImgId = laserShaftDefaultImagePosition ? posToImg.get(laserShaftDefaultImagePosition)?.id : undefined;
  if (!targetImgId) return;

  // Find the Shaft Engraving option's position so we read the right variant.optionN.
  const laserOpt = product.options.find((o) => o.name.trim().toLowerCase() === "shaft engraving");
  if (!laserOpt) return;
  const optKey = `option${laserOpt.position}` as "option1" | "option2";

  for (const variant of product.variants) {
    const selected = String(variant[optKey] ?? "").trim().toLowerCase();
    const imageId = selected === "yes" ? targetImgId : defaultImgId;
    if (!imageId) continue;
    try {
      await setVariantImage(variant.id, imageId);
    } catch (err) {
      console.warn(`[post-create] map variant ${variant.id} image:`, err instanceof Error ? err.message : err);
    }
  }
}

// ── Image metafields (Details / Package) ─────────────────────────────────────

async function setImageMetafields(
  product: ShopifyCreatedProduct,
  metadata: PostCreateMetadata,
  title: string
): Promise<void> {
  if (!metadata.imageMetafields.length) return;
  const productId = product.id;

  const posToImg = new Map(product.images.map((img) => [img.position, img]));
  // Fallback: map of existing product media src → GID (used if fileCreate fails).
  let srcToGid: Map<string, string> = new Map();
  try {
    srcToGid = await getProductMediaGids(productId);
  } catch {
    /* fallback only; ignore */
  }

  const imagesToDelete: number[] = [];

  for (const mf of metadata.imageMetafields) {
    const img = posToImg.get(mf.position);
    if (!img?.src) continue;
    const srcClean = img.src.split("?")[0];

    let fileGid: string | null = null;
    let usedFallback = false;
    try {
      fileGid = await createFileFromImageUrl(img.src, title);
    } catch (err) {
      // Fall back to the existing product-media GID for this image.
      fileGid = srcToGid.get(srcClean) ?? null;
      usedFallback = Boolean(fileGid);
      if (!fileGid) {
        console.warn(`[post-create] metafield ${mf.metafieldKey} fileCreate:`, err instanceof Error ? err.message : err);
        continue;
      }
    }

    try {
      await setProductMetafield(productId, {
        namespace: "custom",
        key: mf.metafieldKey,
        type: "file_reference",
        value: fileGid,
      });
      // Only delete the temporary gallery image when it's backed by an
      // independent File. A fallback metafield still depends on the media.
      if (!usedFallback) imagesToDelete.push(img.id);
    } catch (err) {
      console.warn(`[post-create] set metafield ${mf.metafieldKey}:`, err instanceof Error ? err.message : err);
    }
  }

  for (const imageId of imagesToDelete) {
    try {
      await deleteProductImage(productId, imageId);
    } catch (err) {
      console.warn(`[post-create] delete gallery image ${imageId}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ── Collections ───────────────────────────────────────────────────────────────

async function assignToCollections(collections: string[], productId: number): Promise<void> {
  const [custom, smart] = await Promise.all([getAllCustomCollections(), getAllSmartCollections()]);

  const byName = (list: ShopifyCollectionRecord[]) => {
    const map = new Map<string, ShopifyCollectionRecord>();
    for (const c of list) {
      if (c.title) map.set(normalizeCollectionName(c.title), c);
    }
    return map;
  };
  const customByName = byName(custom);
  const smartByName = byName(smart);

  // Index smart collections by their tag-equals rule so a tag rule matches too.
  const smartByTag = new Map<string, ShopifyCollectionRecord>();
  for (const c of smart) {
    for (const rule of c.rules ?? []) {
      if (rule.column === "tag" && rule.relation === "equals" && rule.condition) {
        const key = normalizeCollectionName(rule.condition);
        if (!smartByTag.has(key)) smartByTag.set(key, c);
      }
    }
  }

  const publishedCollections = new Set<number>();
  const ensurePublished = async (id: number) => {
    if (publishedCollections.has(id)) return;
    publishedCollections.add(id);
    try {
      await publishCollectionToAllChannels(id);
    } catch (err) {
      console.warn(`[post-create] publish collection ${id}:`, err instanceof Error ? err.message : err);
    }
  };

  for (const raw of collections) {
    const name = raw.trim();
    if (!name) continue;
    const normName = normalizeCollectionName(name);
    const tag = collectionTag(name);
    const normTag = normalizeCollectionName(tag);

    const customCol = customByName.get(normName);
    const smartCol = smartByName.get(normName) ?? smartByTag.get(normTag);

    if (customCol) {
      // Custom collection → add the product via the Collects API.
      try {
        await addProductToCollection(customCol.id, productId);
      } catch (err) {
        console.warn(`[post-create] add to custom collection '${name}':`, err instanceof Error ? err.message : err);
      }
      await ensurePublished(customCol.id);
    } else if (smartCol) {
      // Smart collection already auto-matches the col_ tag; just ensure publish.
      await ensurePublished(smartCol.id);
    } else {
      // Create a new smart collection that matches the product's col_ tag.
      try {
        const created = await createSmartCollection(name, [
          { column: "tag", relation: "equals", condition: tag },
        ]);
        smartByName.set(normName, created);
        smartByTag.set(normTag, created);
        await ensurePublished(created.id);
      } catch (err) {
        console.warn(`[post-create] create smart collection '${name}':`, err instanceof Error ? err.message : err);
      }
    }
  }
}
