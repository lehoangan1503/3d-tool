/**
 * Make a target store's variants sellable, matching the source store's inventory
 * conventions (Prime Cues: tracked=true, policy=DENY, qty=10000, weight 0.6 kg).
 *
 * Source store is only ever READ from — no mutation is issued against it.
 *
 * CSV product import leaves variants with tracked=false and qty=0, which renders
 * as "sold out" on the storefront. This script, per variant on the target:
 *   1. sets inventoryItem.tracked = true (+ requiresShipping, weight if missing)
 *   2. sets inventoryPolicy = DENY (or CONTINUE via --policy)
 *   3. sets available quantity at the target's primary location to --qty
 *
 * Defaults are read from the SOURCE store's own variants so the target matches
 * it rather than hardcoded guesses; --qty / --weight / --policy override.
 *
 * Usage:
 *   node scripts/sync-inventory-from-source.mjs <targetStoreId> [sourceStoreId] [options]
 *
 * Options:
 *   --apply            actually write (default is a DRY RUN)
 *   --qty=N            available quantity per variant (default: source median)
 *   --weight=N         kg per variant, 0 to leave alone (default: source median)
 *   --policy=DENY|CONTINUE
 *   --query=...        only products matching this Shopify search query
 *   --limit=N          stop after N products (for a trial run)
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
  return async (query, variables, attempt = 0) => {
    const res = await fetch(`https://${store.storeDomain}/admin/api/${store.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) {
      const msg = Array.isArray(json.errors) ? json.errors.map((e) => e.message).join("; ") : String(json.errors);
      // Throttled: back off and retry a few times.
      if (/throttl/i.test(msg) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        return makeGql(store, token)(query, variables, attempt + 1);
      }
      throw new Error(`${store.storeDomain}: ${msg}`);
    }
    return json.data;
  };
}

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const median = (nums) => {
  if (!nums.length) return undefined;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const PRODUCTS_QUERY = `
query($cursor: String, $query: String) {
  products(first: 25, after: $cursor, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title
      variants(first: 100) {
        nodes {
          id sku inventoryQuantity inventoryPolicy
          inventoryItem {
            id tracked requiresShipping
            measurement { weight { value unit } }
          }
        }
      }
    }
  }
}`;

async function* iterateProducts(gql, query, limit) {
  let cursor = null, seen = 0;
  for (;;) {
    const d = await gql(PRODUCTS_QUERY, { cursor, query: query ?? null });
    for (const p of d.products.nodes) {
      yield p;
      if (limit && ++seen >= limit) return;
    }
    if (!d.products.pageInfo.hasNextPage) return;
    cursor = d.products.pageInfo.endCursor;
  }
}

const targetId = process.argv[2];
const sourceId = process.argv.find((a, i) => i >= 3 && !a.startsWith("--")) ?? "main";
const APPLY = process.argv.includes("--apply");
if (!targetId) {
  console.error("Usage: node scripts/sync-inventory-from-source.mjs <targetStoreId> [sourceStoreId] [--apply] [--qty=N] [--weight=N] [--policy=DENY|CONTINUE] [--query=...] [--limit=N]");
  process.exit(1);
}

const stores = loadStores();
const target = stores.find((s) => s.id === targetId);
const source = stores.find((s) => s.id === sourceId);
if (!target) throw new Error(`target store "${targetId}" not found`);
if (!source) throw new Error(`source store "${sourceId}" not found`);

console.log(`source (READ ONLY): ${source.name} (${source.storeDomain})`);
console.log(`target:             ${target.name} (${target.storeDomain})`);

const tgtGql = makeGql(target, await getToken(target));

// ── Learn the source store's conventions (read-only sample) ──────────────────
let srcQty, srcWeight, srcPolicy;
try {
  const srcGql = makeGql(source, await getToken(source));
  // Sample several pages: the first page can be all zero-stock variants, which
  // would leave the median undefined.
  const vs = [];
  let cursor = null;
  for (let page = 0; page < 4; page++) {
    const d = await srcGql(PRODUCTS_QUERY, { cursor, query: null });
    vs.push(...d.products.nodes.flatMap((p) => p.variants.nodes));
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  srcQty = median(vs.map((v) => v.inventoryQuantity).filter((n) => n > 0));
  // Normalise to kg — Shopify returns GRAMS/KILOGRAMS/POUNDS/OUNCES depending on
  // the item, so the raw .value is not comparable across variants.
  const TO_KG = { KILOGRAMS: 1, GRAMS: 0.001, POUNDS: 0.45359237, OUNCES: 0.0283495231 };
  srcWeight = median(
    vs
      .map((v) => v.inventoryItem?.measurement?.weight)
      .filter((w) => w?.value > 0 && TO_KG[w.unit])
      .map((w) => w.value * TO_KG[w.unit])
  );
  const policies = vs.map((v) => v.inventoryPolicy).filter(Boolean);
  srcPolicy = policies.sort((a, b) => policies.filter((p) => p === b).length - policies.filter((p) => p === a).length)[0];
  console.log(`\nsource conventions (from ${vs.length} sampled variants): qty=${srcQty} weight=${srcWeight}kg policy=${srcPolicy}`);
} catch (e) {
  console.warn(`\n! could not sample source (${e.message.slice(0, 80)}) — falling back to defaults`);
}

const QTY = Number(arg("qty", srcQty ?? 10000));
const WEIGHT = Number(arg("weight", srcWeight ?? 0.6));
const POLICY = String(arg("policy", srcPolicy ?? "DENY")).toUpperCase();
const QUERY = arg("query", undefined);
const LIMIT = arg("limit") ? Number(arg("limit")) : undefined;

if (!["DENY", "CONTINUE"].includes(POLICY)) throw new Error(`--policy must be DENY or CONTINUE, got "${POLICY}"`);

// Target's primary (inventory-shipping) location.
const locs = await tgtGql(`{ locations(first: 20) { nodes { id name isActive shipsInventory } } }`);
const location = locs.locations.nodes.find((l) => l.isActive && l.shipsInventory) ?? locs.locations.nodes[0];
if (!location) throw new Error("target store has no location");

console.log(`\napplying:  tracked=true  policy=${POLICY}  qty=${QTY}  weight=${WEIGHT || "(leave)"}kg`);
console.log(`location:  ${location.name} (${location.id})`);
if (QUERY) console.log(`query:     ${QUERY}`);
if (LIMIT) console.log(`limit:     ${LIMIT} products`);
console.log(APPLY ? "\nMODE: APPLY\n" : "\nMODE: DRY RUN (pass --apply to write)\n");

/** True when the item already carries a positive weight (in any unit). */
const hasWeight = (it) => (it?.measurement?.weight?.value ?? 0) > 0;

let products = 0, variantsSeen = 0, itemsUpdated = 0, qtySet = 0, policySet = 0, failures = 0;

for await (const p of iterateProducts(tgtGql, QUERY, LIMIT)) {
  products++;
  const variants = p.variants.nodes;
  variantsSeen += variants.length;

  // 1. inventoryItem: tracked / requiresShipping / weight
  const itemsToFix = variants.filter((v) => {
    const it = v.inventoryItem;
    if (!it) return false;
    const needsTracked = !it.tracked;
    const needsWeight = WEIGHT > 0 && !hasWeight(it);
    return needsTracked || needsWeight;
  });

  // 2. variants whose policy differs
  const policyToFix = variants.filter((v) => v.inventoryPolicy !== POLICY);

  // 3. variants whose available qty differs
  const qtyToFix = variants.filter((v) => v.inventoryQuantity !== QTY);

  if (!itemsToFix.length && !policyToFix.length && !qtyToFix.length) continue;

  const label = p.title.length > 58 ? p.title.slice(0, 55) + "..." : p.title;
  console.log(`${String(products).padStart(3)}. ${label}  (item:${itemsToFix.length} policy:${policyToFix.length} qty:${qtyToFix.length})`);

  if (!APPLY) {
    itemsUpdated += itemsToFix.length; policySet += policyToFix.length; qtySet += qtyToFix.length;
    continue;
  }

  try {
    for (const v of itemsToFix) {
      const it = v.inventoryItem;
      const input = { tracked: true };
      if (WEIGHT > 0 && !hasWeight(it)) {
        input.measurement = { weight: { value: WEIGHT, unit: "KILOGRAMS" } };
      }
      const r = await tgtGql(
        `mutation($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) {
            inventoryItem { id tracked }
            userErrors { field message }
          }
        }`,
        { id: it.id, input }
      );
      const errs = r.inventoryItemUpdate.userErrors ?? [];
      if (errs.length) { console.log(`     ! item ${v.sku}: ${errs.map((e) => e.message).join("; ")}`); failures++; }
      else itemsUpdated++;
    }

    if (policyToFix.length) {
      const r = await tgtGql(
        `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }`,
        { productId: p.id, variants: policyToFix.map((v) => ({ id: v.id, inventoryPolicy: POLICY })) }
      );
      const errs = r.productVariantsBulkUpdate.userErrors ?? [];
      if (errs.length) { console.log(`     ! policy: ${errs.map((e) => e.message).join("; ")}`); failures++; }
      else policySet += policyToFix.length;
    }

    // setQuantities needs tracked=true to already be in effect, hence step 1 first.
    if (qtyToFix.length) {
      // changeFromQuantity is mandatory on this API version — it's an optimistic
      // lock. Re-read `available` AT THIS LOCATION rather than reusing the
      // variant's inventoryQuantity: that field is a total across locations and
      // is stale anyway now that step 1 flipped tracked to true.
      const levels = await tgtGql(
        `query($ids: [ID!]!, $locationId: ID!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id
              inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { quantity } }
            }
          }
        }`,
        { ids: qtyToFix.map((v) => v.inventoryItem.id), locationId: location.id }
      );
      const currentByItem = new Map(
        (levels.nodes ?? [])
          .filter(Boolean)
          .map((n) => [n.id, n.inventoryLevel?.quantities?.[0]?.quantity ?? 0])
      );

      // Anything already at QTY here needs no write.
      const stillToFix = qtyToFix.filter((v) => currentByItem.get(v.inventoryItem.id) !== QTY);
      if (!stillToFix.length) continue;

      // inventorySetQuantities requires @idempotent with a unique key per logical
      // write, so a retry can't double-apply. Key off the product + location +
      // target qty: replaying the same intent is a no-op, a different intent isn't.
      const idempotencyKey = `sync-inv-${p.id.split("/").pop()}-${location.id.split("/").pop()}-${QTY}`;
      const r = await tgtGql(
        `mutation($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) @idempotent(key: "${idempotencyKey}") {
            inventoryAdjustmentGroup { createdAt }
            userErrors { field message }
          }
        }`,
        {
          input: {
            name: "available",
            reason: "correction",
            quantities: stillToFix.map((v) => ({
              inventoryItemId: v.inventoryItem.id,
              locationId: location.id,
              quantity: QTY,
              changeFromQuantity: currentByItem.get(v.inventoryItem.id) ?? 0,
            })),
          },
        }
      );
      const errs = r.inventorySetQuantities.userErrors ?? [];
      if (errs.length) { console.log(`     ! qty: ${errs.map((e) => e.message).join("; ")}`); failures++; }
      else qtySet += stillToFix.length;
    }
  } catch (e) {
    console.log(`     ! ${e.message.slice(0, 160)}`);
    failures++;
  }
}

console.log(`\nproducts scanned=${products}  variants=${variantsSeen}`);
console.log(`${APPLY ? "updated" : "would update"}:  inventoryItems=${itemsUpdated}  policy=${policySet}  quantities=${qtySet}  failures=${failures}`);
