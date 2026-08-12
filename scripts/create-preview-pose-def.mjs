/**
 * Create the custom.preview_pose PRODUCT metafield definition on every store
 * configured in SHOPIFY_STORES (or one store via --store="Name").
 *
 * The storefront customizer layers a 3D canvas over the main product image at
 * the exact camera pose that rendered it. That pose is deployed as a JSON
 * product metafield; without a *definition* the value is still readable by
 * Liquid, but it stays invisible/unmanageable in the Shopify admin — so this
 * registers it properly.
 *
 * Idempotent: an already-existing definition is reported and skipped (Shopify
 * returns TAKEN), so re-running is safe.
 *
 *   node scripts/create-preview-pose-def.mjs
 *   node scripts/create-preview-pose-def.mjs --store="Prime cues"
 *   node scripts/create-preview-pose-def.mjs --dry-run
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const storeFilter = (args.find((a) => a.startsWith("--store=")) || "").slice("--store=".length);
const dryRun = args.includes("--dry-run");

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const storesLine = env.split("\n").find((l) => l.startsWith("SHOPIFY_STORES="));
if (!storesLine) throw new Error("SHOPIFY_STORES not found in .env");
const allStores = JSON.parse(storesLine.slice("SHOPIFY_STORES=".length));

const stores = storeFilter
  ? allStores.filter((s) => s.name === storeFilter || s.id === storeFilter)
  : allStores;
if (!stores.length) throw new Error(`No store matched "${storeFilter}"`);

const DEFINITION = {
  name: "Preview pose",
  namespace: "custom",
  key: "preview_pose",
  type: "json",
  ownerType: "PRODUCT",
  description:
    "Camera/model pose of the main gallery mockup (spinY, phi, zoom, offsetX, offsetY, distance). " +
    "Lets the storefront load a 3D preview at the identical angle as the 2D image. Written automatically on deploy.",
};

const CREATE = `
mutation Create($def: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $def) {
    createdDefinition { id name namespace key type { name } }
    userErrors { field message code }
  }
}`;

const LOOKUP = `
query Existing($namespace: String!, $key: String!) {
  metafieldDefinitions(namespace: $namespace, key: $key, ownerType: PRODUCT, first: 1) {
    nodes { id name namespace key type { name } description }
  }
}`;

async function accessToken(store) {
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
  const res = await fetch(
    `https://${store.storeDomain}/admin/api/${store.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (!res.ok) throw new Error(`graphql ${res.status}: ${await res.text()}`);
  return res.json();
}

let failures = 0;

for (const store of stores) {
  const label = `${store.name} (${store.storeDomain})`;
  try {
    const token = await accessToken(store);

    const existing = await gql(store, token, LOOKUP, {
      namespace: DEFINITION.namespace,
      key: DEFINITION.key,
    });
    const found = existing?.data?.metafieldDefinitions?.nodes?.[0];
    if (found) {
      console.log(`✅ ${label} — already exists (${found.type.name}) ${found.id}`);
      continue;
    }

    if (dryRun) {
      console.log(`🔎 ${label} — would create custom.preview_pose (json, PRODUCT)`);
      continue;
    }

    const out = await gql(store, token, CREATE, { def: DEFINITION });
    const result = out?.data?.metafieldDefinitionCreate;

    if (out.errors) {
      failures++;
      console.log(`❌ ${label} — GraphQL error: ${JSON.stringify(out.errors)}`);
    } else if (result?.userErrors?.length) {
      // TAKEN means a definition already exists (race with the lookup above).
      const taken = result.userErrors.every((e) => e.code === "TAKEN");
      if (taken) {
        console.log(`✅ ${label} — already exists`);
      } else {
        failures++;
        console.log(`❌ ${label} — ${result.userErrors.map((e) => `${e.code}: ${e.message}`).join("; ")}`);
      }
    } else {
      const def = result.createdDefinition;
      console.log(`🎉 ${label} — created ${def.namespace}.${def.key} (${def.type.name}) ${def.id}`);
    }
  } catch (err) {
    failures++;
    console.log(`❌ ${label} — ${err.message}`);
  }
}

console.log(`\nDone. ${stores.length} store(s) processed, ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
