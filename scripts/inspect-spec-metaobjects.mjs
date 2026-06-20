/**
 * Inspect the cue_spec metaobjects + the custom.cue_spec_variants metafield
 * definition on a given store. Used to learn the shape we must replicate when
 * deploying to a new store (e.g. "Wow cue").
 *
 * Usage:
 *   node scripts/inspect-spec-metaobjects.mjs [storeId]
 *
 * Defaults to the default store. Reads SHOPIFY_STORES from .env.
 */
import fs from "node:fs";

// Minimal .env loader (no dotenv dependency). Only fills vars not already set.
try {
  const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch (e) {
  console.warn("could not read .env:", e.message);
}

const GIDS = [
  "gid://shopify/Metaobject/170152984713", // Standard wrap
  "gid://shopify/Metaobject/181394309257", // Standard wrapless
  "gid://shopify/Metaobject/170153181321", // Premium wrap
  "gid://shopify/Metaobject/181394342025", // Premium wrapless
  "gid://shopify/Metaobject/181394374793", // Pro wrap
  "gid://shopify/Metaobject/181394833545", // Pro wrapless
];

function loadStores() {
  const raw = process.env.SHOPIFY_STORES?.trim();
  if (!raw) throw new Error("SHOPIFY_STORES not set");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(raw.replace(/,\s*([\]}])/g, "$1"));
  }
  return parsed.map((s, i) => ({
    id: s.id ?? `store-${i}`,
    name: s.name ?? s.id,
    storeDomain: s.storeDomain.endsWith(".myshopify.com") ? s.storeDomain : `${s.storeDomain}.myshopify.com`,
    apiVersion: s.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? "2025-10",
    clientId: s.clientId,
    clientSecret: s.clientSecret,
    isDefault: s.isDefault ?? false,
  }));
}

async function getToken(store) {
  const res = await fetch(`https://${store.storeDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: store.clientId,
      client_secret: store.clientSecret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function gql(store, token, query, variables) {
  const res = await fetch(`https://${store.storeDomain}/admin/api/${store.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const stores = loadStores();
const storeId = process.argv[2];
const store = storeId ? stores.find((s) => s.id === storeId) : stores.find((s) => s.isDefault) ?? stores[0];
if (!store) throw new Error(`store not found: ${storeId}`);
console.log(`\n=== Inspecting store: ${store.name} (${store.id}) — ${store.storeDomain} ===\n`);

const token = await getToken(store);

// 1. Dump each metaobject (type + fields).
for (const gid of GIDS) {
  try {
    const data = await gql(
      store,
      token,
      `query($id: ID!) {
        metaobject(id: $id) {
          id handle displayName
          type
          fields { key type value }
        }
      }`,
      { id: gid }
    );
    const mo = data.metaobject;
    if (!mo) {
      console.log(`${gid} → NOT FOUND in this store`);
      continue;
    }
    console.log(`${gid}`);
    console.log(`  type=${mo.type} handle=${mo.handle} display="${mo.displayName}"`);
    for (const f of mo.fields) console.log(`    ${f.key} (${f.type}) = ${JSON.stringify(f.value)}`);
    console.log("");
  } catch (e) {
    console.log(`${gid} → ERROR ${e.message}`);
  }
}

// 2. Dump the metaobject DEFINITION (schema) for the type used above.
try {
  const data = await gql(
    store,
    token,
    `{
      metaobjectDefinitions(first: 25) {
        nodes {
          id name type
          fieldDefinitions { key name type { name } required }
        }
      }
    }`
  );
  console.log("=== Metaobject definitions on this store ===");
  for (const d of data.metaobjectDefinitions.nodes) {
    console.log(`  type=${d.type} name="${d.name}" id=${d.id}`);
    for (const fd of d.fieldDefinitions) {
      console.log(`     field ${fd.key} (${fd.type.name})${fd.required ? " required" : ""}`);
    }
  }
  console.log("");
} catch (e) {
  console.log(`metaobjectDefinitions → ERROR ${e.message}`);
}

// 3. Dump the custom.cue_spec_variants metafield definition (VARIANT owner).
try {
  const data = await gql(
    store,
    token,
    `{
      metafieldDefinitions(first: 10, ownerType: PRODUCTVARIANT, namespace: "custom", key: "cue_spec_variants") {
        nodes { id name namespace key type { name } validations { name value } }
      }
    }`
  );
  console.log("=== custom.cue_spec_variants metafield definition (PRODUCTVARIANT) ===");
  if (!data.metafieldDefinitions.nodes.length) {
    console.log("  (none — definition missing on this store)");
  }
  for (const d of data.metafieldDefinitions.nodes) {
    console.log(`  ${d.namespace}.${d.key} name="${d.name}" type=${d.type.name} id=${d.id}`);
    for (const v of d.validations) console.log(`     validation ${v.name} = ${v.value}`);
  }
  console.log("");
} catch (e) {
  console.log(`metafieldDefinitions → ERROR ${e.message}`);
}
