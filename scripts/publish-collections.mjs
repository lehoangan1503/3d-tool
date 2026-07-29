/**
 * Publish collections (and optionally products) to a store's Online Store channel.
 *
 * A collection created via the Admin API is NOT published to any sales channel by
 * default, so the storefront returns 404 for /collections/<handle> even though the
 * collection exists in admin. This script publishes anything not yet on the Online
 * Store publication.
 *
 * Idempotent: already-published resources are skipped.
 *
 * Usage:
 *   node scripts/publish-collections.mjs <storeId> [--apply] [--products]
 *
 * Options:
 *   --apply      actually publish (default is a DRY RUN)
 *   --products   also publish unpublished ACTIVE products
 */
import fs from "node:fs";

try {
  const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch (e) {
  console.warn("could not read .env:", e.message);
}

function loadStores() {
  const raw = process.env.SHOPIFY_STORES?.trim();
  if (!raw) throw new Error("SHOPIFY_STORES not set in .env");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = JSON.parse(raw.replace(/,\s*([\]}])/g, "$1")); }
  return parsed.map((s, i) => ({
    ...s,
    id: s.id ?? `store-${i}`,
    storeDomain: s.storeDomain.endsWith(".myshopify.com") ? s.storeDomain : `${s.storeDomain}.myshopify.com`,
    apiVersion: s.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? "2025-10",
  }));
}

async function getToken(store) {
  const res = await fetch(`https://${store.storeDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: store.clientId, client_secret: store.clientSecret }).toString(),
  });
  if (!res.ok) throw new Error(`token ${res.status} for ${store.storeDomain}: ${await res.text()}`);
  return (await res.json()).access_token;
}

function makeGql(store, token) {
  const run = async (query, variables, attempt = 0) => {
    const res = await fetch(`https://${store.storeDomain}/admin/api/${store.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) {
      const msg = Array.isArray(json.errors) ? json.errors.map((e) => e.message).join("; ") : String(json.errors);
      if (/throttl/i.test(msg) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        return run(query, variables, attempt + 1);
      }
      throw new Error(`${store.storeDomain}: ${msg}`);
    }
    return json.data;
  };
  return run;
}

const storeId = process.argv[2];
const APPLY = process.argv.includes("--apply");
const DO_PRODUCTS = process.argv.includes("--products");
if (!storeId) {
  console.error("Usage: node scripts/publish-collections.mjs <storeId> [--apply] [--products]");
  process.exit(1);
}

const store = loadStores().find((s) => s.id === storeId);
if (!store) throw new Error(`store "${storeId}" not found`);

const gql = makeGql(store, await getToken(store));
console.log(`store: ${store.name} (${store.storeDomain})`);
console.log(APPLY ? "MODE: APPLY\n" : "MODE: DRY RUN (pass --apply to write)\n");

const pubs = await gql(`{ publications(first: 20) { nodes { id name } } }`);
const online = pubs.publications.nodes.find((p) => /online store/i.test(p.name));
if (!online) throw new Error("no Online Store publication on this store");
console.log(`Online Store publication: ${online.id}\n`);

/** Publish in batches; publishablePublish takes one resource id at a time. */
async function publishAll(items, label) {
  let done = 0, failed = 0;
  for (const it of items) {
    if (!APPLY) { console.log(`   + would publish ${label} ${it.handle}`); done++; continue; }
    try {
      const r = await gql(
        `mutation($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            userErrors { field message }
          }
        }`,
        { id: it.id, input: [{ publicationId: online.id }] }
      );
      const errs = r.publishablePublish.userErrors ?? [];
      if (errs.length) { console.log(`   ! ${it.handle}: ${errs.map((e) => e.message).join("; ")}`); failed++; }
      else { console.log(`   + ${label} ${it.handle}`); done++; }
    } catch (e) {
      console.log(`   ! ${it.handle}: ${e.message.slice(0, 140)}`);
      failed++;
    }
  }
  return { done, failed };
}

// ── Collections ──────────────────────────────────────────────────────────────
const unpublishedCollections = [];
{
  let cursor = null;
  for (;;) {
    const d = await gql(
      `query($cursor: String) {
        collections(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle resourcePublications(first: 10) { nodes { publication { id } isPublished } } }
        }
      }`,
      { cursor }
    );
    for (const n of d.collections.nodes) {
      const on = n.resourcePublications.nodes.find((r) => r.publication.id === online.id);
      if (!on?.isPublished) unpublishedCollections.push({ id: n.id, handle: n.handle });
    }
    if (!d.collections.pageInfo.hasNextPage) break;
    cursor = d.collections.pageInfo.endCursor;
  }
}

console.log(`collections not on Online Store: ${unpublishedCollections.length}`);
const colResult = await publishAll(unpublishedCollections, "collection");

// ── Products (optional) ──────────────────────────────────────────────────────
let prodResult = { done: 0, failed: 0 };
if (DO_PRODUCTS) {
  const unpublishedProducts = [];
  let cursor = null;
  for (;;) {
    const d = await gql(
      `query($cursor: String) {
        products(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle status resourcePublications(first: 10) { nodes { publication { id } isPublished } } }
        }
      }`,
      { cursor }
    );
    for (const n of d.products.nodes) {
      // Only ACTIVE products belong on the storefront; draft/archived stay hidden.
      if (n.status !== "ACTIVE") continue;
      const on = n.resourcePublications.nodes.find((r) => r.publication.id === online.id);
      if (!on?.isPublished) unpublishedProducts.push({ id: n.id, handle: n.handle });
    }
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  console.log(`\nACTIVE products not on Online Store: ${unpublishedProducts.length}`);
  prodResult = await publishAll(unpublishedProducts, "product");
}

console.log(`\n${APPLY ? "published" : "would publish"}: collections=${colResult.done} products=${prodResult.done}  failed=${colResult.failed + prodResult.failed}`);
