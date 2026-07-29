/**
 * Clone metafield DEFINITIONS from a source store to a target store.
 *
 * Source store is only ever READ from — this script issues no mutations against
 * it. Every write targets the target store.
 *
 * Namespaces are filtered by design:
 *   - custom.*, reviews.*, seo.*  → cloned (these are the store's own schema)
 *   - shopify.*                   → SKIPPED: Shopify-managed standard definitions,
 *                                  auto-created when a product category is set.
 *                                  Their metaobject_definition_id validations
 *                                  point at source-shop GIDs that don't exist on
 *                                  the target, so cloning them would fail anyway.
 *   - mm-google-shopping.*        → SKIPPED: owned by the Google Shopping app;
 *                                  reinstalling the app on the target recreates them.
 *
 * Reference-type validations are rewritten for the target shop:
 *   - metaobject_definition_id → remapped by metaobject TYPE (looked up on target)
 *   - a validation that can't be remapped is dropped, and the definition is still
 *     created (an unconstrained reference beats no field at all); each drop is logged.
 *
 * Idempotent: definitions that already exist are left untouched.
 *
 * Usage:
 *   node scripts/clone-store-metafield-definitions.mjs <targetStoreId> [sourceStoreId] [--apply]
 *
 * Defaults to a DRY RUN. Pass --apply to actually write. sourceStoreId defaults to "main".
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

/**
 * Fallback map for metaobject-reference validations when the SOURCE app can't read
 * metaobjectDefinitions (missing read_metaobjects scope) and so can't tell us which
 * type a source GID belongs to. These two keys are known to reference `cue_spec`.
 */
const KEY_TO_METAOBJECT_TYPE = {
  "custom.cue_spec": "cue_spec",
  "custom.cue_spec_variants": "cue_spec",
};

const OWNER_TYPES = ["PRODUCT", "PRODUCTVARIANT", "COLLECTION", "SHOP"];
const CLONE_NAMESPACES = ["custom", "reviews", "seo"];
const SKIP_NAMESPACE_PREFIXES = ["shopify", "mm-google-shopping", "mm_google_shopping_extension"];

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
  return async (query, variables) => {
    const res = await fetch(`https://${store.storeDomain}/admin/api/${store.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) {
      const msg = Array.isArray(json.errors) ? json.errors.map((e) => e.message).join("; ") : String(json.errors);
      throw new Error(`${store.storeDomain}: ${msg}`);
    }
    return json.data;
  };
}

const DEF_QUERY = `
query($owner: MetafieldOwnerType!) {
  metafieldDefinitions(first: 250, ownerType: $owner) {
    nodes {
      name namespace key description
      type { name }
      validations { name value }
      capabilities { adminFilterable { enabled } smartCollectionCondition { enabled } }
    }
  }
}`;

/** Map metaobject definition TYPE -> GID on a store (types are portable, GIDs are not). */
async function metaobjectTypeMap(gql, label) {
  const byGid = new Map();
  const byType = new Map();
  try {
    const d = await gql(`{ metaobjectDefinitions(first: 250) { nodes { id type } } }`);
    for (const n of d.metaobjectDefinitions.nodes) {
      byGid.set(n.id, n.type);
      byType.set(n.type, n.id);
    }
  } catch (e) {
    console.warn(`  ! cannot read metaobject definitions on ${label} (${e.message.slice(0, 60)}) — metaobject validations will be dropped`);
  }
  return { byGid, byType };
}

/**
 * Enable a Shopify STANDARD metafield definition (e.g. reviews.rating) on the
 * target. These are reserved templates: metafieldDefinitionCreate rejects them,
 * and they must be switched on by their template id instead.
 * Returns true if enabled (or already enabled), false if unavailable.
 */
async function enableStandardDefinition(gql, owner, namespace, key) {
  let templates;
  try {
    templates = await gql(
      `{ standardMetafieldDefinitionTemplates(first: 250) { nodes { id key namespace ownerTypes } } }`
    );
  } catch (e) {
    console.log(`     (cannot list standard templates: ${e.message.slice(0, 80)})`);
    return false;
  }
  const match = templates.standardMetafieldDefinitionTemplates.nodes.find(
    (t) => t.namespace === namespace && t.key === key && t.ownerTypes.includes(owner)
  );
  if (!match) return false;

  try {
    const res = await gql(
      `mutation($id: ID!, $ownerType: MetafieldOwnerType!) {
        standardMetafieldDefinitionEnable(id: $id, ownerType: $ownerType) {
          createdDefinition { id }
          userErrors { code field message }
        }
      }`,
      { id: match.id, ownerType: owner }
    );
    const errs = res.standardMetafieldDefinitionEnable.userErrors ?? [];
    if (!errs.length) return true;
    return errs.every((e) => e.code === "TAKEN" || /already|exists|taken/i.test(e.message));
  } catch (e) {
    console.log(`     (enable failed: ${e.message.slice(0, 80)})`);
    return false;
  }
}

let skippedStandard = 0;

const targetId = process.argv[2];
const sourceId = process.argv.find((a, i) => i >= 3 && !a.startsWith("--")) ?? "main";
const APPLY = process.argv.includes("--apply");
if (!targetId) {
  console.error("Usage: node scripts/clone-store-metafield-definitions.mjs <targetStoreId> [sourceStoreId] [--apply]");
  process.exit(1);
}

const stores = loadStores();
const target = stores.find((s) => s.id === targetId);
const source = stores.find((s) => s.id === sourceId);
if (!target) throw new Error(`target store "${targetId}" not found`);
if (!source) throw new Error(`source store "${sourceId}" not found`);

console.log(`source (READ ONLY): ${source.name} (${source.storeDomain})`);
console.log(`target:             ${target.name} (${target.storeDomain})`);
console.log(APPLY ? "\nMODE: APPLY\n" : "\nMODE: DRY RUN (pass --apply to write)\n");

const srcGql = makeGql(source, await getToken(source));
const tgtGql = makeGql(target, await getToken(target));

// Resolve metaobject definition GIDs across shops by type.
const srcMo = await metaobjectTypeMap(srcGql, "source");
const tgtMo = await metaobjectTypeMap(target === source ? srcGql : tgtGql, "target");

let created = 0, existed = 0, skipped = 0, failed = 0;
const warnings = [];

for (const owner of OWNER_TYPES) {
  const srcDefs = (await srcGql(DEF_QUERY, { owner })).metafieldDefinitions.nodes;
  const tgtDefs = (await tgtGql(DEF_QUERY, { owner })).metafieldDefinitions.nodes;
  const have = new Set(tgtDefs.map((d) => `${d.namespace}.${d.key}`));

  const todo = srcDefs.filter((d) => {
    if (SKIP_NAMESPACE_PREFIXES.some((p) => d.namespace === p || d.namespace.startsWith(p))) return false;
    return CLONE_NAMESPACES.includes(d.namespace);
  });

  console.log(`── ${owner}: ${srcDefs.length} on source, ${todo.length} eligible, ${tgtDefs.length} already on target`);

  for (const d of todo) {
    const full = `${d.namespace}.${d.key}`;
    if (have.has(full)) { console.log(`   = ${full}`); existed++; continue; }

    // Rewrite validations that reference shop-scoped resources.
    const validations = [];
    for (const v of d.validations ?? []) {
      if (v.name === "metaobject_definition_id") {
        // Prefer a type lookup on the source; when the source app lacks the
        // metaobjectDefinitions read scope, fall back to inferring the type from
        // the metafield key (custom.cue_spec / cue_spec_variants -> "cue_spec").
        const type = srcMo.byGid.get(v.value) ?? KEY_TO_METAOBJECT_TYPE[full];
        const remapped = type ? tgtMo.byType.get(type) : undefined;
        if (remapped) {
          validations.push({ name: v.name, value: remapped });
        } else {
          warnings.push(`${full}: dropped metaobject_definition_id (source type="${type ?? "unknown"}" not on target) — field created unconstrained`);
        }
        continue;
      }
      validations.push({ name: v.name, value: v.value });
    }

    const definition = {
      ownerType: owner,
      name: d.name,
      namespace: d.namespace,
      key: d.key,
      type: d.type.name,
      ...(d.description ? { description: d.description } : {}),
      ...(validations.length ? { validations } : {}),
      ...(d.capabilities?.adminFilterable?.enabled || d.capabilities?.smartCollectionCondition?.enabled
        ? {
            capabilities: {
              ...(d.capabilities?.adminFilterable?.enabled ? { adminFilterable: { enabled: true } } : {}),
              ...(d.capabilities?.smartCollectionCondition?.enabled ? { smartCollectionCondition: { enabled: true } } : {}),
            },
          }
        : {}),
    };

    if (!APPLY) { console.log(`   + would create ${full} [${d.type.name}]`); created++; continue; }

    try {
      const res = await tgtGql(
        `mutation($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { code field message }
          }
        }`,
        { definition }
      );
      const errs = res.metafieldDefinitionCreate.userErrors ?? [];
      if (errs.length) {
        if (errs.every((e) => e.code === "TAKEN" || /already|exists|taken/i.test(e.message))) {
          console.log(`   = ${full} (already existed)`); existed++;
        } else if (errs.some((e) => /reserved for standard definitions/i.test(e.message))) {
          // Shopify owns this namespace.key (e.g. reviews.rating): it can't be
          // created via metafieldDefinitionCreate, only switched on from the
          // shop's standard-definition template list.
          const ok = await enableStandardDefinition(tgtGql, owner, d.namespace, d.key);
          if (ok) { console.log(`   + ${full} (enabled standard definition)`); created++; }
          else { console.log(`   ~ ${full}: standard definition unavailable on target — skipped`); skippedStandard++; }
        } else {
          console.log(`   ! ${full}: ${errs.map((e) => `${e.field}: ${e.message}`).join("; ")}`); failed++;
        }
      } else {
        console.log(`   + ${full} [${d.type.name}]`); created++;
      }
    } catch (e) {
      console.log(`   ! ${full}: ${e.message.slice(0, 160)}`); failed++;
    }
  }

  skipped += srcDefs.length - todo.length;
}

console.log(`\n${APPLY ? "created" : "would create"}=${created}  existed=${existed}  skipped(namespace)=${skipped}  skipped(standard-unavailable)=${skippedStandard}  failed=${failed}`);
if (warnings.length) {
  console.log("\nwarnings:");
  for (const w of warnings) console.log(`  - ${w}`);
}
console.log("\nNote: shopify.* standard definitions are intentionally skipped — Shopify");
console.log("recreates those on the target when a product category is assigned.");
