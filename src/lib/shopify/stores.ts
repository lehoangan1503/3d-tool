/**
 * Multi-store registry. Stores are configured via the SHOPIFY_STORES env var as a
 * JSON array. Each store is a separate Shopify shop with its OWN Admin API access
 * token (a custom-app `shpat_...` token) — there is no single key spanning shops.
 *
 * Example SHOPIFY_STORES value (single line in .env):
 *   [{"id":"main","name":"Main Store","storeDomain":"your-store.myshopify.com","accessToken":"shpat_xxx","apiVersion":"2025-10","isDefault":true}]
 *
 * Back-compat: if SHOPIFY_STORES is unset, a single store is synthesised from the
 * legacy SHOPIFY_STORE / SHOPIFY_ACCESS_TOKEN / SHOPIFY_API_VERSION (+ OAuth)
 * vars so existing deployments keep working unchanged.
 */

/**
 * Per-store cue_spec_variants metaobject GIDs. These reference Metaobject
 * resources that live inside ONE specific shop, so they are NOT portable across
 * stores — each store must supply its own (or leave the map empty/partial, in
 * which case the builder skips the cue_spec_variants metafield for the missing
 * version/wrap combination rather than referencing a non-existent resource).
 *
 * Shape: { Standard: { wrap, wrapless }, Premium: {...}, Pro: {...}, Lux: {...} }.
 */
import { DEFAULT_PRODUCT_CODE_FORMAT, type ProductCodeFormatKey } from "./product-code";

export type SpecMetafieldMap = Record<string, Partial<Record<"wrap" | "wrapless", string>>>;

export interface ShopifyStore {
  id: string;
  name: string;
  /** e.g. "your-store.myshopify.com" */
  storeDomain: string;
  apiVersion: string;
  /** OAuth app credentials for THIS store (each store has its own app). */
  clientId: string;
  clientSecret: string;
  isDefault?: boolean;
  /** Per-store cue_spec_variants metaobject GIDs (empty = skip the metafield). */
  specMetafields: SpecMetafieldMap;
  /** Which product-code format this store enforces (validation + SKU/tag base). */
  codeFormat: ProductCodeFormatKey;
}

interface RawStore {
  id?: string;
  name?: string;
  storeDomain?: string;
  apiVersion?: string;
  clientId?: string;
  clientSecret?: string;
  isDefault?: boolean;
  specMetafields?: SpecMetafieldMap;
  codeFormat?: string;
}

/**
 * The original main shop's cue_spec_variants metaobject GIDs. Only used by the
 * legacy single-store fallback; multi-store setups carry their own GIDs in
 * SHOPIFY_STORES (see .env.example).
 */
const MAIN_STORE_SPEC_METAFIELDS: SpecMetafieldMap = {
  Standard: {
    wrap: "gid://shopify/Metaobject/170152984713",
    wrapless: "gid://shopify/Metaobject/181394309257",
  },
  Premium: {
    wrap: "gid://shopify/Metaobject/170153181321",
    wrapless: "gid://shopify/Metaobject/181394342025",
  },
  Pro: {
    wrap: "gid://shopify/Metaobject/181394374793",
    wrapless: "gid://shopify/Metaobject/181394833545",
  },
};

/** A placeholder value (not yet replaced) counts as missing. */
function isRealValue(v: string | undefined): boolean {
  return Boolean(v && !v.startsWith("REPLACE"));
}

function normalizeDomain(domain: string): string {
  const d = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return d.endsWith(".myshopify.com") ? d : `${d}.myshopify.com`;
}

const SPEC_VERSIONS = ["Standard", "Premium", "Pro", "Lux"] as const;
const WRAP_KEYS = ["wrap", "wrapless"] as const;

/**
 * Keep only well-formed { version: { wrap|wrapless: gid } } entries and ignore
 * anything else, so a malformed env value can never inject a bad reference.
 */
function sanitizeSpecMetafields(raw: SpecMetafieldMap | undefined): SpecMetafieldMap {
  const out: SpecMetafieldMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const version of SPEC_VERSIONS) {
    const entry = raw[version];
    if (!entry || typeof entry !== "object") continue;
    const cleaned: Partial<Record<"wrap" | "wrapless", string>> = {};
    for (const wrap of WRAP_KEYS) {
      const gid = entry[wrap];
      if (typeof gid === "string" && gid.startsWith("gid://shopify/Metaobject/")) {
        cleaned[wrap] = gid;
      }
    }
    if (Object.keys(cleaned).length) out[version] = cleaned;
  }
  return out;
}

/**
 * Resolve a store's product-code format. An explicit `codeFormat` in
 * SHOPIFY_STORES wins; otherwise the known Wow cue store (id "store2") defaults
 * to the "wowcue" format and everything else to the "nXX-YY" default — so the
 * existing env value works without edits.
 */
function resolveCodeFormat(raw: string | undefined, id: string): ProductCodeFormatKey {
  const v = raw?.trim().toLowerCase();
  if (v === "wowcue" || v === "primecues") return v;
  if (id === "store2") return "wowcue";
  return DEFAULT_PRODUCT_CODE_FORMAT;
}

let _cache: ShopifyStore[] | null = null;

function buildStores(): ShopifyStore[] {
  const raw = process.env.SHOPIFY_STORES?.trim();

  if (raw) {
    let parsed: RawStore[];
    try {
      parsed = JSON.parse(raw) as RawStore[];
    } catch {
      // Tolerate a common typo — a trailing comma before ] or } — then retry.
      try {
        parsed = JSON.parse(raw.replace(/,\s*([\]}])/g, "$1")) as RawStore[];
      } catch {
        console.error("[shopify-stores] SHOPIFY_STORES is not valid JSON — ignoring");
        parsed = [];
      }
    }
    const stores = parsed
      .filter((s) => s.storeDomain)
      .map((s, i): ShopifyStore => ({
        id: s.id ?? `store-${i}`,
        name: s.name ?? s.id ?? s.storeDomain ?? `Store ${i + 1}`,
        storeDomain: normalizeDomain(s.storeDomain!),
        apiVersion: s.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? "2025-10",
        // Each store carries its own OAuth app credentials. Treat leftover
        // "REPLACE..." placeholders as missing.
        clientId: isRealValue(s.clientId) ? s.clientId! : "",
        clientSecret: isRealValue(s.clientSecret) ? s.clientSecret! : "",
        isDefault: s.isDefault ?? false,
        specMetafields: sanitizeSpecMetafields(s.specMetafields),
        codeFormat: resolveCodeFormat(s.codeFormat, s.id ?? `store-${i}`),
      }));
    if (stores.length > 0) {
      if (!stores.some((s) => s.isDefault)) stores[0].isDefault = true;
      return stores;
    }
  }

  // Legacy single-store fallback — build one store from the flat SHOPIFY_* vars.
  const legacyDomain = process.env.SHOPIFY_STORE?.trim();
  if (legacyDomain) {
    return [
      {
        id: "default",
        name: "Default Store",
        storeDomain: normalizeDomain(legacyDomain),
        apiVersion: process.env.SHOPIFY_API_VERSION ?? "2025-10",
        clientId: process.env.SHOPIFY_CLIENT_ID ?? "",
        clientSecret: process.env.SHOPIFY_CLIENT_SECRET ?? "",
        isDefault: true,
        // Legacy single-store deployments are the original main shop, so carry
        // its known cue_spec_variants metaobject GIDs to preserve behaviour.
        specMetafields: MAIN_STORE_SPEC_METAFIELDS,
        codeFormat: DEFAULT_PRODUCT_CODE_FORMAT,
      },
    ];
  }

  return [];
}

export function getStores(): ShopifyStore[] {
  if (!_cache) _cache = buildStores();
  return _cache;
}

export function getDefaultStore(): ShopifyStore | null {
  const stores = getStores();
  return stores.find((s) => s.isDefault) ?? stores[0] ?? null;
}

export function getStore(id: string | null | undefined): ShopifyStore | null {
  const stores = getStores();
  if (!id) return getDefaultStore();
  return stores.find((s) => s.id === id) ?? getDefaultStore();
}

/** Public-safe store list for the switcher UI (no tokens). */
export function getStoresPublic(): Array<{ id: string; name: string; isDefault: boolean; codeFormat: ProductCodeFormatKey }> {
  return getStores().map((s) => ({ id: s.id, name: s.name, isDefault: Boolean(s.isDefault), codeFormat: s.codeFormat }));
}
