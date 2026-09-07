/**
 * Verifies the API catalogue against the routes that actually exist.
 *
 * `src/lib/api-tokens/api-catalog.ts` powers the endpoint list on
 * /settings/api-tokens. It is hand-written on purpose — the "what is this for"
 * column is the reason the list is worth reading, and no generator can produce
 * it — but hand-written means it drifts the moment someone adds a route.
 *
 * This catches that drift. A missing entry is the harmful direction: the page
 * claims to show every endpoint, so an absent one reads as "does not exist".
 *
 *   node scripts/check-api-catalog.mjs
 *
 * Exits non-zero when the two disagree, so it can gate a commit or CI.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_DIR = "src/app/api";
const CATALOG = "src/lib/api-tokens/api-catalog.ts";

/** Route paths as Next.js resolves them, e.g. "/api/products/[id]". */
function findRoutes(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...findRoutes(path));
    } else if (entry === "route.ts") {
      found.push(path.replace(/^src\/app/, "").replace(/\/route\.ts$/, ""));
    }
  }
  return found;
}

/**
 * Methods a route file exports.
 *
 * Regex rather than parsing: these are all plain `export async function GET`
 * declarations, and a parser here would be more machinery than the check needs.
 */
function exportedMethods(routePath) {
  const file = join("src/app", routePath, "route.ts");
  const src = readFileSync(file, "utf8");
  return [
    ...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g),
  ].map((m) => m[1]);
}

const realRoutes = findRoutes(API_DIR).sort();
const catalogSource = readFileSync(CATALOG, "utf8");

/**
 * Entries as declared in the catalogue, with the methods each claims.
 *
 * `\s*` between the two fields rather than a newline: entries are written
 * both on one line and across several depending on length, and requiring a
 * line break silently matched only the multi-line ones — which looked like 48
 * missing routes rather than a broken pattern.
 */
const entries = [
  ...catalogSource.matchAll(
    /methods:\s*\[([^\]]*)\],\s*path:\s*"(\/api[^"]*)"/g
  ),
].map(([, methodList, path]) => ({
  path,
  methods: [...methodList.matchAll(/"([A-Z]+)"/g)].map((m) => m[1]),
}));

const listed = new Map(entries.map((e) => [e.path, e.methods]));

const problems = [];

for (const route of realRoutes) {
  if (!listed.has(route)) {
    problems.push(`MISSING   ${route} — exists but is not in the catalogue`);
    continue;
  }
  // Method drift matters as much as a missing route: a page that shows only
  // GET on a route that now also accepts DELETE understates what exists.
  const actual = exportedMethods(route).sort();
  const claimed = [...listed.get(route)].sort();
  if (actual.join(",") !== claimed.join(",")) {
    problems.push(
      `METHODS   ${route} — code has [${actual.join(" ")}], ` +
      `catalogue says [${claimed.join(" ")}]`
    );
  }
}

for (const path of listed.keys()) {
  if (!realRoutes.includes(path)) {
    problems.push(`PHANTOM   ${path} — in the catalogue but no route file`);
  }
}

if (entries.length !== listed.size) {
  problems.push(
    `DUPLICATE — ${entries.length} entries but ${listed.size} unique paths`
  );
}

console.log(
  `routes on disk: ${realRoutes.length} · catalogue entries: ${entries.length}`
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error("  " + p);
  console.error(`\nFix ${CATALOG} so the settings page tells the truth.\n`);
  process.exit(1);
}

console.log("catalogue matches the routes on disk.");
