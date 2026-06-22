// One-off: create the custom.cue_spec_variants VARIANT metafield definition on Wow cue,
// bound to its cue_spec_variants metaobject definition. Mirrors Prime-cues' setup.
// Run: node scripts/create-wowcue-spec-def.mjs
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const stores = JSON.parse(
  env.split("\n").find((l) => l.startsWith("SHOPIFY_STORES=")).slice("SHOPIFY_STORES=".length)
);
const store = stores.find((s) => s.name === "Wow cue");
if (!store) throw new Error("Wow cue store not found in .env");

const METAOBJECT_DEF_ID = "gid://shopify/MetaobjectDefinition/16532471874";

const tokenRes = await fetch(`https://${store.storeDomain}/admin/oauth/access_token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: store.clientId,
    client_secret: store.clientSecret,
  }).toString(),
});
if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}: ${await tokenRes.text()}`);
const token = (await tokenRes.json()).access_token;

async function gql(query, variables) {
  const res = await fetch(`https://${store.storeDomain}/admin/api/${store.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const MUTATION = `
mutation Create($def: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $def) {
    createdDefinition { id name namespace key type { name } validations { name value } }
    userErrors { field message code }
  }
}`;

const input = {
  def: {
    name: "Cue spec variants",
    namespace: "custom",
    key: "cue_spec_variants",
    type: "metaobject_reference",
    ownerType: "PRODUCTVARIANT",
    validations: [{ name: "metaobject_definition_id", value: METAOBJECT_DEF_ID }],
  },
};

const out = await gql(MUTATION, input);
const result = out?.data?.metafieldDefinitionCreate;

if (out.errors) {
  console.log("❌ GraphQL error:", JSON.stringify(out.errors, null, 2));
} else if (result?.userErrors?.length) {
  console.log("❌ User errors:", JSON.stringify(result.userErrors, null, 2));
} else if (result?.createdDefinition) {
  const d = result.createdDefinition;
  console.log("✅ Created variant metafield definition on Wow cue:");
  console.log(`   ${d.namespace}.${d.key}  (${d.name})`);
  console.log(`   type: ${d.type.name}`);
  console.log(`   validations: ${JSON.stringify(d.validations)}`);
} else {
  console.log("Unexpected response:", JSON.stringify(out, null, 2));
}
