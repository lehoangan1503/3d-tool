/**
 * Copy the Shopify-hosted VIDEO files that a theme's JSON templates reference from
 * a source store to a target store.
 *
 * Source store is only ever READ from — no mutation is issued against it.
 *
 * Why this exists: theme templates store video picker values as
 * `shopify://files/videos/<filename>`, which resolve per-shop. Pushing a template
 * that references a video the target store doesn't have makes Shopify reject the
 * WHOLE asset with 422 ("value does not point to an applicable shopify-hosted video
 * resource") — so e.g. templates/product.json silently never deploys and every
 * product URL 404s.
 *
 * This scans local theme template JSON for `shopify://files/videos/...` values,
 * finds each file on the source store, and re-creates it on the target via
 * fileCreate from the source CDN URL (same filename, so the template's
 * `shopify://` reference resolves unchanged — no template edit needed).
 *
 * Idempotent: filenames already present on the target are skipped.
 *
 * Usage:
 *   node scripts/copy-theme-videos.mjs <targetStoreId> [sourceStoreId] [options]
 *
 * Options:
 *   --apply            actually create files (default is a DRY RUN)
 *   --theme-dir=PATH   local theme checkout (default: ../prime-cues-clone)
 *   --wait             poll until every new file reports READY
 */
import fs from "node:fs";
import path from "node:path";

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

/** Collect every shopify://files/videos/<name> referenced by theme JSON. */
function scanThemeVideos(themeDir) {
  const refs = new Map(); // filename -> [where]
  const dirs = ["templates", "sections", "config", "blocks"];
  for (const d of dirs) {
    const dir = path.join(themeDir, d);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const rel = `${d}/${entry.name}`;
      const raw = fs.readFileSync(path.join(dir, entry.name), "utf8");
      // Theme JSON escapes forward slashes ("shopify:\/\/files\/videos\/x.mp4"),
      // so scan the PARSED values rather than the raw text — a raw regex silently
      // misses every escaped reference.
      const names = new Set();
      const visit = (o) => {
        if (typeof o === "string") {
          const m = /^shopify:\/\/files\/videos\/(.+)$/.exec(o);
          if (m) names.add(m[1]);
        } else if (Array.isArray(o)) {
          o.forEach(visit);
        } else if (o && typeof o === "object") {
          Object.values(o).forEach(visit);
        }
      };
      try {
        visit(JSON.parse(raw));
      } catch {
        // Not valid JSON (or a .liquid-ish file): fall back to a text scan that
        // tolerates both escaped and unescaped slashes.
        for (const m of raw.matchAll(/shopify:(?:\\?\/){2}files\\?\/videos\\?\/([^"'\\]+)/g)) names.add(m[1]);
      }
      for (const name of names) {
        if (!refs.has(name)) refs.set(name, []);
        if (!refs.get(name).includes(rel)) refs.get(name).push(rel);
      }
    }
  }
  return refs;
}

/** filename -> node, for every video on a store. */
async function videoIndex(gql) {
  const map = new Map();
  let cursor = null;
  for (;;) {
    const d = await gql(
      `query($c: String) {
        files(first: 250, after: $c, query: "media_type:VIDEO") {
          pageInfo { hasNextPage endCursor }
          nodes { id fileStatus ... on Video { filename sources { url format mimeType width height } } }
        }
      }`,
      { c: cursor }
    );
    for (const n of d.files.nodes) if (n.filename) map.set(n.filename, n);
    if (!d.files.pageInfo.hasNextPage) break;
    cursor = d.files.pageInfo.endCursor;
  }
  return map;
}

const targetId = process.argv[2];
const sourceId = process.argv.find((a, i) => i >= 3 && !a.startsWith("--")) ?? "main";
const APPLY = process.argv.includes("--apply");
const WAIT = process.argv.includes("--wait");
const THEME_DIR = arg("theme-dir", "/Users/an/Documents/prime-cues-clone");

if (!targetId) {
  console.error("Usage: node scripts/copy-theme-videos.mjs <targetStoreId> [sourceStoreId] [--apply] [--theme-dir=PATH] [--wait]");
  process.exit(1);
}

const stores = loadStores();
const target = stores.find((s) => s.id === targetId);
const source = stores.find((s) => s.id === sourceId);
if (!target) throw new Error(`target store "${targetId}" not found`);
if (!source) throw new Error(`source store "${sourceId}" not found`);

console.log(`source (READ ONLY): ${source.name} (${source.storeDomain})`);
console.log(`target:             ${target.name} (${target.storeDomain})`);
console.log(`theme dir:          ${THEME_DIR}`);
console.log(APPLY ? "\nMODE: APPLY\n" : "\nMODE: DRY RUN (pass --apply to write)\n");

const refs = scanThemeVideos(THEME_DIR);
console.log(`theme references ${refs.size} distinct video file(s):`);
for (const [name, where] of refs) console.log(`   ${name}  ← ${where.join(", ")}`);

const srcGql = makeGql(source, await getToken(source));
const tgtGql = makeGql(target, await getToken(target));

console.log("\nindexing videos…");
const [srcVideos, tgtVideos] = await Promise.all([videoIndex(srcGql), videoIndex(tgtGql)]);
console.log(`  source has ${srcVideos.size}, target has ${tgtVideos.size}\n`);

const todo = [];
for (const [name, where] of refs) {
  if (tgtVideos.has(name)) { console.log(`   = ${name} already on target`); continue; }
  const src = srcVideos.get(name);
  if (!src) { console.log(`   ! ${name} NOT FOUND on source (referenced by ${where.join(", ")})`); continue; }
  // Prefer the largest mp4 rendition; fall back to whatever source exists.
  const pick = (src.sources ?? []).filter((x) => /mp4/i.test(x.format || x.mimeType || "")).sort((a, b) => (b.width || 0) - (a.width || 0))[0] ?? src.sources?.[0];
  if (!pick?.url) { console.log(`   ! ${name} has no downloadable source on source store`); continue; }
  todo.push({ name, url: pick.url, w: pick.width, h: pick.height });
}

console.log(`\n${todo.length} video(s) to copy`);
if (!todo.length) { console.log("nothing to do."); process.exit(0); }

/**
 * Upload one video to the target via staged upload.
 *
 * fileCreate can't ingest a Shopify CDN *transcoded* URL directly (it answers
 * "Invalid video url"), so the bytes are downloaded and re-uploaded through
 * stagedUploadsCreate. The staged target's filename must keep the SOURCE url's
 * extension (Shopify rejects filename/source extension mismatches, e.g. a
 * template referencing "IMG_0100.MP4" against a ".mp4" rendition), while the
 * final file keeps the template's exact name so `shopify://` still resolves.
 */
async function uploadVideo(v) {
  // Use the template's EXACT filename (including uppercase ".MP4") for both the
  // staged target and fileCreate: Shopify compares the fileCreate filename against
  // the staged resourceUrl's extension, so they must agree — and the stored name
  // must stay byte-identical to what `shopify://files/videos/<name>` references.
  const stagedName = v.name;

  // Download first: VIDEO staged uploads require the exact fileSize up front.
  const dl = await fetch(v.url);
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  const bytes = new Uint8Array(await dl.arrayBuffer());

  const staged = await tgtGql(
    `mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [{
        resource: "VIDEO",
        filename: stagedName,
        mimeType: "video/mp4",
        httpMethod: "POST",
        fileSize: String(bytes.length),
      }],
    }
  );
  const sErrs = staged.stagedUploadsCreate.userErrors ?? [];
  if (sErrs.length) throw new Error(`stagedUploadsCreate: ${sErrs.map((e) => e.message).join("; ")}`);
  const targetSlot = staged.stagedUploadsCreate.stagedTargets?.[0];
  if (!targetSlot?.url) throw new Error("stagedUploadsCreate returned no target");

  const form = new FormData();
  for (const p of targetSlot.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([bytes], { type: "video/mp4" }), stagedName);
  const up = await fetch(targetSlot.url, { method: "POST", body: form });
  if (!up.ok) throw new Error(`staged upload ${up.status}: ${(await up.text()).slice(0, 200)}`);

  const created = await tgtGql(
    `mutation($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus ... on Video { filename } }
        userErrors { field message code }
      }
    }`,
    // No `filename` here on purpose: a VIDEO staged resourceUrl carries no file
    // extension (".../googleapis.com?external_video_id=N"), so ANY filename is
    // rejected as MISMATCHED_FILENAME_AND_ORIGINAL_SOURCE. Shopify instead keeps
    // the name given to stagedUploadsCreate above — which is v.name verbatim.
    { files: [{ contentType: "VIDEO", originalSource: targetSlot.resourceUrl, alt: v.name }] }
  );
  const cErrs = created.fileCreate.userErrors ?? [];
  if (cErrs.length) throw new Error(cErrs.map((e) => `${e.code ?? ""} ${e.message}`.trim()).join("; "));
  return { file: created.fileCreate.files?.[0], mb: (bytes.length / 1048576).toFixed(1) };
}

let created = 0, failed = 0;
const newIds = [];
for (const v of todo) {
  if (!APPLY) { console.log(`   + would copy ${v.name} (${v.w}x${v.h})`); created++; continue; }
  try {
    const { file, mb } = await uploadVideo(v);
    console.log(`   + ${v.name} (${mb}MB) → ${file?.id} (${file?.fileStatus})`);
    if (file?.id) newIds.push(file.id);
    created++;
  } catch (e) {
    console.log(`   ! ${v.name}: ${String(e.message).slice(0, 180)}`);
    failed++;
  }
}

// Videos transcode asynchronously; a template push referencing a non-READY video
// still fails, so optionally wait for them to finish.
if (APPLY && WAIT && newIds.length) {
  console.log("\nwaiting for transcoding to finish…");
  for (let round = 0; round < 60; round++) {
    const d = await tgtGql(
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Video { id fileStatus filename } } }`,
      { ids: newIds }
    );
    const nodes = (d.nodes ?? []).filter(Boolean);
    const ready = nodes.filter((n) => n.fileStatus === "READY").length;
    const failedN = nodes.filter((n) => n.fileStatus === "FAILED");
    console.log(`   ${ready}/${nodes.length} READY${failedN.length ? `, ${failedN.length} FAILED` : ""}`);
    if (ready + failedN.length >= nodes.length) {
      for (const f of failedN) console.log(`   ! FAILED: ${f.filename}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

console.log(`\n${APPLY ? "created" : "would create"}=${created}  failed=${failed}`);
if (APPLY && created) {
  console.log("\nNext: push the theme again (GitHub sync or theme push) so");
  console.log("templates/product.json and templates/index.json deploy successfully.");
}
