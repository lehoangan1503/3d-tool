#!/usr/bin/env node
/**
 * End-to-end exerciser for the server-side render pipeline, from the terminal.
 *
 * The deploy dialog still renders in the browser, so until it is rewired there
 * is no UI that can queue a job — and the GPU path cannot be tested at all
 * without one. This script is that missing front end: it signs in as a real
 * user, finds a product and an image group (or video template), queues a job,
 * and polls until the GPU finishes, printing the output URLs.
 *
 * It talks to the same endpoints the UI will, with a real user session, so a
 * pass here means the API contract is sound — not just that the routes exist.
 *
 * Usage:
 *   node scripts/test-render-api.mjs list                       # what can be rendered
 *   node scripts/test-render-api.mjs image [productId] [groupId]
 *   node scripts/test-render-api.mjs video [productId] [templateId]
 *   node scripts/test-render-api.mjs watch <jobId>              # poll an existing job
 *   node scripts/test-render-api.mjs jobs                       # recent jobs
 *
 * With no ids it picks the first product and the first group/template it finds,
 * which is what you want for a smoke test.
 *
 * Env (falls back to .env in the repo root):
 *   APP_BASE_URL, TEST_EMAIL, TEST_PASSWORD,
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env reader — avoids a dependency for a dev-only script. */
function loadEnv() {
  try {
    const raw = readFileSync(join(ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // No .env is fine when everything is exported already.
  }
}
loadEnv();

const APP = (process.env.APP_BASE_URL ?? process.env.RENDER_APP_BASE_URL ?? "https://3d.next.lc")
  .replace(/\/$/, "");
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const EMAIL = process.env.TEST_EMAIL ?? "test22@example.com";
const PASSWORD = process.env.TEST_PASSWORD ?? "123123";

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/**
 * Signs in against GoTrue and returns BOTH the raw token (for PostgREST) and
 * the cookie header the Next.js routes expect.
 *
 * The routes call `createClient()` from lib/supabase/server, which is
 * `createServerClient` from @supabase/ssr — it reads the session from COOKIES
 * only and ignores an Authorization header. So a bearer token alone gets a
 * 401 no matter how valid it is; the session has to be presented the way a
 * browser would present it.
 *
 * The cookie name is derived from the Supabase URL by @supabase/ssr
 * ("sb-<host-first-label>-auth-token"), and its value is the base64url-encoded
 * session JSON prefixed with "base64-".
 */
async function signIn() {
  if (!SUPABASE_URL || !ANON_KEY) {
    die("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing (checked env and .env)");
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    die(`Login failed as ${EMAIL}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }

  console.log(`✓ signed in as ${EMAIL}`);

  // Mirror what @supabase/ssr writes in the browser: the whole session object,
  // base64url-encoded behind a "base64-" marker.
  const host = new URL(SUPABASE_URL).hostname.split(".")[0];
  const cookieName = `sb-${host}-auth-token`;
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");

  return {
    token: body.access_token,
    cookie: `${cookieName}=base64-${encoded}`,
  };
}

async function api(session, path, init = {}) {
  const res = await fetch(`${APP}${path}`, {
    ...init,
    headers: {
      // Cookie, not Authorization: the routes read the session via
      // @supabase/ssr, which only looks at cookies.
      Cookie: session.cookie,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // An HTML error page means a route is missing or the app crashed; showing
    // the first line is far more useful than a JSON parse error.
    json = { error: text.slice(0, 200).replace(/\s+/g, " ") };
  }
  return { status: res.status, body: json };
}

/** Reads a table through PostgREST, as the signed-in user (RLS applies). */
async function fromTable(session, table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${session.token}`,
      "Accept-Profile": "shopify_customizer",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    die(`Reading ${table} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function listTargets(session) {
  const [products, groups, templates] = await Promise.all([
    fromTable(session, "products", "select=id,name&order=created_at.desc&limit=10"),
    fromTable(session, "extractor_reference_groups", "select=id,name&order=created_at.desc&limit=10"),
    fromTable(session, "video_studio_templates", "select=id,name&order=created_at.desc&limit=10"),
  ]);

  const show = (label, rows) => {
    console.log(`\n${label} (${rows.length}):`);
    if (rows.length === 0) console.log("  (none — cannot render this kind)");
    for (const r of rows) console.log(`  ${r.id}  ${r.name ?? "(unnamed)"}`);
  };

  show("PRODUCTS", products);
  show("IMAGE GROUPS", groups);
  show("VIDEO TEMPLATES", templates);

  return { products, groups, templates };
}

/**
 * Polls until the job leaves a running state.
 *
 * Prints progress transitions only, not every tick — a 6-mockup job polled
 * every 3s would otherwise bury the result in a hundred identical lines.
 */
async function watchJob(session, jobId, { timeoutMs = 20 * 60_000 } = {}) {
  const startedAt = Date.now();
  let lastLine = "";

  for (;;) {
    const { status, body } = await api(session, `/api/render-jobs/${jobId}`);
    if (status !== 200) {
      die(`Poll failed: ${status} ${JSON.stringify(body).slice(0, 300)}`);
    }

    const line =
      `${body.status}  ${body.progressDone}/${body.progressTotal}` +
      `${body.progressLabel ? `  ${body.progressLabel}` : ""}` +
      `  outputs=${body.outputs?.length ?? 0}`;

    if (line !== lastLine) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`  [${String(elapsed).padStart(4)}s] ${line}`);
      lastLine = line;
    }

    if (["succeeded", "failed", "canceled"].includes(body.status)) {
      console.log(`\n${body.status === "succeeded" ? "✓" : "✗"} job ${body.status}`);
      if (body.errorMessage) console.log(`  error: ${body.errorMessage}`);

      for (const out of body.outputs ?? []) {
        const mb = (out.bytes / 1_048_576).toFixed(2);
        console.log(`  · ${out.name}  ${out.width}x${out.height}  ${mb}MB`);
        console.log(`    ${out.url}`);
      }

      if (body.expiresAt) {
        const hours = ((new Date(body.expiresAt).getTime() - Date.now()) / 3600_000).toFixed(1);
        console.log(`\n  retention: files deleted in ${hours}h (${body.expiresAt})`);
      }
      return body;
    }

    if (Date.now() - startedAt > timeoutMs) {
      die(`Timed out after ${Math.round(timeoutMs / 60000)} min — job still ${body.status}`);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function queue(session, kind, productId, targetId) {
  const { products, groups, templates } = await listTargets(session);

  const product = productId ?? products[0]?.id;
  if (!product) die("No products visible to this user — nothing to render");

  const target =
    targetId ?? (kind === "image" ? groups[0]?.id : templates[0]?.id);
  if (!target) {
    die(kind === "image" ? "No image groups found" : "No video templates found");
  }

  const path =
    kind === "image"
      ? `/api/products/${product}/renders`
      : `/api/products/${product}/videos`;

  const payload =
    kind === "image"
      ? { groupId: target, format: "png" }
      : { templateId: target, width: 1920, height: 1080, fps: 60 };

  console.log(`\n→ POST ${path}`);
  console.log(`  ${JSON.stringify(payload)}`);

  const { status, body } = await api(session, path, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (status !== 200 && status !== 202) {
    die(`Queue failed: ${status} ${JSON.stringify(body).slice(0, 400)}`);
  }

  if (body.warning) console.log(`\n⚠ ${body.warning}`);

  const jobs = body.jobs ?? [];
  console.log(`\n✓ queued ${jobs.length} job(s)`);
  for (const job of jobs) {
    console.log(`  ${job.id}  product=${job.productName ?? job.productId}  provider=${job.workerProvider ?? "none"}`);
  }

  if (jobs.length === 0) die("No jobs returned");

  console.log(`\nwatching ${jobs[0].id} …`);
  return watchJob(session, jobs[0].id);
}

async function main() {
  const [command = "list", arg1, arg2] = process.argv.slice(2);
  console.log(`app: ${APP}`);

  const session = await signIn();

  switch (command) {
    case "list":
      await listTargets(session);
      break;

    case "image":
    case "video":
      await queue(session, command, arg1, arg2);
      break;

    case "watch":
      if (!arg1) die("Usage: watch <jobId>");
      await watchJob(session, arg1);
      break;

    case "jobs": {
      const { status, body } = await api(session, "/api/render-jobs?status=queued,running,succeeded,failed");
      if (status !== 200) die(`Failed: ${status} ${JSON.stringify(body).slice(0, 300)}`);
      const jobs = body.jobs ?? body ?? [];
      console.log(`\n${jobs.length} job(s):`);
      for (const j of jobs) {
        console.log(
          `  ${j.id}  ${j.status.padEnd(9)} ${j.kind}  ${j.progressDone}/${j.progressTotal}` +
            `  ${j.productName ?? ""}${j.purgedAt ? "  [purged]" : ""}`
        );
      }
      break;
    }

    default:
      die(`Unknown command "${command}". Use: list | image | video | watch <jobId> | jobs`);
  }
}

main().catch((error) => die(error.stack ?? String(error)));
