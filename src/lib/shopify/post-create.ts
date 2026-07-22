/**
 * Post-create Shopify steps — TypeScript port of the post-creation logic in
 * up_web_python/app/services/trello_shopify_service.py (process_card).
 *
 * After a product is created we:
 *   1. Map laser-shaft variant images (Yes → Mockup-Web-5, others → Mockup-Web-1)
 *   2. Promote Details/Package images to product metafields (custom.*), then
 *      delete those temporary images from the gallery
 *   3. Upsert product-level metafields that are inlined on first create but not
 *      included in Shopify product PUT payloads on re-deploy
 *   4. Publish the product to all sales channels
 *   5. Assign the product to collections (custom or smart; create smart if absent)
 *   6. Attach the rendered video (best-effort)
 *
 * Every step is best-effort: the product already exists, so we log failures
 * rather than aborting the whole deploy.
 */

import {
  type ShopifyCreatedProduct,
  ensureProductMetafieldDefinition,
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

const PRODUCT_METAFIELD_DEFINITIONS = [
  {
    name: "Surface Slots",
    namespace: "custom",
    key: "surface_slots",
    type: "json",
    description: "Customer-fillable surface slot definitions for the storefront cue customizer.",
  },
  {
    name: "Surface Image",
    namespace: "custom",
    key: "surface_image",
    type: "single_line_text_field",
    description: "Public surface image URL used by the storefront cue customizer.",
  },
  {
    name: "Cue 3D Config",
    namespace: "custom",
    key: "cue_3d_config",
    type: "json",
    description: "Cue 3D model, surface, and material configuration for the storefront cue customizer.",
  },
  {
    name: "Shaft Config",
    namespace: "custom",
    key: "shaft_config",
    type: "json",
    description: "Laser shaft preview images and text frame positions for the storefront cue customizer.",
  },
] satisfies Array<{
  name: string;
  namespace: string;
  key: string;
  type: string;
  description: string;
}>;

interface PostCreateInput {
  product: ShopifyCreatedProduct;
  metadata: PostCreateMetadata;
  /** Legacy single video. Ignored when `videoUrls` is provided. */
  videoUrl: string | null;
  /** Ordered videos placed at gallery positions 2,3,... (after the 1st image). */
  videoUrls?: string[];
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

/** The same col_ tag the builder writes onto the product (prefix only, name kept as-is). */
function collectionTag(name: string): string {
  return `col_${name.trim()}`;
}

export async function runPostCreateSteps({ product, metadata, videoUrl, videoUrls, title }: PostCreateInput): Promise<void> {
  const productId = product.id;

  // ── 1. Laser-shaft variant image mapping ──
  await mapLaserShaftImages(product, metadata);

  // ── 2. Image metafields (Details / Package) ──
  await setImageMetafields(product, metadata, title);

  // ── 3. Product-level metafields (custom text, customizer slots, 3D config) ──
  await ensureProductMetafieldDefinitions(metadata);
  await setProductMetafields(productId, metadata);

  // ── 4. Publish to all sales channels ──
  try {
    await publishProductToAllChannels(productId);
  } catch (err) {
    console.warn("[post-create] publish product:", err instanceof Error ? err.message : err);
  }

  // ── 5. Collections ──
  // Keep the resolved name → collection-id map so the breadcrumb step (next)
  // can turn the picked collection name into a GID without re-fetching.
  let collectionIdsByName = new Map<string, number>();
  if (metadata.collections.length) {
    try {
      collectionIdsByName = await assignToCollections(metadata.collections, productId);
    } catch (err) {
      console.warn("[post-create] assign collections:", err instanceof Error ? err.message : err);
    }
  }

  // ── 5b. Breadcrumb collection metafield (custom.breadcrumb_collection) ──
  // The user picked one of the collections above to drive the storefront
  // breadcrumb. We write it as a collection_reference (GID). null = skip.
  if (metadata.breadcrumbCollection) {
    try {
      await setBreadcrumbCollection(productId, metadata.breadcrumbCollection, collectionIdsByName);
    } catch (err) {
      console.warn("[post-create] breadcrumb collection:", err instanceof Error ? err.message : err);
    }
  }

  // ── 6. Videos (best-effort) ──
  // Videos always sit right after the first image: positions 2,3,... (0-based
  // indices 1,2,...). Multiple videos keep their given order. Note Shopify only
  // accepts MP4/MOV for product video — the studio renders WebM, so this may be
  // rejected at processing time; logged, not fatal.
  const resolvedVideos = (videoUrls && videoUrls.length ? videoUrls : videoUrl ? [videoUrl] : []).filter(Boolean);
  // Add videos in order. Each is added then moved to its target index. We move
  // from LAST to FIRST so an earlier move can't be shifted by a later insert:
  // targetIndex = 1 + i for the i-th video (0-based), i.e. positions 2,3,...
  const addedVideos: Array<{ mediaId: string; targetIndex: number }> = [];
  for (let i = 0; i < resolvedVideos.length; i++) {
    const url = resolvedVideos[i];
    const contentType = url.toLowerCase().includes(".mp4") ? "video/mp4" : "video/webm";
    try {
      const videoMediaId = await addProductVideo(productId, url, title, contentType);
      if (videoMediaId) addedVideos.push({ mediaId: videoMediaId, targetIndex: 1 + i });
    } catch (err) {
      console.warn(`[post-create] add video ${i + 1}:`, err instanceof Error ? err.message : err);
    }
  }
  // Reorder each video to its slot after the first image. Videos start appended
  // at the end of the gallery (in add order V0,V1,...). Moving them front-to-back
  // — V0→index 1, then V1→index 2, ... — lands them as [img1, V0, V1, ..., rest]
  // because each move pulls the next video from the tail into its slot. Doing
  // this in reverse would interleave images between the videos. Best-effort: a
  // reorder failure (e.g. video still processing) just leaves it appended.
  for (let i = 0; i < addedVideos.length; i++) {
    const { mediaId, targetIndex } = addedVideos[i];
    try {
      await moveProductMedia(productId, mediaId, targetIndex);
    } catch (err) {
      console.warn(`[post-create] move video to position ${targetIndex + 1}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ── Product-level metafields ─────────────────────────────────────────────────

async function ensureProductMetafieldDefinitions(metadata: PostCreateMetadata): Promise<void> {
  if (!metadata.productMetafields.length) return;

  const neededKeys = new Set(
    metadata.productMetafields.map((metafield) => `${metafield.namespace}.${metafield.key}`),
  );

  for (const definition of PRODUCT_METAFIELD_DEFINITIONS) {
    if (!neededKeys.has(`${definition.namespace}.${definition.key}`)) continue;
    try {
      await ensureProductMetafieldDefinition(definition);
    } catch (err) {
      console.warn(
        `[post-create] ensure metafield definition ${definition.namespace}.${definition.key}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

async function setProductMetafields(productId: number, metadata: PostCreateMetadata): Promise<void> {
  if (!metadata.productMetafields.length) return;

  for (const metafield of metadata.productMetafields) {
    try {
      await setProductMetafield(productId, metafield);
    } catch (err) {
      console.warn(
        `[post-create] set metafield ${metafield.namespace}.${metafield.key}:`,
        err instanceof Error ? err.message : err,
      );
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

/**
 * Assign the product to each collection (custom/smart, creating smart ones as
 * needed) and return a map of normalized collection name → collection id, so the
 * caller can resolve a picked collection (e.g. the breadcrumb) to its GID.
 */
async function assignToCollections(collections: string[], productId: number): Promise<Map<string, number>> {
  const resolvedIds = new Map<string, number>();
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
      resolvedIds.set(normName, customCol.id);
    } else if (smartCol) {
      // Smart collection already auto-matches the col_ tag; just ensure publish.
      await ensurePublished(smartCol.id);
      resolvedIds.set(normName, smartCol.id);
    } else {
      // Create a new smart collection that matches the product's col_ tag.
      try {
        const created = await createSmartCollection(name, [
          { column: "tag", relation: "equals", condition: tag },
        ]);
        smartByName.set(normName, created);
        smartByTag.set(normTag, created);
        await ensurePublished(created.id);
        resolvedIds.set(normName, created.id);
      } catch (err) {
        console.warn(`[post-create] create smart collection '${name}':`, err instanceof Error ? err.message : err);
      }
    }
  }

  return resolvedIds;
}

/**
 * Write the picked breadcrumb collection to custom.breadcrumb_collection as a
 * collection_reference (GID). The collection id comes from assignToCollections'
 * resolved map; if it isn't there (e.g. its assign step failed), we skip rather
 * than write a dangling reference.
 */
async function setBreadcrumbCollection(
  productId: number,
  breadcrumbCollection: string,
  collectionIdsByName: Map<string, number>,
): Promise<void> {
  const collectionId = collectionIdsByName.get(normalizeCollectionName(breadcrumbCollection));
  if (!collectionId) {
    console.warn(
      `[post-create] breadcrumb collection '${breadcrumbCollection}' not resolved to an id; skipping metafield.`,
    );
    return;
  }
  await setProductMetafield(productId, {
    namespace: "custom",
    key: "breadcrumb_collection",
    type: "collection_reference",
    value: `gid://shopify/Collection/${collectionId}`,
  });
}
