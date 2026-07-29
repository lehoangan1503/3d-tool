/**
 * Assign the Shopify product taxonomy CATEGORY on a target store, mirroring the
 * source store. Category drives Shopify's standard `shopify.*` metafields (cue
 * style, joint connection, material, ...) — those definitions appear on the target
 * automatically once products carry a category, which is why cloning them directly
 * is neither possible nor needed.
 *
 * Source store is only ever READ from — no mutation is issued against it.
 *
 * Matching: source products are matched to target products by HANDLE. A target
 * product whose handle isn't on the source falls back to --default-category
 * (when provided). Products that already have a category are left untouched.
 *
 * Usage:
 *   node scripts/sync-product-category.mjs <targetStoreId> [sourceStoreId] [options]
 *
 * Options:
 *   --apply                     actually write (default is a DRY RUN)
 *   --default-category=<gid|id> taxonomy category for unmatched products,
 *                               e.g. "sg-3-2-4-2" (Billiard Cues) or a full GID
 *   --limit=N                   stop after N products needing a change
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

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const PRODUCTS = `
query($cursor: String) {
  products(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id handle title category { id name } }
  }
}`;

async function readAll(gql) {
  const out = [];
  let cursor = null;
  for (;;) {
    const d = await gql(PRODUCTS, { cursor });
    out.push(...d.products.nodes);
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  return out;
}

const targetId = process.argv[2];
const sourceId = process.argv.find((a, i) => i >= 3 && !a.startsWith("--")) ?? "main";
const APPLY = process.argv.includes("--apply");
const LIMIT = arg("limit") ? Number(arg("limit")) : undefined;
let DEFAULT_CATEGORY = arg("default-category", undefined);
if (DEFAULT_CATEGORY && !DEFAULT_CATEGORY.startsWith("gid://")) {
  DEFAULT_CATEGORY = `gid://shopify/TaxonomyCategory/${DEFAULT_CATEGORY}`;
}

if (!targetId) {
  console.error("Usage: node scripts/sync-product-category.mjs <targetStoreId> [sourceStoreId] [--apply] [--default-category=sg-3-2-4-2] [--limit=N]");
  process.exit(1);
}

const stores = loadStores();
const target = stores.find((s) => s.id === targetId);
const source = stores.find((s) => s.id === sourceId);
if (!target) throw new Error(`target store "${targetId}" not found`);
if (!source) throw new Error(`source store "${sourceId}" not found`);

console.log(`source (READ ONLY): ${source.name} (${source.storeDomain})`);
console.log(`target:             ${target.name} (${target.storeDomain})`);
if (DEFAULT_CATEGORY) console.log(`default category:   ${DEFAULT_CATEGORY}`);
console.log(APPLY ? "\nMODE: APPLY\n" : "\nMODE: DRY RUN (pass --apply to write)\n");

const srcGql = makeGql(source, await getToken(source));
const tgtGql = makeGql(target, await getToken(target));

const [srcProducts, tgtProducts] = await Promise.all([readAll(srcGql), readAll(tgtGql)]);
// "Uncategorized" (id .../na) is not a real category and can't be assigned.
const srcByHandle = new Map(
  srcProducts
    .filter((p) => p.category?.id && !p.category.id.endsWith("/na"))
    .map((p) => [p.handle, p.category])
);
console.log(`source: ${srcProducts.length} products (${srcByHandle.size} with a real category)`);
console.log(`target: ${tgtProducts.length} products\n`);

const todo = [];
for (const p of tgtProducts) {
  if (p.category?.id && !p.category.id.endsWith("/na")) continue; // already categorised
  const match = srcByHandle.get(p.handle);
  const categoryId = match?.id ?? DEFAULT_CATEGORY;
  if (!categoryId) continue;
  todo.push({ product: p, categoryId, categoryName: match?.name ?? "(default)", matched: Boolean(match) });
}

const capped = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log(`${capped.length} product(s) to update (${todo.filter((t) => t.matched).length} matched by handle, ${todo.filter((t) => !t.matched).length} via default)`);
if (LIMIT && todo.length > LIMIT) console.log(`(limited to ${LIMIT} of ${todo.length})`);
console.log("");

let updated = 0, failed = 0;
for (const t of capped) {
  const label = t.product.title.length > 54 ? t.product.title.slice(0, 51) + "..." : t.product.title;
  if (!APPLY) { console.log(`   + ${label}  →  ${t.categoryName}${t.matched ? "" : " [default]"}`); updated++; continue; }
  try {
    const r = await tgtGql(
      `mutation($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { id category { name } }
          userErrors { field message }
        }
      }`,
      { product: { id: t.product.id, category: t.categoryId } }
    );
    const errs = r.productUpdate.userErrors ?? [];
    if (errs.length) { console.log(`   ! ${label}: ${errs.map((e) => e.message).join("; ")}`); failed++; }
    else { console.log(`   + ${label}  →  ${r.productUpdate.product.category?.name ?? t.categoryName}`); updated++; }
  } catch (e) {
    console.log(`   ! ${label}: ${e.message.slice(0, 140)}`);
    failed++;
  }
}

console.log(`\n${APPLY ? "updated" : "would update"}=${updated}  failed=${failed}`);
console.log("\nNote: assigning a category makes Shopify's standard shopify.* metafield");
console.log("definitions available on the target automatically.");
