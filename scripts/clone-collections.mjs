/**
 * Clone COLLECTIONS from a source store to a target store.
 *
 * Source store is only ever READ from — no mutation is issued against it.
 *
 * Smart (rule-based) collections port cleanly: the rules are plain tag/title/vendor
 * predicates, so recreating the rule set on the target auto-populates it from the
 * target's own products.
 *
 * Manual collections carry no rules — only an explicit product list — so their
 * membership can't be reconstructed from product data. They are created EMPTY by
 * default (so the theme's links/menus resolve) and reported, unless
 * --match-products is passed, which fills them by matching source product HANDLES
 * against the target.
 *
 * Skips: collection descriptions and images are copied when present; file-reference
 * metafields (banners) are NOT — those reference source-shop file GIDs.
 *
 * Idempotent: matches by handle and skips collections already on the target.
 *
 * Usage:
 *   node scripts/clone-collections.mjs <targetStoreId> [sourceStoreId] [options]
 *
 * Options:
 *   --apply             actually write (default is a DRY RUN)
 *   --match-products    populate manual collections by product handle
 *   --smart-only        skip manual collections entirely
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

const SRC_COLLECTIONS = `
query($cursor: String) {
  collections(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle descriptionHtml sortOrder templateSuffix
      image { url altText }
      ruleSet { appliedDisjunctively rules { column relation condition } }
    }
  }
}`;

const targetId = process.argv[2];
const sourceId = process.argv.find((a, i) => i >= 3 && !a.startsWith("--")) ?? "main";
const APPLY = process.argv.includes("--apply");
const MATCH_PRODUCTS = process.argv.includes("--match-products");
const SMART_ONLY = process.argv.includes("--smart-only");
if (!targetId) {
  console.error("Usage: node scripts/clone-collections.mjs <targetStoreId> [sourceStoreId] [--apply] [--match-products] [--smart-only]");
  process.exit(1);
}

const stores = loadStores();
const target = stores.find((s) => s.id === targetId);
const source = stores.find((s) => s.id === sourceId);
if (!target) throw new Error(`target store "${targetId}" not found`);
if (!source) throw new Error(`source store "${sourceId}" not found`);

console.log(`source (READ ONLY): ${source.name} (${source.storeDomain})`);
console.log(`target:             ${target.name} (${target.storeDomain})`);
console.log(APPLY ? "\nMODE: APPLY" : "\nMODE: DRY RUN (pass --apply to write)");
if (SMART_ONLY) console.log("smart-only: manual collections skipped");
if (MATCH_PRODUCTS) console.log("match-products: manual collections populated by product handle");
console.log("");

const srcGql = makeGql(source, await getToken(source));
const tgtGql = makeGql(target, await getToken(target));

// collectionCreate does NOT publish to any sales channel, so a new collection
// 404s on the storefront until it's published. Resolve the Online Store
// publication up front and publish each collection as it's created.
let onlineStorePublicationId = null;
try {
  const pubs = await tgtGql(`{ publications(first: 20) { nodes { id name } } }`);
  onlineStorePublicationId = pubs.publications.nodes.find((p) => /online store/i.test(p.name))?.id ?? null;
} catch {
  /* fall through — handled below */
}
if (!onlineStorePublicationId) {
  console.warn("! could not resolve the Online Store publication — collections will be created UNPUBLISHED");
  console.warn("  (run scripts/publish-collections.mjs afterwards to publish them)\n");
}

// ── Read every source collection ─────────────────────────────────────────────
const srcCollections = [];
{
  let cursor = null;
  for (;;) {
    const d = await srcGql(SRC_COLLECTIONS, { cursor });
    srcCollections.push(...d.collections.nodes);
    if (!d.collections.pageInfo.hasNextPage) break;
    cursor = d.collections.pageInfo.endCursor;
  }
}

// Source can contain duplicate titles with distinct handles; de-dupe by handle.
const byHandle = new Map();
for (const c of srcCollections) if (!byHandle.has(c.handle)) byHandle.set(c.handle, c);
const unique = [...byHandle.values()];

// ── Existing target handles ──────────────────────────────────────────────────
const existingHandles = new Set();
{
  let cursor = null;
  for (;;) {
    const d = await tgtGql(`query($cursor: String) { collections(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { handle } } }`, { cursor });
    for (const n of d.collections.nodes) existingHandles.add(n.handle);
    if (!d.collections.pageInfo.hasNextPage) break;
    cursor = d.collections.pageInfo.endCursor;
  }
}

console.log(`source collections: ${srcCollections.length} (${unique.length} unique handles)`);
console.log(`target already has: ${existingHandles.size}\n`);

let createdSmart = 0, createdManual = 0, existed = 0, skipped = 0, failed = 0, populated = 0;
const manualEmpty = [];

for (const c of unique) {
  const isSmart = Boolean(c.ruleSet?.rules?.length);
  if (existingHandles.has(c.handle)) { existed++; continue; }
  if (!isSmart && SMART_ONLY) { skipped++; continue; }

  const kind = isSmart ? "smart" : "manual";
  const rulesDesc = isSmart
    ? c.ruleSet.rules.map((r) => `${r.column} ${r.relation} ${r.condition}`).join(c.ruleSet.appliedDisjunctively ? " OR " : " AND ")
    : "(no rules)";

  if (!APPLY) {
    console.log(`   + would create [${kind}] ${c.title}  ${isSmart ? "→ " + rulesDesc : ""}`);
    isSmart ? createdSmart++ : createdManual++;
    if (!isSmart) manualEmpty.push(c.title);
    continue;
  }

  const input = {
    title: c.title,
    handle: c.handle,
    ...(c.descriptionHtml ? { descriptionHtml: c.descriptionHtml } : {}),
    ...(c.sortOrder ? { sortOrder: c.sortOrder } : {}),
    ...(c.templateSuffix ? { templateSuffix: c.templateSuffix } : {}),
    ...(c.image?.url ? { image: { src: c.image.url, altText: c.image.altText ?? "" } } : {}),
    ...(isSmart
      ? {
          ruleSet: {
            appliedDisjunctively: c.ruleSet.appliedDisjunctively,
            rules: c.ruleSet.rules.map((r) => ({ column: r.column, relation: r.relation, condition: r.condition })),
          },
        }
      : {}),
  };

  try {
    const r = await tgtGql(
      `mutation($input: CollectionInput!) {
        collectionCreate(input: $input) {
          collection { id handle }
          userErrors { field message }
        }
      }`,
      { input }
    );
    const errs = r.collectionCreate.userErrors ?? [];
    if (errs.length) {
      console.log(`   ! ${c.title}: ${errs.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
      failed++;
      continue;
    }
    const newId = r.collectionCreate.collection.id;
    console.log(`   + [${kind}] ${c.title}${isSmart ? "  → " + rulesDesc : ""}`);
    isSmart ? createdSmart++ : createdManual++;

    // Publish to Online Store, else the storefront 404s on /collections/<handle>.
    if (onlineStorePublicationId) {
      try {
        const pub = await tgtGql(
          `mutation($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) { userErrors { field message } }
          }`,
          { id: newId, input: [{ publicationId: onlineStorePublicationId }] }
        );
        const perrs = pub.publishablePublish.userErrors ?? [];
        if (perrs.length) console.log(`     ! publish: ${perrs.map((e) => e.message).join("; ")}`);
      } catch (e) {
        console.log(`     ! publish: ${e.message.slice(0, 120)}`);
      }
    }

    // Manual collections: optionally rebuild membership by product handle.
    if (!isSmart && MATCH_PRODUCTS) {
      const handles = [];
      let pc = null;
      for (;;) {
        const d = await srcGql(
          `query($id: ID!, $cursor: String) {
            collection(id: $id) { products(first: 250, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { handle } } }
          }`,
          { id: c.id, cursor: pc }
        );
        const pn = d.collection?.products;
        if (!pn) break;
        handles.push(...pn.nodes.map((n) => n.handle));
        if (!pn.pageInfo.hasNextPage) break;
        pc = pn.pageInfo.endCursor;
      }

      const ids = [];
      for (const h of handles) {
        const d = await tgtGql(`query($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { id } }`, { handle: h });
        if (d.productByIdentifier?.id) ids.push(d.productByIdentifier.id);
      }
      if (ids.length) {
        const add = await tgtGql(
          `mutation($id: ID!, $productIds: [ID!]!) {
            collectionAddProducts(id: $id, productIds: $productIds) {
              userErrors { field message }
            }
          }`,
          { id: newId, productIds: ids }
        );
        const aerrs = add.collectionAddProducts.userErrors ?? [];
        if (aerrs.length) console.log(`     ! add products: ${aerrs.map((e) => e.message).join("; ")}`);
        else { console.log(`     ↳ matched ${ids.length}/${handles.length} products by handle`); populated++; }
      } else {
        console.log(`     ↳ 0/${handles.length} source products exist on target — left empty`);
        manualEmpty.push(c.title);
      }
    } else if (!isSmart) {
      manualEmpty.push(c.title);
    }
  } catch (e) {
    console.log(`   ! ${c.title}: ${e.message.slice(0, 160)}`);
    failed++;
  }
}

console.log(`\n${APPLY ? "created" : "would create"}: smart=${createdSmart} manual=${createdManual}  existed=${existed}  skipped=${skipped}  failed=${failed}`);
if (MATCH_PRODUCTS) console.log(`manual collections populated: ${populated}`);
if (manualEmpty.length) {
  console.log(`\n${manualEmpty.length} manual collection(s) have no membership (manual collections carry no rules to replay):`);
  for (const t of manualEmpty) console.log(`  - ${t}`);
  console.log(MATCH_PRODUCTS
    ? "  These had no handle matches on the target."
    : "  Re-run with --match-products to fill them by product handle.");
}
console.log("\nNote: collection banner metafields are not copied — they reference source-shop file GIDs.");
