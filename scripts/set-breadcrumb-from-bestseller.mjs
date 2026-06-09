/**
 * Backfill custom.breadcrumb_collection for products in the "Best Seller" collection.
 *
 * Rule:
 *   - Target = every product belonging to the "Best Seller" collection.
 *   - Exclude "Best Seller" from the pick, always.
 *   - Among the remaining collections:
 *       · if "Uni Cues" is the ONLY one left  → pick "Uni Cues".
 *       · if there's another one besides Uni Cues → pick that other one
 *         (never Uni Cues, never Best Seller). Lowest collection id breaks ties.
 *   - Write the pick to custom.breadcrumb_collection (type collection_reference).
 *   - Skip products that already have custom.breadcrumb_collection set ("only fill empty").
 *   - Skip products whose only collection is "Best Seller".
 *
 * Run:
 *   node scripts/set-breadcrumb-from-bestseller.mjs          # dry run (no writes)
 *   node scripts/set-breadcrumb-from-bestseller.mjs --apply  # perform writes
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const BEST_SELLER = "Best Seller";
const UNI_CUES = "Uni Cues";
const norm = (s) => s.trim().toLowerCase();

// ── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  try {
    const raw = readFileSync(join(__dirname, "..", ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[m[1]] = v;
    }
  } catch (err) {
    console.error("Could not read .env:", err.message);
    process.exit(1);
  }
  return env;
}

const ENV = loadEnv();
const STORE = ENV.SHOPIFY_STORE ?? "";
const API_VERSION = ENV.SHOPIFY_API_VERSION ?? "2025-10";

// ── Auth (client_credentials, same as the app) ──────────────────────────────
let _token = null;
async function getToken() {
  if (_token) return _token;
  if (ENV.SHOPIFY_CLIENT_ID && ENV.SHOPIFY_CLIENT_SECRET) {
    const shopName = STORE.replace(/\.myshopify\.com$/, "");
    const res = await fetch(`https://${shopName}.myshopify.com/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: ENV.SHOPIFY_CLIENT_ID,
        client_secret: ENV.SHOPIFY_CLIENT_SECRET,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    _token = data.access_token;
  } else if (ENV.SHOPIFY_ACCESS_TOKEN) {
    _token = ENV.SHOPIFY_ACCESS_TOKEN;
  } else {
    throw new Error("No Shopify credentials in .env");
  }
  return _token;
}

// ── GraphQL helper with 429 retry ────────────────────────────────────────────
async function gql(query, variables = {}) {
  const url = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getToken();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.errors?.length) {
      // THROTTLED comes back as a top-level error too on some versions.
      const throttled = json.errors.some((e) => /throttl/i.test(e.message));
      if (throttled) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    return json.data;
  }
  throw new Error("GraphQL: exhausted retries (throttled)");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Find the "Best Seller" collection ────────────────────────────────────────
async function findBestSellerCollection() {
  const data = await gql(
    `query($q: String!) {
      collections(first: 10, query: $q) {
        nodes { id title handle productsCount { count } }
      }
    }`,
    { q: `title:'${BEST_SELLER}'` }
  );
  const nodes = data.collections.nodes;
  // query is fuzzy — match the exact title (case-insensitive).
  const exact = nodes.find((n) => n.title.trim().toLowerCase() === BEST_SELLER.toLowerCase());
  return exact ?? null;
}

// ── Page through the collection's products, pulling each product's
//    collections + existing breadcrumb metafield in the same query ────────────
async function* iterateBestSellerProducts(collectionId) {
  let cursor = null;
  do {
    const data = await gql(
      `query($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              breadcrumb: metafield(namespace: "custom", key: "breadcrumb_collection") { value }
              collections(first: 50) {
                nodes { id title }
              }
            }
          }
        }
      }`,
      { id: collectionId, cursor }
    );
    const conn = data.collection.products;
    for (const p of conn.nodes) yield p;
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}

function gidNum(gid) {
  const m = String(gid).match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// ── Write the metafield ──────────────────────────────────────────────────────
async function setBreadcrumb(productGid, collectionGid) {
  const data = await gql(
    `mutation($mf: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $mf) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      mf: [{
        ownerId: productGid,
        namespace: "custom",
        key: "breadcrumb_collection",
        type: "collection_reference",
        value: collectionGid,
      }],
    }
  );
  const errs = data.metafieldsSet.userErrors;
  if (errs?.length) throw new Error(errs.map((e) => `${e.field}: ${e.message}`).join("; "));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Store: ${STORE} | API ${API_VERSION} | mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  console.log("");

  const bs = await findBestSellerCollection();
  if (!bs) {
    console.error(`Collection "${BEST_SELLER}" not found.`);
    process.exit(1);
  }
  console.log(`Found "${bs.title}" (${bs.id}) — ${bs.productsCount?.count ?? "?"} products.\n`);

  const stats = { total: 0, willSet: 0, skipHasValue: 0, skipNoOther: 0, errors: 0 };
  const plan = [];

  for await (const p of iterateBestSellerProducts(bs.id)) {
    stats.total++;

    if (p.breadcrumb?.value) {
      stats.skipHasValue++;
      continue;
    }

    // Everything except "Best Seller".
    const others = p.collections.nodes
      .filter((c) => norm(c.title) !== norm(BEST_SELLER))
      .sort((a, b) => gidNum(a.id) - gidNum(b.id));

    if (others.length === 0) {
      stats.skipNoOther++;
      continue;
    }

    // Specific collections = everything except Best Seller AND Uni Cues.
    const specific = others.filter((c) => norm(c.title) !== norm(UNI_CUES));

    // Prefer a specific collection; fall back to Uni Cues only when it's the
    // sole non-Best-Seller collection. Lowest id breaks ties among specifics.
    const pick = specific.length > 0 ? specific[0] : others[0];
    stats.willSet++;
    plan.push({ product: p.title, productId: p.id, pick: pick.title, pickId: pick.id, otherCount: others.length });

    if (APPLY) {
      try {
        await setBreadcrumb(p.id, pick.id);
        console.log(`  ✓ ${p.title}  →  ${pick.title}`);
      } catch (err) {
        stats.errors++;
        console.log(`  ✗ ${p.title}  →  ${pick.title}  (ERROR: ${err.message})`);
      }
      await sleep(250); // gentle pacing
    } else {
      const note = specific.length === 0 ? "  (Uni Cues fallback)" : (specific.length > 1 ? `  (of ${specific.length} specific)` : "");
      console.log(`  • ${p.title}  →  ${pick.title}${note}`);
    }
  }

  console.log("");
  console.log("── Summary ──");
  console.log(`  Products in "Best Seller":      ${stats.total}`);
  console.log(`  Would set breadcrumb:           ${stats.willSet}`);
  console.log(`  Skipped (already has value):    ${stats.skipHasValue}`);
  console.log(`  Skipped (no other collection):  ${stats.skipNoOther}`);
  if (APPLY) console.log(`  Write errors:                   ${stats.errors}`);
  if (!APPLY) console.log(`\nDry run — nothing was written. Re-run with --apply to perform writes.`);
}

main().catch((err) => {
  console.error("\nFatal:", err.message);
  process.exit(1);
});
