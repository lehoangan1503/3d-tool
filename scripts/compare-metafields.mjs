// One-off: compare cue_spec_variants metafield/metaobject setup between Prime-cues and Wow cue.
// Run: node scripts/compare-metafields.mjs
import { readFileSync } from "node:fs";

// Load SHOPIFY_STORES from .env without extra deps.
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const line = env.split("\n").find((l) => l.startsWith("SHOPIFY_STORES="));
if (!line) throw new Error("SHOPIFY_STORES not found in .env");
const stores = JSON.parse(line.slice("SHOPIFY_STORES=".length));

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
  if (!res.ok) throw new Error(`token ${store.name} ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function gql(store, token, query) {
  const res = await fetch(`https://${store.storeDomain}/admin/api/${store.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const VARIANT_DEFS = `{
  metafieldDefinitions(first: 50, ownerType: PRODUCTVARIANT) {
    nodes { namespace key name type { name } validations { name value } }
  }
}`;

const METAOBJECT_DEFS = `{
  metaobjectDefinitions(first: 50) {
    nodes { type name fieldDefinitions { key } }
  }
}`;

async function safeGql(store, token, q) {
  try { return await gql(store, token, q); }
  catch (e) { return { __error: e.message }; }
}

async function inspect(store) {
  const token = await getToken(store);
  const v = await safeGql(store, token, VARIANT_DEFS);
  const m = await safeGql(store, token, METAOBJECT_DEFS);
  const variantDefs = v.__error ? null : v.metafieldDefinitions.nodes;
  const cueSpec = variantDefs?.find((d) => d.namespace === "custom" && d.key === "cue_spec_variants");
  return {
    name: store.name,
    domain: store.storeDomain,
    apiVersion: store.apiVersion,
    variantDefError: v.__error || null,
    variantDefCount: variantDefs ? variantDefs.length : null,
    cueSpecVariantDef: cueSpec || null,
    metaobjectError: m.__error || null,
    metaobjectDefs: m.__error ? null : m.metaobjectDefinitions.nodes,
  };
}

for (const store of stores) {
  try {
    const r = await inspect(store);
    console.log("\n==================================================");
    console.log(`STORE: ${r.name}  (${r.domain}, api ${r.apiVersion})`);
    console.log("==================================================");
    if (r.variantDefError) {
      console.log(`Variant metafield definitions: (could not read — ${r.variantDefError})`);
    } else {
      console.log(`Variant metafield definitions total: ${r.variantDefCount}`);
      if (r.cueSpecVariantDef) {
        const d = r.cueSpecVariantDef;
        console.log(`\n✅ custom.cue_spec_variants EXISTS on variants`);
        console.log(`   name: ${d.name}`);
        console.log(`   type: ${d.type.name}`);
        console.log(`   validations: ${JSON.stringify(d.validations)}`);
      } else {
        console.log(`\n❌ custom.cue_spec_variants MISSING on variants`);
      }
    }
    if (r.metaobjectError) {
      console.log(`\nMetaobject definitions: (could not read — ${r.metaobjectError})`);
    } else {
      console.log(`\nMetaobject definitions present:`);
      for (const n of r.metaobjectDefs) {
        console.log(`   - ${n.type}  (fields: ${n.fieldDefinitions.map((f) => f.key).join(", ")})`);
      }
    }
  } catch (e) {
    console.log(`\n!! ${store.name} (${store.storeDomain}) error: ${e.message}`);
  }
}
