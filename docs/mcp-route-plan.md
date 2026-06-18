# `/auto-deploy` Route ("Triển khai tự động") — Automated Bulk Render → AI Content → Shopify Deploy

> **Status: IMPLEMENTED (Phases 1–6 complete).** Renamed from the misleading "MCP" (this is in-app automation, not the Model Context Protocol). Route is `/auto-deploy`; UI label "Triển khai tự động". Admin-only button added to the dashboard header; page guarded by `canDeploy` (admin or mode). Builds clean (`tsc`, `eslint`, `next build`). Not yet manually run against live Shopify — see "Verification still needed" below.

## Files implemented
- `src/lib/auto-deploy/group-products.ts` — nXX grouping + `canDeployProduct`.
- `src/lib/auto-deploy/types.ts` — `AutoDeployConfig`, `emptyRunConfig`, `isRunConfigValid`.
- `src/lib/auto-deploy/run-pipeline.ts` — per-product pipeline (render → [video] → upload → AI content → create-product) + shared `fetchReferencesForGroups`/`fetchSkills`/`fetchVideoTemplate`.
- `src/lib/auto-deploy/use-run-driver.ts` — sequential driver: skip-and-continue, cancel, retry-failed.
- `src/components/auto-deploy/{product-card,product-selector,config-form,run-progress}.tsx`.
- `src/app/auto-deploy/{page,auto-deploy-client}.tsx`.
- Edited: `src/components/products/bulk-image-tab.tsx` (shared render fn), `src/app/dashboard/dashboard-client.tsx` (admin button).

## Verification still needed (cannot run from here)
- A live end-to-end run on the VPS browser: pick products → config → "Triển khai tự động", confirm images/video render, AI content returns, Shopify product is created/updated with no duplicate assets.
- Confirm the offscreen video canvas actually records (Chrome rAF throttling) in the real deployed environment.

---



## Goal

A new in-app page **`/mcp`** that lets the user multi-select products, choose one shared render group + Shopify config, and press a single **"Run MCP"** button that, for each selected product, automatically:

1. Renders images for the chosen group(s).
2. Uploads them to Supabase storage.
3. Generates Shopify AI content ("Tạo nội dung AI").
4. Creates the live Shopify product ("Tạo sản phẩm Shopify").

> **No Playwright / headless browser / VPS upgrade.** The earlier headless-render-API idea is dropped. Rendering already runs in the user's browser today (BulkImageTab/deploy dialog), and the Shopify steps are already API routes. `/mcp` just **composes existing features into one automated loop** — so it runs in the user's browser like `/dashboard` and avoids the VPS RAM problem entirely. (Superseded plan kept at `docs/server-render-api-plan.md` for reference.)

## Settled decisions
- **Run mode:** sequential, one product fully finished before the next (safe for browser RAM + Shopify rate limits).
- **On failure:** skip & continue, report succeeded/failed at the end with retry.
- **Shopify output:** live product (`/api/shopify/create-product`).
- **Config scope:** one shared config (skill, version, wrap/wrapless, labels, collection) for the whole run.
- **Video:** supported by reusing existing logic; opt-in per run. When a video template is selected, the runner renders + uploads a video per product and passes `videoUrl` to create-product. Add only a **small inline hint** that video is very slow with many products. See "Video" note below.

### Video — honest cost (read before assuming "simple")
Video is **not** a free flat field like the other config. From `shopify-deploy-dialog.tsx:532` (`handleRenderVideo`) + `extractor-scene-manager.ts`:
- It uses **`MediaRecorder`** capturing the WebGL canvas in **real time** (`startStudioRecording`, `:586`) — a 10s clip takes ~10s+ of wall-clock **per product**, on top of image render. In a sequential batch this adds up.
- Chrome **throttles rAF for off-screen/hidden canvases**, so the recording canvas must be **mounted visibly** (`:573-580`) — the runner needs a visible canvas slot during the video step, unlike the image step.
- Output is **WebM** (`fix-webm-duration` applied); template comes from `GET /api/video-studio-templates`, config type `VideoStudioConfig`.
- Upload + `videoUrl` plumbing into create-product already exists (`uploadAssets` `:736`, `buildPayload` `:830`).

**Plan stance:** reuse the existing video logic as-is (same `startStudioRecording` + upload + `videoUrl` path the deploy dialog uses). No special batch handling. The only addition is a **small inline hint** shown when the user selects the video tab/option: e.g. _"Video sẽ rất chậm nếu chọn nhiều sản phẩm"_ ("Video will be very slow with many products selected"). Default the run to images; video is opt-in via its tab/toggle.

## Key finding — almost everything already exists

`/mcp` is mostly **composition + a loop**, not new logic. The single-product version of this exact pipeline already lives in `src/components/editor/shopify-deploy-dialog.tsx`:
- `renderRefForProduct` (render group → `RenderedImage[]`) — also in `bulk-image-tab.tsx`
- `handleGenerateContent` (`shopify-deploy-dialog.tsx:633`) → `POST /api/shopify/generate-content` (SSE), sets title/description/tags (`:710`)
- `uploadAssets` (`:736`) → uploads blobs to Supabase, returns `imageUrls`
- `buildPayload(imageUrls, videoUrl)` (`:830`) → builds `ShopifyDeployRequest`; `imageNames` from `renderedImages.map(ri => ri.refName)` (`:841`)
- `handleDeploy` (`:878`) → `POST /api/shopify/create-product`

So `/mcp` = **multi-product selector + shared-config form + a runner that executes that pipeline per product.**

## Reuse map

| `/mcp` need | Existing code | Action |
|---|---|---|
| Load all products | `GET /api/products` → `{ items, total }` (`api/products/route.ts:11`) | reuse |
| Code parse `nXX-XX` | `parseProductTitle()` (`lib/shopify/parse-title.ts:20`) → `{ code: "n06-02" }` | reuse; group key = `code.slice(0,3)` = `nXX` |
| Product cards | `product-card.tsx`, selection in `products-grid.tsx` (`selectedIds: Set`) | reuse card; new persisted-select container |
| Render a group for a product | `renderRefForProduct` (`bulk-image-tab.tsx:33`) | extract to shared module, reuse |
| Group picker | popover in `bulk-image-tab.tsx:317`, groups via `GET /api/extractor-reference-groups` | reuse |
| Shopify config inputs (skill/version/wrap/labels/collection) | `shopify-deploy-dialog.tsx` form + `GET /api/shopify/skills`, `/collections` | extract config form into shared component |
| AI content | `POST /api/shopify/generate-content` (SSE) | call from runner |
| Create product | `POST /api/shopify/create-product` (`ShopifyDeployRequest`) | call from runner |
| Upload images | `/api/upload` + `resolveStorageUrl` | reuse |

## Data shapes (no `any`)

```ts
// Group products by nXX prefix
interface ProductGroup { prefix: string; products: Product[]; }   // prefix = "n06"

// Shared run config (one set for the whole batch)
interface McpRunConfig {
  groupIds: string[];                 // extractor reference groups to render
  skillIds: string[];
  versions: Array<"Standard" | "Premium" | "Pro">;
  wrapType: "wrap" | "wrapless";
  laserShaft: boolean;
  collections: string;                // comma-separated
  breadcrumbCollection?: string | null;
  aiModel?: string;
  manualTags?: string[];
  videoTemplateId?: string | null;    // when set → render+upload a video per product (optional)
}

type McpStep = "render" | "video" | "upload" | "content" | "deploy";
type McpItemStatus = "pending" | "running" | "done" | "failed";
interface McpRunItem {
  product: Product;
  status: McpItemStatus;
  step?: McpStep;                     // current step when running
  error?: string;
  adminUrl?: string;                  // create-product result
}
```

## Page structure — `/mcp`

A multi-step single page (mirrors `/dashboard` styling; uses existing card + checkbox + popover components).

**Section 1 — Product selection (NEW)**
- Fetch all products (paginated until complete, or a `?all=1` mode on `/api/products`).
- Group by `nXX` prefix via `parseProductTitle`. Products without a valid code → an "Other/Uncategorized" tab.
- Render a **tab button per `nXX`** (manual button tabs like `bulk-export-dialog.tsx:34`, all tabs stay mounted).
- Each tab: product cards (reuse `product-card.tsx`) with checkboxes; **Choose all / Unchoose all** scoped to the current tab.
- **Search input** filtering across all products; its own Choose all / Unchoose all over the filtered set.
- **Selection persists** across tab switches and searches: one top-level `selectedIds: Set<string>` (lifted state, never reset on tab/search change). Choose-all only adds the currently-visible subset; Unchoose-all only removes the visible subset — so other tabs' picks survive.
- Selected count + "Next: Chọn group để render" button.

**Section 2 — Shared config (reuse `/dashboard` UI)**
- "Chọn group để render": group picker (reuse bulk popover).
- Shopify config form extracted from `shopify-deploy-dialog.tsx`: skill checkboxes, versions, wrap/wrapless, labels (customText), collection picker. One shared `McpRunConfig`.
- Product cards/preview same as dashboard for familiarity.

**Section 3 — Run**
- Single **"Run MCP"** button (disabled until ≥1 product + valid config: ≥1 group, ≥1 version, wrapType set).
- Per-product progress list (reuse `bulk-image-tab.tsx` status-row UI) showing current step + final result/admin URL.
- End-of-run summary: succeeded / failed, with **Retry failed**.

## The runner (sequential pipeline, browser-side)

Extract a shared module `src/lib/mcp/run-pipeline.ts` so logic is testable and not buried in the page:

```ts
async function runForProduct(product, config, sceneCtx): Promise<McpRunItem> {
  // 1. render: for each group → renderRefForProduct(model, ref, product.surface_url) → RenderedImage[]
  // 1b. video (only if config.videoTemplateId): startStudioRecording(config) → WebM blob
  //     (needs a visible canvas slot — see Video note)
  // 2. upload: uploadAssets(renderedImages, videoBlob?) → { imageUrls, videoUrl? } (Supabase)
  // 3. content: POST /api/shopify/generate-content (SSE) with imageUrl=first, hint=parseProductTitle(name).theme,
  //             versions, skillPrompt (joined from selected skills) → { title, description, tags }
  // 4. deploy: POST /api/shopify/create-product with buildPayload-equivalent:
  //            productCode = parseProductTitle(name).code, title, description, imageUrls, videoUrl,
  //            imageNames = renderedImages.map(refName), versions, wrapType, collections, ...
}
```

Driver loop: `for (const p of selectedProducts) { try { await runForProduct(...) } catch { mark failed; continue } }` — sequential; **skip & continue**; update progress per step.

**Scene reuse:** create one `SceneManager` per product (load model + applySurface + product config exactly as `bulk-image-tab.tsx:230-265`), dispose after that product's render — same teardown pattern, keeps one WebGL context at a time.

## Refactors needed (keep existing UIs working)

1. **Extract `renderRefForProduct` + per-product scene setup** out of `bulk-image-tab.tsx` into `src/lib/mcp/render-product.ts` (shared by bulk tab and `/mcp`). Bulk tab imports it — **no behavior change** (verify bulk export still works).
2. **Extract the Shopify config form** (skill/version/wrap/labels/collection) from `shopify-deploy-dialog.tsx` into a reusable `<ShopifyConfigForm value onChange />` so both the dialog and `/mcp` use it. (Optional but reduces duplication; can defer.)
3. **Extract the content+deploy pipeline** logic from the dialog's `handleGenerateContent` + `handleDeploy` into `src/lib/mcp/run-pipeline.ts` callable without the dialog UI.

## Implementation order (phased, each testable)

1. **Shared render module** — extract `renderRefForProduct` + scene setup; repoint `bulk-image-tab.tsx`; confirm bulk export unchanged. (No new UI.)
2. **`/mcp` page scaffold + product selector** — tabs by `nXX`, search, persisted multi-select, choose/unchoose all. Verify selection persists across tabs/search.
3. **Shared config section** — group picker + Shopify config form; assemble `McpRunConfig`.
4. **Runner pipeline** (`run-pipeline.ts`) — wire render → upload → content → deploy for ONE product end to end (images only); test on a single selected product.
5. **Sequential driver + progress UI** — loop all selected, skip-and-continue, summary + retry failed.
6. **Video step (opt-in)** — add the `video` step reusing existing `startStudioRecording` + visible-canvas mount + `videoUrl` upload, plus the small "very slow with many products" hint on the video tab.
7. **Hardening** — role guard (create-product needs admin/mode), Shopify rate-limit spacing between products, cancel button, clear error surfacing.

## Shopify deploy — same logic as original (verified)
The MCP runner calls the **same `POST /api/shopify/create-product`** the deploy dialog uses, so the create-vs-update and asset-dedup behavior is identical and handled server-side — MCP needs no special branching:
- `create-product/route.ts:151` looks up an existing `shopify_deployments` row by `product_id`; if a live `shopify_product_id` exists → `updateShopifyProductInPlace` (keeps the same Shopify id + order history), else `createShopifyProduct`.
- `updateShopifyProductInPlace` reconciles assets so they are **not duplicated**: images diffed by URL, variants matched by SKU, video old-deleted then re-added (`:147-150`).
- **Decision:** MCP treats already-deployed and new products **identically** — update in place, no skipping. (Confirmed.)

## Permissions / constraints
- `create-product` requires **admin or mode** role (`create-product/route.ts:26`). `/mcp` should be gated the same way.
- Product code must match `nXX-YY`; products without it can be selected for render but **cannot deploy** — surface this (e.g. badge "no code → render only" or exclude from deploy step).
- One shared config means all products in a run get the same versions/wrap/collection/skill — by design.

## Resolved
- **No-code products:** **shown but not selectable** — displayed greyed-out with a "no code" badge so users see them but can't add them to a run (every selectable product can complete the full pipeline). Implement by computing `parseProductTitle(name).code` per card; if null → render card disabled + badge, exclude its id from any choose-all.
- **Video:** supported, reuse existing logic, small slowness hint (above).
- **Shopify output:** live (chosen). Draft toggle can be a later follow-up; not in scope now.

## Files (summary)
- **New:** `src/app/mcp/page.tsx` (+ client), `src/components/mcp/product-selector.tsx`, `src/components/mcp/run-progress.tsx`, `src/lib/mcp/render-product.ts`, `src/lib/mcp/run-pipeline.ts`, optional `src/components/shopify/shopify-config-form.tsx`.
- **Edit:** `src/components/products/bulk-image-tab.tsx` (use shared render module), maybe `shopify-deploy-dialog.tsx` (use shared config form / pipeline).
- **Reused unchanged:** `/api/products`, `/api/extractor-reference-groups`, `/api/extractor-references/[id]`, `/api/shopify/{skills,collections,generate-content,create-product}`, `/api/upload`, `parse-title.ts`, `form-data.ts`, `product-card.tsx`.
