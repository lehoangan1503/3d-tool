# Server-Side Render API + MCP — Implementation Plan

## Goal

Expose the current browser-based Three.js render pipeline as a **server-side HTTP API**, so images can be generated automatically (without a human opening the editor in a browser). Then wrap that API in an **MCP server** so it can be driven by automation/agents.

**Hard requirement (from the user):** the headless render must be **1:1 identical** to what the client produces today.
- **Single product render** → same logic as the **Extractor image** feature.
- **Bulk / download-multiple** → same logic as the **Bulk image** feature.

## Chosen approach

**Option A — Headless Chromium via Playwright**, hosted in a **dedicated render sidecar container** on the existing VPS, exposed publicly as `https://3d.next.lc/api/render` and protected by a **secret API token**.

Rationale: we run the *exact* current client code inside real Chromium, so output is byte-for-byte equivalent (HDRI, PMREM, KTX2/Basis transcoding, 2D blend-mode compositing all behave identically — these are exactly the features that break under Node WebGL shims like `headless-gl`). No rewrite of the Three.js logic.

```
MCP / client ──HTTPS──▶ https://3d.next.lc/api/render   (public, Bearer token)
                            │
                            ▼
                        Nginx (already routing 3d.next.lc → main Next.js container)
                            │  proxies /api/render
                            ▼
                  Main Next.js container: /api/render route
                            │  validates token + builds RenderSpec
                            │  forwards to render sidecar over the internal Docker network
                            ▼
                  Render sidecar container (Next.js worker route + Playwright)
                            │  Playwright (warm Chromium page pool)
                            │  Chromium navigates to http://localhost:3000/render-worker  (same container, internal)
                            │  loads /public models·HDRI·/basis over localhost, runs the SAME exported editor fns
                            ▼
                    returns base64 PNG(s) → /api/render → upload to Supabase / base64 / zip → caller
```

> Note: heavy assets (25–32 MB GLB, HDRIs, Basis transcoder) load over **localhost inside the sidecar** — they never traverse Nginx or the public domain. Only the public `POST /api/render` call goes through Nginx.

### Hosting decision — separate render sidecar
- A dedicated **render container** isolates Chromium's RAM/CPU spikes from the live site and the Supabase container on the shared VPS.
- The sidecar runs its own Next.js (serving `/render-worker` only) + Playwright; reachable on the internal Docker network (e.g. `http://render:3000`), **not** published to the host/public.
- `/api/render` in the main app proxies to it. Can be collapsed into the main container later if desired, but sidecar is the chosen default.

### Auth — secret API token
- `POST /api/render` requires `Authorization: Bearer <RENDER_API_TOKEN>` (env var, never committed).
- The internal call from main app → sidecar carries the same/another shared secret; sidecar is not publicly reachable regardless.

### Stability & speed (answering the user's questions)
- **Stable:** yes — standard production pattern. Risks are operational (memory, concurrency), not correctness. Mitigated by a bounded page pool + periodic page recycling.
- **Latency (warm browser, CPU-only / SwiftShader on the VPS):**
  - single frame 1024px: ~1–3s
  - single product extractor-style 2048px: ~4–10s
  - bulk 10 products × 3 refs: several minutes (cap concurrency)
  - cold start: +1–3s one-time (kept warm by the pool)
- **No GPU required** — quality is identical on CPU (SwiftShader); GPU only affects speed.

## VPS sizing & infra (CPU-only — no GPU)

**Quality does NOT depend on GPU.** Leather/surface detail comes from the 2048px render, KTX2 textures, anisotropic filtering, AA, and HDRI — all computed identically on CPU (SwiftShader). GPU = faster only, never better-looking. Verified scene knobs: 2048×2048 at `setPixelRatio(1)`, `antialias:true`, `VSMShadowMap`, `ACESFilmicToneMapping`, anisotropy, shadow quality up to 4096; models 25–32 MB KTX2, HDRIs ~6 MB (2K).

**Recommended sidecar resources:**
- CPU: 4 vCPU (SwiftShader is multithreaded — more cores = faster)
- RAM: 8 GB min (Chromium + a 32 MB model + HDRI + 2048px buffers ≈ 1–1.5 GB per render page), 16 GB comfortable; leave headroom for the main app + Supabase containers.
- Add 2–4 GB **swap** as OOM safety.
- **Concurrency cap is critical:** start `RENDER_CONCURRENCY=1` (or 2). Letting bulk fan out in parallel on CPU will OOM.
- Container: `--shm-size=1gb` (Chromium crashes with default tiny `/dev/shm`).

**Chromium launch flags (CPU/SwiftShader):**
`--use-gl=angle --use-angle=swiftshader --no-sandbox --enable-webgl --ignore-gpu-blocklist --disable-dev-shm-usage`

**Docker:** base the sidecar on Playwright's official image (`mcr.microsoft.com/playwright`) for bundled system libs.

**Nginx — raise timeouts for the render route** (bulk exceeds the default 60s → would 504):
```nginx
location /api/render {
    proxy_pass http://nextjs_upstream;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_request_buffering off;
    client_max_body_size 50m;   # if surface images are POSTed inline
}
```

**Env vars:**
- `RENDER_API_TOKEN` — public bearer token for `/api/render`.
- `RENDER_SIDECAR_URL` — internal sidecar address, e.g. `http://render:3000`.
- `RENDER_WORKER_URL` — sidecar's own worker page, e.g. `http://localhost:3000/render-worker`.
- `RENDER_CONCURRENCY` — page-pool size (start at 1).

## Key discovery — render logic is already reusable

The render code is **already factored into exported, framework-agnostic functions** in
`src/components/editor/image-extractor.tsx`:

- `renderCueFrameViaStudio(model, studioConfigSnapshot, w, h, studioEsm, wallsTransparent, overrideSurfaceUrl)` — renders one cue frame; ends in `studioEsm.captureCleanFrame(size, "png", wallsTransparent)` (line 130). **This is the single-product / extractor primitive.**
- `renderReferenceToBlob(model, reference, overrideSurfaceUrl?)` (line 150) — composites a full reference (CueFrames + ImageFrames) onto a 2D canvas → PNG blob. This is **identical** to `renderRefForProduct` in `bulk-image-tab.tsx`. **This is the bulk primitive.**
- Helpers `createCanvasGradient`, `drawSurfaceWithPan`, `drawImageWithObjectFit`, `hdriLayersToCueHdri` — already exported.

So the server path mostly **drives existing functions inside Chromium**; we don't reimplement rendering.

The scene/model side:
- `SceneManager` (`src/lib/three/scene-manager.ts`) — `loadModel`, `applySurface`, `updateBodyRoughness`, `updateJointConfig`, `getModelForClone`.
- `ExtractorSceneManager` (`src/lib/three/extractor-scene-manager.ts`) — `captureFrame`, `captureCleanFrame`, HDRI/shadow/camera controls.

The bulk per-product setup is fully described by `handleStart` in `bulk-image-tab.tsx:213-279` (load model → applySurface → fetch product config → set roughness/joint → loop references → `renderRefForProduct`).

## Data contracts (reuse existing types)

From `src/types/extractor.ts`: `ExtractorReference`, `ExtractorReferenceGroup`, `ExtractorFrame`, `CueFrame`, `ImageFrame`, `DEFAULT_CANVAS_WIDTH/HEIGHT`, `DEFAULT_CUE_SHADOW`, `isCueFrame`, `isImageFrame`.
From `src/types/product.ts`: `Product`, `ProductConfig`, `MODEL_PATHS`, `settingsJsonToConfig`, `ThreeJSSettingsJson`.

Existing data APIs the worker reuses (no change): `/api/extractor-reference-groups`, `/api/extractor-references/[id]`, `/api/products/[id]/settings`.

---

## Components to build

### 1. Hidden render-worker route — `src/app/render-worker/page.tsx`
A minimal client page (no chrome/UI) that Playwright loads. It:
- Exposes a global entry, e.g. `window.__render(spec)` returning `{ images: { name, base64 }[] }`.
- For **single** spec: builds `SceneManager`, `loadModel`, `applySurface`, applies product config, then runs `renderReferenceToBlob` for one reference (or `renderCueFrameViaStudio` for a single bare frame) → base64.
- For **bulk** spec: replicates `handleStart`'s per-product loop using the already-exported `renderReferenceToBlob`.
- Converts Blob → base64 (`FileReader`/`blob.arrayBuffer()`) to cross the Playwright bridge.

This route reuses the **same imports** the editor uses — guaranteeing 1:1 output. It must be excluded from auth/middleware and not indexed.

### 2. Playwright browser pool — `src/server/render/browser-pool.ts`
- Launch one Chromium (`chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader' OR gpu flags','--no-sandbox','--enable-webgl','--ignore-gpu-blocklist'] })`).
- Maintain a bounded pool of pages (concurrency = `RENDER_CONCURRENCY`, default 2–4).
- Each page pre-navigated to `/render-worker` and warmed. Recycle a page after N renders to bound memory.
- `withPage(fn)` acquire/release helper. Global singleton across requests (module-scoped).
- Wait for fonts/WASM (basis transcoder) ready before first render.

### 3. Render service — `src/server/render/render-service.ts`
- `renderSingle(spec): Promise<RenderResult>` and `renderBulk(spec): Promise<RenderResult>`.
- Acquires a page, calls `page.evaluate((s) => window.__render(s), spec)`, gets base64 images.
- Pipes base64 through `sharp` if format conversion / optimization needed (sharp already a dep).
- Output dispatch per request: `base64` inline, **Supabase upload** (return URLs, mirrors existing `thumb_url` pattern), and/or **zip** (JSZip, server-side, for bulk).

> Components 1–3 (worker page, browser pool, render service) live in the **render sidecar container**. Component 4 (the public `/api/render` route) lives in the **main app container** and proxies to the sidecar. Component 5 (MCP) is external.

### 4. HTTP endpoint — `src/app/api/render/route.ts` (main app container)
`POST /api/render`. **Auth:** reject unless `Authorization: Bearer <RENDER_API_TOKEN>`. Validates a discriminated-union body (typed, no `any`), then forwards to `RENDER_SIDECAR_URL`:

```ts
interface RenderSingleRequest {
  mode: "single";
  productId?: string;          // load product + its surface/config from DB
  modelType?: ProductType;     // or specify model directly
  surfaceUrl?: string;         // texture override
  referenceId: string;         // which extractor reference to render
  output: ("base64" | "upload" | "zip")[];
  format?: "png" | "jpeg" | "webp";
  size?: number;
}

interface RenderBulkRequest {
  mode: "bulk";
  productIds: string[];        // or "all"
  groupIds: string[];          // extractor reference groups → references
  output: ("base64" | "upload" | "zip")[];
}

type RenderRequest = RenderSingleRequest | RenderBulkRequest;

interface RenderedImage { name: string; base64?: string; url?: string; }
interface RenderResponse { images: RenderedImage[]; zipUrl?: string; errors?: { item: string; error: string }[]; }
```

- `export const runtime = "nodejs"` (Playwright needs Node, not Edge).
- `export const maxDuration` raised for bulk.
- Auth: require service token / existing session — must not be open.

### 5. MCP server — `mcp/render-mcp/` (separate small Node package)
A stdio MCP server (`@modelcontextprotocol/sdk`) added to `.mcp.json` alongside `blender`. Tools:
- `render_product({ productId, referenceId, output })` → calls `POST /api/render` single.
- `render_group({ productIds | "all", groupIds, output })` → calls bulk.
- `list_reference_groups()` / `list_references()` / `list_products()` → thin GETs to existing APIs (so the agent can discover IDs).
Config: `RENDER_API_BASE_URL`, `RENDER_API_TOKEN` via env. Add entry to `.mcp.json`.

---

## Implementation order (phased, each independently testable)

1. **Extract per-product setup into a shared function.** Pull the body of `handleStart`'s loop (`bulk-image-tab.tsx:230-265`) into an exported `setupProductScene(product, config)` + reuse `renderReferenceToBlob`. Refactor `bulk-image-tab.tsx` to call it — **proves the refactor didn't change client output** (verify bulk export still byte-matches). No server code yet.
2. **Build `/render-worker` page** + `window.__render`. Test by opening it in a normal browser and calling `__render` from devtools; compare PNG to editor output (must be identical).
3. **Playwright pool + render-service**, driving `/render-worker`. Add Playwright dep + install Chromium. Unit-test `renderSingle` against a known product/reference.
4. **`POST /api/render`** wiring single + bulk, output dispatch (base64 → upload → zip).
5. **MCP server** + `.mcp.json` entry; verify tools end-to-end.
6. **Hardening:** concurrency cap, page recycling, timeouts, error-per-item reporting, auth token.

## Verification (1:1 guarantee)
- Golden-image test: render the same product+reference (a) in the editor and (b) via `/api/render`; assert pixel-identical (or within tiny tolerance for encoder differences).
- Run existing bulk flow before/after the step-1 refactor; diff the zip contents.

## Open risks / decisions deferred
- **Deploy target undecided** (user said "don't know yet"). Plan works on both serverless (SwiftShader, slower, memory-limited) and a GPU VM (fast). The browser-pool flags differ slightly per target — parameterize via env.
- KTX2/Basis transcoder path (`/basis/`) must resolve from the worker route (it does today since it's same-origin).
- Auth model for `/api/render` and `/render-worker` to confirm with user.

## Files touched (summary)
- New: `src/app/render-worker/page.tsx`, `src/server/render/browser-pool.ts`, `src/server/render/render-service.ts`, `src/server/render/types.ts`, `src/app/api/render/route.ts`, `mcp/render-mcp/*`.
- Edit: `src/components/products/bulk-image-tab.tsx` (use shared setup fn), `.mcp.json`, `package.json` (add `playwright`, `@modelcontextprotocol/sdk`), `next.config` / middleware (exclude `/render-worker`).
- Reused unchanged: `image-extractor.tsx` exports, `scene-manager.ts`, `extractor-scene-manager.ts`, `types/extractor.ts`, `types/product.ts`, existing data APIs.
