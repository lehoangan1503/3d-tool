/**
 * Turning "whatever the operator has in front of them" into a product id.
 *
 * The audit and repair endpoints are pointed at a product by a person who is
 * looking at the storefront or the Shopify admin — so what they can paste is
 * the TITLE ("Novera Dragon Skull Wings Gothic Carbon Fiber Pool Cue"), or a
 * URL they copied from the address bar. What those endpoints need is a
 * `products.id`, and the internal product NAME (`n05-26-Skull`) is the one
 * thing that is nowhere on the page they are looking at.
 *
 * So every identifier a person can reasonably hold is accepted:
 *
 *   products.id                      uuid
 *   products.name                    n05-26-Skull
 *   shopify_deployments.title        Novera Dragon Skull Wings Gothic…
 *   shopify_deployments.shopify_handle   novera-dragon-skull-wings-…
 *   shopify_product_id               8746028531849
 *   a storefront or admin URL        https://…/products/novera-dragon-…
 *
 * Two rules keep this from guessing, and they matter more here than in the
 * render catalogue: these endpoints WRITE to a live product.
 *
 *   1. An ambiguous match is an error listing the candidates, never a pick.
 *      Nine titles are duplicated across the live catalogue today (two products
 *      really are both called "Uni Gold Skull Carbon Fiber Pool Cue"), so
 *      "first row wins" would eventually repair the wrong product's images.
 *   2. Exact matching first, and a substring pass only when nothing matched
 *      exactly — and even then only if it lands on exactly one product. A
 *      pasted title that is a prefix of two others must not resolve silently.
 */

/** A deployed product, as the matcher sees it. */
export interface DeployedProductRow {
  productId: string;
  /** Internal name, e.g. `n05-26-Skull`. Null for a product with no name. */
  productName: string | null;
  /** Shopify title of the deployment on the store being searched. */
  title: string | null;
  shopifyHandle: string | null;
  shopifyProductId: number | null;
}

export interface ResolveMatch {
  productId: string;
  /** Which field the input matched, for the response to explain itself. */
  matchedOn: "id" | "name" | "title" | "handle" | "shopify_id" | "title-partial";
  productName: string | null;
  title: string | null;
}

export type ResolveResult =
  | { ok: true; match: ResolveMatch }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; candidates: ResolveMatch[] };

/** Lowercase, collapse whitespace, drop accents — so a pasted title survives. */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the handle out of a Shopify URL.
 *
 * Covers both the storefront (`/products/<handle>`) and the admin
 * (`/products/<numeric id>`) shapes, because a person copying "the link to the
 * product" may well be in either tab.
 */
function handleFromUrl(value: string): { handle?: string; shopifyId?: number } {
  const match = value.match(/\/products\/([^/?#]+)/i);
  if (!match) return {};
  const tail = decodeURIComponent(match[1]);
  if (/^\d+$/.test(tail)) return { shopifyId: Number(tail) };
  return { handle: tail };
}

/**
 * Resolve one identifier against the deployed products on a store.
 *
 * `rows` is every deployment the caller is allowed to touch — scoping is the
 * caller's job, so a token can never reach another user's product through a
 * title it happened to guess.
 */
export function resolveDeployedProduct(
  input: string,
  rows: DeployedProductRow[]
): ResolveResult {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "not-found" };

  const needle = normalize(raw);
  const asMatch = (row: DeployedProductRow, matchedOn: ResolveMatch["matchedOn"]): ResolveMatch => ({
    productId: row.productId,
    matchedOn,
    productName: row.productName,
    title: row.title,
  });

  // A URL carries an unambiguous identifier; read it before anything else so a
  // pasted link never falls through to fuzzy title matching.
  const fromUrl = raw.includes("/products/") ? handleFromUrl(raw) : {};

  const exact: ResolveMatch[] = [];
  for (const row of rows) {
    if (row.productId === raw) exact.push(asMatch(row, "id"));
    else if (fromUrl.shopifyId && row.shopifyProductId === fromUrl.shopifyId) exact.push(asMatch(row, "shopify_id"));
    else if (fromUrl.handle && row.shopifyHandle && normalize(row.shopifyHandle) === normalize(fromUrl.handle)) exact.push(asMatch(row, "handle"));
    else if (!fromUrl.handle && !fromUrl.shopifyId) {
      if (row.productName && normalize(row.productName) === needle) exact.push(asMatch(row, "name"));
      else if (row.title && normalize(row.title) === needle) exact.push(asMatch(row, "title"));
      else if (row.shopifyHandle && normalize(row.shopifyHandle) === needle) exact.push(asMatch(row, "handle"));
      else if (/^\d+$/.test(raw) && row.shopifyProductId === Number(raw)) exact.push(asMatch(row, "shopify_id"));
    }
  }

  // De-duplicate: one product deployed to the store appears once, but a row
  // could match on two fields at once.
  const uniqueExact = dedupeByProduct(exact);
  if (uniqueExact.length === 1) return { ok: true, match: uniqueExact[0] };
  if (uniqueExact.length > 1) return { ok: false, reason: "ambiguous", candidates: uniqueExact };

  // Nothing matched exactly. Try a substring pass over the title — this is what
  // rescues a title pasted with a trailing "| Gothic Edition" the operator
  // trimmed, or a partial copy. Only accepted when it is unambiguous.
  if (needle.length >= 4) {
    const partial = dedupeByProduct(
      rows
        .filter((row) => row.title && normalize(row.title).includes(needle))
        .map((row) => asMatch(row, "title-partial"))
    );
    if (partial.length === 1) return { ok: true, match: partial[0] };
    if (partial.length > 1) return { ok: false, reason: "ambiguous", candidates: partial };
  }

  return { ok: false, reason: "not-found" };
}

function dedupeByProduct(matches: ResolveMatch[]): ResolveMatch[] {
  const byId = new Map<string, ResolveMatch>();
  for (const match of matches) {
    if (!byId.has(match.productId)) byId.set(match.productId, match);
  }
  return [...byId.values()];
}
