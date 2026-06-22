// Backfill shopify_drafts from existing shopify_deployments.form_data.
//
// Migration 022 was supposed to populate shopify_drafts (one shared draft per
// product) from the per-store deployment rows, but the table is empty in this
// DB — so the editor reads no form_data and the Shopify dialog renders empty.
// This re-runs that backfill: for each product that has form_data on ANY of its
// deployment rows, upsert a shared draft using the most recently updated row.
//
// Idempotent: ON CONFLICT skips products that already have a draft.
// Run: node scripts/backfill-shopify-drafts.mjs [--dry]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const DRY = process.argv.includes("--dry");
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const get = (k) => env.split("\n").find((l) => l.startsWith(k + "="))?.slice(k.length + 1).trim();
const supa = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"), {
  db: { schema: "shopify_customizer" },
  auth: { persistSession: false },
});

// Pull every deployment row that carries form_data, newest first.
const { data: deps, error } = await supa
  .from("shopify_deployments")
  .select("product_id, store_id, form_data, title, created_by, updated_at")
  .not("form_data", "is", null)
  .order("updated_at", { ascending: false });
if (error) throw new Error(error.message);

// First row per product wins (most recently updated, since ordered desc).
const byProduct = new Map();
for (const d of deps ?? []) {
  if (!byProduct.has(d.product_id)) byProduct.set(d.product_id, d);
}

// Skip products that already have a draft.
const { data: existing } = await supa.from("shopify_drafts").select("product_id");
const have = new Set((existing ?? []).map((r) => r.product_id));

const toUpsert = [];
for (const [productId, d] of byProduct) {
  if (have.has(productId)) continue;
  toUpsert.push({
    product_id: productId,
    form_data: d.form_data,
    title: d.title ?? d.form_data?.title ?? null,
    updated_by: d.created_by ?? null,
  });
}

console.log(`Deployment rows with form_data: ${deps?.length ?? 0}`);
console.log(`Distinct products with form_data: ${byProduct.size}`);
console.log(`Already have a draft: ${have.size}`);
console.log(`Will create drafts for: ${toUpsert.length} products`);

if (DRY) {
  console.log("\n[dry run] no writes performed.");
  console.log(toUpsert.map((r) => `  - ${r.product_id} (title: ${r.title ?? "—"})`).join("\n"));
} else if (toUpsert.length) {
  const { error: upErr } = await supa
    .from("shopify_drafts")
    .upsert(toUpsert, { onConflict: "product_id", ignoreDuplicates: true });
  if (upErr) throw new Error(upErr.message);
  console.log(`\n✅ Backfilled ${toUpsert.length} drafts.`);
} else {
  console.log("\nNothing to backfill.");
}
