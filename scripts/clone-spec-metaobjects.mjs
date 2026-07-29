/**
 * Clone the cue_spec metaobject setup from a source store into a target store.
 *
 * Metaobjects are NOT portable across shops — the GIDs in SHOPIFY_STORES point at
 * records inside one specific shop. This script replicates, on the target store:
 *   1. the `cue_spec` metaobject DEFINITION (15 fields, matching the source types)
 *   2. the 8 spec RECORDS (Standard/Premium/Pro/Lux x wrap/wrapless), field values
 *      copied verbatim from the source store's records
 *   3. the custom.cue_spec_variants VARIANT metafield definition, bound to the
 *      new metaobject definition
 * then prints the `specMetafields` JSON block to paste into SHOPIFY_STORES.
 *
 * Idempotent: existing definitions/records are reused (matched by type + handle),
 * so a re-run repairs a partial setup instead of erroring or duplicating.
 *
 * Usage:
 *   node scripts/clone-spec-metaobjects.mjs <targetStoreId> [sourceStoreId]
 *
 * sourceStoreId defaults to "main" (Prime-cues).
 */
import fs from "node:fs";

// ── .env loader (no dotenv dep) ───────────────────────────────────────────────
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

const SPEC_VERSIONS = ["Standard", "Premium", "Pro", "Lux"];
const WRAP_KEYS = ["wrap", "wrapless"];
const METAOBJECT_TYPE = "cue_spec";

function loadStores() {
  const raw = process.env.SHOPIFY_STORES?.trim();
  if (!raw) throw new Error("SHOPIFY_STORES not set in .env");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(raw.replace(/,\s*([\]}])/g, "$1"));
  }
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
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: store.clientId,
      client_secret: store.clientSecret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token ${res.status} for ${store.storeDomain}: ${await res.text()}`);
  return (await res.json()).access_token;
}

function makeGql(store, token) {
  return async (query, variables) => {
    const res = await fetch(`https://${store.storeDomain}/admin/api/${store.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) {
      // `errors` is an array for GraphQL errors but a bare string for
      // shop-level failures ("Unavailable Shop"), so normalise before printing.
      const msg = Array.isArray(json.errors)
        ? json.errors.map((e) => e.message).join("; ")
        : String(json.errors);
      throw new Error(`${store.storeDomain}: ${msg}`);
    }
    return json.data;
  };
}

// ── 1. Read the source records ────────────────────────────────────────────────
async function readSourceSpecs(store, gql) {
  const map = store.specMetafields ?? {};
  const wanted = [];
  for (const version of SPEC_VERSIONS) {
    for (const wrap of WRAP_KEYS) {
      const gid = map[version]?.[wrap];
      if (gid) wanted.push({ version, wrap, gid });
    }
  }
  if (!wanted.length) throw new Error(`source store "${store.id}" has no specMetafields to copy`);

  const data = await gql(
    `query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Metaobject { id handle type fields { key value type } }
      }
    }`,
    { ids: wanted.map((w) => w.gid) }
  );

  const specs = [];
  for (const w of wanted) {
    const node = data.nodes.find((n) => n?.id === w.gid);
    if (!node) {
      console.warn(`  ! source ${w.version}/${w.wrap} (${w.gid}) not found — skipping`);
      continue;
    }
    specs.push({
      version: w.version,
      wrap: w.wrap,
      handle: node.handle,
      // Drop empty values: writing "" to a number_decimal field is rejected.
      fields: node.fields.filter((f) => f.value !== null && f.value !== ""),
    });
  }
  return specs;
}

// ── 2. Ensure the metaobject definition on the target ─────────────────────────
async function ensureMetaobjectDefinition(gql, specs) {
  const existing = await gql(
    `query($type: String!) { metaobjectDefinitionByType(type: $type) { id name fieldDefinitions { key } } }`,
    { type: METAOBJECT_TYPE }
  );
  if (existing.metaobjectDefinitionByType?.id) {
    console.log(`  = metaobject definition ${METAOBJECT_TYPE} already exists`);
    return existing.metaobjectDefinitionByType.id;
  }

  // Union of every field across the source records, preserving first-seen order
  // and each field's source type.
  const fieldDefs = [];
  const seen = new Set();
  for (const spec of specs) {
    for (const f of spec.fields) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      fieldDefs.push({
        key: f.key,
        name: f.key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        type: f.type,
      });
    }
  }

  const res = await gql(
    `mutation($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition { id }
        userErrors { code field message }
      }
    }`,
    {
      definition: {
        type: METAOBJECT_TYPE,
        name: "Cue spec",
        displayNameKey: "name",
        fieldDefinitions: fieldDefs,
      },
    }
  );
  const out = res.metaobjectDefinitionCreate;
  if (out.userErrors?.length) {
    throw new Error(`metaobjectDefinitionCreate: ${out.userErrors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
  }
  console.log(`  + created metaobject definition ${METAOBJECT_TYPE} (${fieldDefs.length} fields)`);
  return out.metaobjectDefinition.id;
}

// ── 3. Ensure the 8 records ───────────────────────────────────────────────────
async function ensureRecords(gql, specs) {
  const result = {};
  for (const spec of specs) {
    const found = await gql(
      `query($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle: $handle) { id } }`,
      { handle: { type: METAOBJECT_TYPE, handle: spec.handle } }
    );
    let gid = found.metaobjectByHandle?.id;

    if (gid) {
      console.log(`  = ${spec.version}/${spec.wrap} exists (${spec.handle})`);
    } else {
      const res = await gql(
        `mutation($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject { id handle }
            userErrors { code field message }
          }
        }`,
        {
          // No `publishable` capability: these records are only referenced by
          // variant metafields, never published standalone, and the definition
          // doesn't enable that capability.
          metaobject: {
            type: METAOBJECT_TYPE,
            handle: spec.handle,
            fields: spec.fields.map((f) => ({ key: f.key, value: f.value })),
          },
        }
      );
      const out = res.metaobjectCreate;
      if (out.userErrors?.length) {
        throw new Error(`metaobjectCreate ${spec.handle}: ${out.userErrors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
      }
      gid = out.metaobject.id;
      console.log(`  + created ${spec.version}/${spec.wrap} (${spec.handle}) -> ${gid}`);
    }

    result[spec.version] ??= {};
    result[spec.version][spec.wrap] = gid;
  }
  return result;
}

// ── 4. Ensure the variant metafield definition ────────────────────────────────
async function ensureVariantMetafieldDefinition(gql, metaobjectDefinitionId) {
  const existing = await gql(
    `query { metafieldDefinitions(first: 1, ownerType: PRODUCTVARIANT, namespace: "custom", key: "cue_spec_variants") { nodes { id } } }`
  );
  if (existing.metafieldDefinitions.nodes.length) {
    console.log("  = variant metafield custom.cue_spec_variants already exists");
    return;
  }

  const res = await gql(
    `mutation($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { code field message }
      }
    }`,
    {
      definition: {
        name: "Cue spec variants",
        namespace: "custom",
        key: "cue_spec_variants",
        type: "metaobject_reference",
        ownerType: "PRODUCTVARIANT",
        validations: [{ name: "metaobject_definition_id", value: metaobjectDefinitionId }],
      },
    }
  );
  const out = res.metafieldDefinitionCreate;
  const errors = out.userErrors ?? [];
  if (errors.length) {
    const benign = errors.every((e) => e.code === "TAKEN" || /already|exists|taken/i.test(e.message));
    if (!benign) throw new Error(`metafieldDefinitionCreate: ${errors.map((e) => e.message).join("; ")}`);
    console.log("  = variant metafield custom.cue_spec_variants already exists");
    return;
  }
  console.log("  + created variant metafield definition custom.cue_spec_variants");
}

// ── main ──────────────────────────────────────────────────────────────────────
const targetId = process.argv[2];
const sourceId = process.argv[3] ?? "main";
if (!targetId) {
  console.error("Usage: node scripts/clone-spec-metaobjects.mjs <targetStoreId> [sourceStoreId]");
  process.exit(1);
}

const stores = loadStores();
const target = stores.find((s) => s.id === targetId);
const source = stores.find((s) => s.id === sourceId);
if (!target) throw new Error(`target store "${targetId}" not found in SHOPIFY_STORES`);
if (!source) throw new Error(`source store "${sourceId}" not found in SHOPIFY_STORES`);

console.log(`source: ${source.name} (${source.storeDomain})`);
console.log(`target: ${target.name} (${target.storeDomain})\n`);

const sourceGql = makeGql(source, await getToken(source));
console.log("reading source spec records...");
const specs = await readSourceSpecs(source, sourceGql);
console.log(`  read ${specs.length} records\n`);

const targetGql = makeGql(target, await getToken(target));
console.log("ensuring metaobject definition...");
const defId = await ensureMetaobjectDefinition(targetGql, specs);

console.log("\nensuring spec records...");
const specMetafields = await ensureRecords(targetGql, specs);

console.log("\nensuring variant metafield definition...");
await ensureVariantMetafieldDefinition(targetGql, defId);

console.log("\n─── paste this as the target store's \"specMetafields\" in SHOPIFY_STORES ───");
console.log(JSON.stringify(specMetafields, null, 2));
