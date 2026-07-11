/**
 * Shopify REST API client.
 * Always fetches token via client_credentials OAuth (2026+).
 * Token is cached in token.ts and auto-refreshed when expired.
 */

import { getShopifyToken } from "./token";
import { activeStore } from "./store-context";
import { getStores } from "./stores";

function shopifyUrl(path: string): string {
  const store = activeStore();
  return `https://${store.storeDomain}/admin/api/${store.apiVersion}${path}`;
}

async function getToken(): Promise<string> {
  return getShopifyToken();
}

async function shopifyRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  retries = 3
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const token = await getToken();
      const res = await fetch(shopifyUrl(path), {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "2", 10);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Shopify API ${res.status}: ${text}`);
      }

      return res.json() as Promise<T>;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError ?? new Error("Shopify request failed");
}

export interface ShopifyCreatedImage {
  id: number;
  position: number;
  src: string;
}

export interface ShopifyCreatedVariant {
  id: number;
  title: string;
  option1: string;
  option2?: string;
  sku?: string;
}

export interface ShopifyCreatedOption {
  name: string;
  position: number;
}

export interface ShopifyCreatedProduct {
  id: number;
  title: string;
  handle: string;
  admin_graphql_api_id: string;
  images: ShopifyCreatedImage[];
  variants: ShopifyCreatedVariant[];
  options: ShopifyCreatedOption[];
}

export async function createShopifyProduct(
  payload: unknown
): Promise<ShopifyCreatedProduct> {
  const data = await shopifyRequest<{ product: ShopifyCreatedProduct }>(
    "POST",
    "/products.json",
    payload
  );
  return data.product;
}

export async function updateShopifyProduct(
  shopifyProductId: number,
  payload: unknown
): Promise<ShopifyCreatedProduct> {
  const data = await shopifyRequest<{ product: ShopifyCreatedProduct }>(
    "PUT",
    `/products/${shopifyProductId}.json`,
    payload
  );
  return data.product;
}

export async function deleteShopifyProduct(shopifyProductId: number): Promise<void> {
  await shopifyRequest<unknown>("DELETE", `/products/${shopifyProductId}.json`);
}

// ── GraphQL ────────────────────────────────────────────────────────────────

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function shopifyGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await shopifyRequest<GraphQLResponse<T>>("POST", "/graphql.json", { query, variables });
  if (res.errors?.length) {
    throw new Error(`Shopify GraphQL: ${res.errors.map((e) => e.message).join("; ")}`);
  }
  if (!res.data) throw new Error("Shopify GraphQL: empty response");
  return res.data;
}

/** Normalize a numeric or full GID into a `gid://shopify/…` reference. */
function normalizeGid(value: string): string {
  return value.startsWith("gid://") ? value : value;
}

// ── Metafields ───────────────────────────────────────────────────────────────

export interface MetafieldInput {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

interface ShopifyMetafieldRecord extends MetafieldInput {
  id: number;
}

async function getProductMetafield(productId: number, namespace: string, key: string): Promise<ShopifyMetafieldRecord | null> {
  const data = await shopifyRequest<{ metafields: ShopifyMetafieldRecord[] }>(
    "GET",
    `/products/${productId}/metafields.json?namespace=${encodeURIComponent(namespace)}&key=${encodeURIComponent(key)}`
  );
  return data.metafields?.[0] ?? null;
}

export async function setProductMetafield(productId: number, metafield: MetafieldInput): Promise<void> {
  const value = normalizeGid(metafield.value);
  const existing = await getProductMetafield(productId, metafield.namespace, metafield.key);

  if (existing) {
    await shopifyRequest("PUT", `/metafields/${existing.id}.json`, {
      metafield: {
        id: existing.id,
        namespace: metafield.namespace,
        key: metafield.key,
        type: metafield.type,
        value,
      },
    });
    return;
  }

  await shopifyRequest("POST", `/products/${productId}/metafields.json`, {
    metafield: { ...metafield, value },
  });
}

export async function setVariantMetafield(variantId: number, metafield: MetafieldInput): Promise<void> {
  await shopifyRequest("POST", `/variants/${variantId}/metafields.json`, {
    metafield: { ...metafield, value: normalizeGid(metafield.value) },
  });
}

export interface ProductMetafieldDefinitionInput {
  name: string;
  namespace: string;
  key: string;
  type: string;
  description?: string;
}

export async function ensureProductMetafieldDefinition(definition: ProductMetafieldDefinitionInput): Promise<void> {
  const existing = await shopifyGraphQL<{
    metafieldDefinitions: { nodes: Array<{ id: string }> };
  }>(
    `query($namespace: String!, $key: String!) {
      metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: $namespace, key: $key) {
        nodes { id }
      }
    }`,
    { namespace: definition.namespace, key: definition.key },
  );

  if (existing.metafieldDefinitions.nodes.length > 0) return;

  const result = await shopifyGraphQL<{
    metafieldDefinitionCreate: {
      createdDefinition: { id: string } | null;
      userErrors: Array<{ code?: string; message: string }>;
    };
  }>(
    `mutation($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { code message }
      }
    }`,
    {
      definition: {
        ownerType: "PRODUCT",
        name: definition.name,
        namespace: definition.namespace,
        key: definition.key,
        type: definition.type,
        ...(definition.description ? { description: definition.description } : {}),
      },
    },
  );

  const errors = result.metafieldDefinitionCreate.userErrors ?? [];
  if (!errors.length) return;

  const alreadyExists = errors.every((error) => (
    error.code === "TAKEN" || /already|exists|taken/i.test(error.message)
  ));
  if (alreadyExists) return;

  throw new Error(
    `metafieldDefinitionCreate ${definition.namespace}.${definition.key}: ${errors
      .map((error) => error.message)
      .join("; ")}`
  );
}

// ── Variant images ────────────────────────────────────────────────────────────

export async function setVariantImage(variantId: number, imageId: number): Promise<void> {
  await shopifyRequest("PUT", `/variants/${variantId}.json`, {
    variant: { id: variantId, image_id: imageId },
  });
}

// ── Files (for image metafields) ───────────────────────────────────────────────

const FILE_CREATE_MUTATION = `
mutation fileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files {
      __typename
      ... on MediaImage { id fileStatus image { url } }
      ... on GenericFile { id fileStatus url }
    }
    userErrors { field message }
  }
}`;

/** Create an independent Shopify File from a public image URL → returns its GID. */
export async function createFileFromImageUrl(imageUrl: string, alt: string): Promise<string> {
  const data = await shopifyGraphQL<{
    fileCreate: { files: Array<{ id: string }>; userErrors: Array<{ message: string }> };
  }>(FILE_CREATE_MUTATION, { files: [{ contentType: "IMAGE", originalSource: imageUrl, alt }] });

  const errors = data.fileCreate.userErrors;
  if (errors?.length) throw new Error(`fileCreate: ${errors.map((e) => e.message).join("; ")}`);
  const gid = data.fileCreate.files?.[0]?.id;
  if (!gid) throw new Error("fileCreate returned no file id");
  return gid;
}

/** Map a product's media images by clean (query-stripped) CDN url → GID. */
export async function getProductMediaGids(productId: number): Promise<Map<string, string>> {
  const data = await shopifyGraphQL<{
    product: { media: { nodes: Array<{ id: string; mediaContentType: string; image?: { url: string } }> } } | null;
  }>(
    `query($id: ID!) {
      product(id: $id) {
        media(first: 50) { nodes { id mediaContentType ... on MediaImage { image { url } } } }
      }
    }`,
    { id: `gid://shopify/Product/${productId}` }
  );

  const map = new Map<string, string>();
  for (const node of data.product?.media.nodes ?? []) {
    if (node.mediaContentType !== "IMAGE") continue;
    const url = node.image?.url;
    if (url && node.id) map.set(url.split("?")[0], node.id);
  }
  return map;
}

export async function deleteProductImage(productId: number, imageId: number): Promise<void> {
  await shopifyRequest("DELETE", `/products/${productId}/images/${imageId}.json`);
}

// ── In-place update helpers (images / variants / video) ─────────────────────────

/** List a product's gallery images (REST) with id, src and position. */
export async function getProductImages(productId: number): Promise<ShopifyCreatedImage[]> {
  const data = await shopifyRequest<{ images: ShopifyCreatedImage[] }>(
    "GET",
    `/products/${productId}/images.json?limit=250`
  );
  return data.images ?? [];
}

export interface ShopifyImageInput {
  src: string;
  alt: string;
  position: number;
}

/** Add a single gallery image to an existing product → returns the created image. */
export async function addProductImage(
  productId: number,
  image: ShopifyImageInput
): Promise<ShopifyCreatedImage> {
  const data = await shopifyRequest<{ image: ShopifyCreatedImage }>(
    "POST",
    `/products/${productId}/images.json`,
    { image }
  );
  return data.image;
}

/** List a product's variants (REST) — id + sku for matching on re-deploy. */
export async function getProductVariants(productId: number): Promise<ShopifyCreatedVariant[]> {
  const data = await shopifyRequest<{ variants: ShopifyCreatedVariant[] }>(
    "GET",
    `/products/${productId}/variants.json?limit=250`
  );
  return data.variants ?? [];
}

/** A media node on a product (used to locate VIDEO media for replacement). */
export interface ShopifyMediaNode {
  id: string;
  mediaContentType: string;
}

/** List ALL media on a product (image + video + 3d) with their GIDs and types. */
export async function getProductMediaList(productId: number): Promise<ShopifyMediaNode[]> {
  const data = await shopifyGraphQL<{
    product: { media: { nodes: ShopifyMediaNode[] } } | null;
  }>(
    `query($id: ID!) {
      product(id: $id) {
        media(first: 100) { nodes { id mediaContentType } }
      }
    }`,
    { id: `gid://shopify/Product/${productId}` }
  );
  return data.product?.media.nodes ?? [];
}

const DELETE_MEDIA_MUTATION = `
mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    mediaUserErrors { field message }
  }
}`;

/** Delete media (by GID) from a product — used to remove old video before re-adding. */
export async function deleteProductMedia(productId: number, mediaIds: string[]): Promise<void> {
  if (!mediaIds.length) return;
  const data = await shopifyGraphQL<{
    productDeleteMedia: { mediaUserErrors: Array<{ message: string }> };
  }>(DELETE_MEDIA_MUTATION, {
    productId: `gid://shopify/Product/${productId}`,
    mediaIds,
  });
  const errors = data.productDeleteMedia.mediaUserErrors;
  if (errors?.length) throw new Error(`productDeleteMedia: ${errors.map((e) => e.message).join("; ")}`);
}

// ── Video media ─────────────────────────────────────────────────────────────

const STAGED_UPLOADS_MUTATION = `
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const CREATE_MEDIA_MUTATION = `
mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { ... on Video { id } status }
    mediaUserErrors { field message }
  }
}`;

interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
}

/**
 * Attach a self-hosted video file to a product. Shopify requires VIDEO media to
 * go through a staged upload (an arbitrary public URL is not accepted), so we:
 *   1. stagedUploadsCreate (resource: VIDEO) to get an upload target
 *   2. download the video bytes and POST them to that target
 *   3. productCreateMedia with the returned resourceUrl
 */
export async function addProductVideo(
  productId: number,
  videoUrl: string,
  alt: string,
  contentType = "video/webm"
): Promise<string | null> {
  // 1. Fetch the video bytes (from our own storage URL).
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`fetch video failed: ${videoRes.status}`);
  const blob = await videoRes.blob();
  const filename = videoUrl.split("/").pop()?.split("?")[0] || "mockup-video.webm";

  // 2. Create a staged upload target.
  const staged = await shopifyGraphQL<{
    stagedUploadsCreate: { stagedTargets: StagedTarget[]; userErrors: Array<{ message: string }> };
  }>(STAGED_UPLOADS_MUTATION, {
    input: [
      {
        filename,
        mimeType: contentType,
        resource: "VIDEO",
        fileSize: String(blob.size),
        httpMethod: "POST",
      },
    ],
  });
  const stagedErrors = staged.stagedUploadsCreate.userErrors;
  if (stagedErrors?.length) throw new Error(`stagedUploadsCreate: ${stagedErrors.map((e) => e.message).join("; ")}`);
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error("stagedUploadsCreate returned no target");

  // 3. Upload the bytes to the staged target (multipart form-data; file last).
  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", blob, filename);
  const uploadRes = await fetch(target.url, { method: "POST", body: form });
  if (!uploadRes.ok) throw new Error(`staged upload POST failed: ${uploadRes.status}`);

  // 4. Attach the staged video to the product.
  const data = await shopifyGraphQL<{
    productCreateMedia: { media: Array<{ id: string }>; mediaUserErrors: Array<{ message: string }> };
  }>(CREATE_MEDIA_MUTATION, {
    productId: `gid://shopify/Product/${productId}`,
    media: [{ originalSource: target.resourceUrl, alt, mediaContentType: "VIDEO" }],
  });
  const errors = data.productCreateMedia.mediaUserErrors;
  if (errors?.length) throw new Error(`productCreateMedia: ${errors.map((e) => e.message).join("; ")}`);
  // The created media GID lets the caller reposition the video in the gallery.
  return data.productCreateMedia.media?.[0]?.id ?? null;
}

const REORDER_MEDIA_MUTATION = `
mutation productReorderMedia($id: ID!, $moves: [MoveInput!]!) {
  productReorderMedia(id: $id, moves: $moves) {
    job { id }
    mediaUserErrors { field message }
  }
}`;

/**
 * Move a single media item to a target index (0-based) in the product gallery.
 * Shopify's reorder is a list of {id, newPosition} moves applied as a job; we
 * only move the one item, leaving the rest to shift around it.
 */
export async function moveProductMedia(productId: number, mediaId: string, newPosition: number): Promise<void> {
  const data = await shopifyGraphQL<{
    productReorderMedia: { mediaUserErrors: Array<{ message: string }> };
  }>(REORDER_MEDIA_MUTATION, {
    id: `gid://shopify/Product/${productId}`,
    moves: [{ id: mediaId, newPosition: String(newPosition) }],
  });
  const errors = data.productReorderMedia.mediaUserErrors;
  if (errors?.length) throw new Error(`productReorderMedia: ${errors.map((e) => e.message).join("; ")}`);
}

// ── Collections ────────────────────────────────────────────────────────────────

export interface ShopifyCollectionRecord {
  id: number;
  title: string;
  rules?: Array<{ column: string; relation: string; condition: string }>;
}

async function getAllCollections(kind: "custom_collections" | "smart_collections"): Promise<ShopifyCollectionRecord[]> {
  const all: ShopifyCollectionRecord[] = [];
  const limit = 250;
  let sinceId: number | null = null;
  // Paginate with since_id until a short page is returned.
  for (;;) {
    const query: string = `?limit=${limit}${sinceId ? `&since_id=${sinceId}` : ""}`;
    const data = await shopifyRequest<Record<string, ShopifyCollectionRecord[]>>("GET", `/${kind}.json${query}`);
    const page: ShopifyCollectionRecord[] = data[kind] ?? [];
    all.push(...page);
    if (page.length < limit) break;
    sinceId = page[page.length - 1].id;
  }
  return all;
}

export const getAllCustomCollections = () => getAllCollections("custom_collections");
export const getAllSmartCollections = () => getAllCollections("smart_collections");

export async function addProductToCollection(collectionId: number, productId: number): Promise<void> {
  await shopifyRequest("POST", "/collects.json", {
    collect: { product_id: productId, collection_id: collectionId },
  });
}

export async function createSmartCollection(
  title: string,
  rules: Array<{ column: string; relation: string; condition: string }>,
  published = true
): Promise<ShopifyCollectionRecord> {
  const data = await shopifyRequest<{ smart_collection: ShopifyCollectionRecord }>(
    "POST",
    "/smart_collections.json",
    { smart_collection: { title, rules, published } }
  );
  return data.smart_collection;
}

// ── Sales channels ─────────────────────────────────────────────────────────────

async function getPublicationIds(): Promise<string[]> {
  const data = await shopifyGraphQL<{ publications: { edges: Array<{ node: { id: string } }> } }>(
    `{ publications(first: 100) { edges { node { id name } } } }`
  );
  return data.publications.edges.map((e) => e.node.id);
}

const PUBLISH_MUTATION = `
mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}`;

/** Publish a product (or collection) GID to every available sales channel. */
async function publishToAllChannels(gid: string): Promise<void> {
  const ids = await getPublicationIds();
  if (!ids.length) return;
  await shopifyGraphQL<{ publishablePublish: { userErrors: Array<{ message: string }> } }>(PUBLISH_MUTATION, {
    id: gid,
    input: ids.map((publicationId) => ({ publicationId })),
  });
}

export const publishProductToAllChannels = (productId: number) =>
  publishToAllChannels(`gid://shopify/Product/${productId}`);
export const publishCollectionToAllChannels = (collectionId: number) =>
  publishToAllChannels(`gid://shopify/Collection/${collectionId}`);

export function shopifyProductAdminUrl(productId: number): string {
  return `https://${activeStore().storeDomain}/admin/products/${productId}`;
}

export function shopifyProductStorefrontUrl(handle: string): string {
  return `https://${activeStore().storeDomain}/products/${handle}`;
}

export function isShopifyConfigured(): boolean {
  // Configured when at least one store has usable OAuth credentials.
  return getStores().some((s) => s.clientId && s.clientSecret);
}
