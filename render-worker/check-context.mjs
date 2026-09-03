/**
 * Build-time guard: fail loudly on the wrong Docker build context.
 *
 * The Dockerfile's COPY paths are written for a context at the REPO ROOT,
 * because RunPod's GitHub integration clones the whole repository and builds
 * from its root — there is no way to narrow the context to a subdirectory.
 *
 * Building by hand from ./render-worker instead puts the APP's package.json at
 * the context root. npm then installs Next.js and three.js, and no
 * puppeteer-core: the image builds successfully and only dies on first launch,
 * inside a metered GPU pod, with a confusing "Cannot find package" error.
 *
 * Catching it here turns that into an immediate, readable build failure.
 */

import { readFileSync } from "node:fs";

const EXPECTED = "cue-render-worker";

let pkg;
try {
  pkg = JSON.parse(readFileSync("./package.json", "utf8"));
} catch (error) {
  console.error(`\nCannot read ./package.json in the build context: ${error.message}\n`);
  process.exit(1);
}

if (pkg.name !== EXPECTED) {
  console.error(`
──────────────────────────────────────────────────────────────────────
 WRONG DOCKER BUILD CONTEXT

 Found package : "${pkg.name}"
 Expected      : "${EXPECTED}"

 The Dockerfile expects the build context to be the REPO ROOT:

     docker build -f render-worker/Dockerfile -t cue-render-worker .

 (note the trailing "." — not "./render-worker")

 On RunPod's GitHub integration, set the Dockerfile path to
 "render-worker/Dockerfile" and leave the build context at the root.
──────────────────────────────────────────────────────────────────────
`);
  process.exit(1);
}

console.log(`[build] context OK — package "${pkg.name}"`);
