import { NextResponse } from "next/server";
import { createAdminServiceClient } from "@/lib/supabase/server";
import { asRenderDbClient } from "@/lib/render/supabase-surface";
import { requireApiToken } from "@/lib/api-tokens/auth";
import { loadRenderCatalog } from "@/lib/api-tokens/render-catalog";
import { errorResponse } from "@/lib/render/enqueue";
import { RenderPayloadError } from "@/lib/render/build-payload";
import { withStore } from "@/lib/shopify/store-context";
import { getStore } from "@/lib/shopify/stores";
import { getProductImages, getProductMetafields } from "@/lib/shopify/client";
import {
  expectedMediaFromReferenceNames,
  findMissingMedia,
  inferCohortStandard,
  isMediaMetafieldKey,
  versionRuleExpectations,
  type CohortMember,
  type ExpectedMedia,
  type MissingMedia,
} from "@/lib/shopify/media-audit";
import type {
  ApiMediaAuditRequest,
  ApiMediaAuditResponse,
  ApiMediaAuditResult,
} from "@/types/api-token";
import {
  resolveDeployedProduct,
  type DeployedProductRow,
} from "@/lib/shopify/resolve-deployed-product";
import type { ShopifyFormData } from "@/types/product";

/**
 * POST /api/v1/shopify/media-audit — find deployed products missing media.
 *
 * The question an operator actually asks is "sản phẩm này thiếu ảnh nào?", and
 * until now nothing could answer it: the deploy path writes image metafields
 * best-effort and only `console.warn`s when one fails, so a product can go live
 * short an image with no trace anywhere. This route is the missing read side.
 *
 * Two shapes, one endpoint, because they are the same comparison at different
 * widths:
 *
 *   {"product": "n05-26-skull"}   → audit one product, in detail
 *   {"limit": 1000}               → sweep every deployed product, grouped by
 *                                   image group, and report the ones that are
 *                                   short of what their group's peers carry
 *
 * The sweep is the interesting one. It does not need any declaration of "what a
 * complete product looks like" — there isn't one, and stores differ. It derives
 * the standard per group: from the names that deploy actually sent
 * (`form_data.imageNames`), from the group's current references, and failing
 * both, from what the group's other products carry (see media-audit.ts). That
 * is what turns "1000 sản phẩm" into "9 sản phẩm thiếu custom.package_box".
 *
 * Read-only. Every finding carries the `reference_name` that renders it, so the
 * agent's next two calls — POST /api/v1/renders, then
 * POST /api/v1/shopify/media-repair — need nothing this response did not give
 * it.
 */

/**
 * Ceiling on a sweep.
 *
 * Each product costs 2 Shopify calls, so a full 1000-product sweep is ~2000
 * calls — several minutes at Shopify's REST bucket refill rate. That is the
 * right trade for a catalogue-wide audit run occasionally, but it means a
 * caller should expect to wait rather than assume the request hung.
 */
const MAX_SWEEP_PRODUCTS = 1000;
const DEFAULT_SWEEP_LIMIT = 50;

/** How many products are read from Shopify at once. Shopify's REST bucket refills at 2/s. */
const SHOPIFY_CONCURRENCY = 4;

interface DeploymentRow {
  product_id: string;
  store_id: string | null;
  shopify_product_id: number | null;
  title: string | null;
  shopify_handle: string | null;
  admin_url: string | null;
  image_group_id: string | null;
  form_data: ShopifyFormData | null;
}

interface DraftRow {
  product_id: string;
  form_data: ShopifyFormData | null;
}

/** One product's rows, with the pieces the audit needs already joined. */
interface AuditTarget {
  deployment: DeploymentRow;
  productName: string | null;
  formData: ShopifyFormData | null;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;

    const body = (await request.json().catch(() => ({}))) as ApiMediaAuditRequest;
    const storeId = getStore(body.store)?.id ?? "main";
    const db = createAdminServiceClient();

    const targets = await resolveTargets(db, body, auth.ctx.userId, auth.ctx.canActOnAnyProduct, storeId);

    if (targets.length === 0) {
      return NextResponse.json({
        store: storeId,
        audited: 0,
        products_with_issues: 0,
        results: [],
        note:
          "Không tìm thấy sản phẩm đã deploy nào khớp. Kiểm tra `product` (tên hoặc id) " +
          "và `store` — một sản phẩm chỉ được audit khi nó đã có shopify_product_id trên store đó.",
      } satisfies ApiMediaAuditResponse);
    }

    // Group reference names, resolved once and shared by every target: even a
    // 1000-product sweep typically spans a handful of groups.
    const catalog = await loadRenderCatalog(asRenderDbClient(db));
    const referenceNameById = new Map(catalog.references.map((r) => [r.id, r.name]));
    const groupById = new Map(catalog.groups.map((g) => [g.id, g]));

    // ── Pass 1: read every product's live state from Shopify ──
    const states = await withStore(storeId, () => readShopifyStates(targets));

    // ── Pass 2: build each product's expectation and diff it ──
    const cohorts = buildCohorts(targets, states);
    const results: ApiMediaAuditResult[] = [];

    for (const target of targets) {
      const shopifyProductId = target.deployment.shopify_product_id;
      if (!shopifyProductId) continue;
      const state = states.get(shopifyProductId);
      if (!state) continue;

      const versions = target.formData?.versions ?? [];
      const groupId = target.deployment.image_group_id ?? target.formData?.imageGroupId ?? null;
      const group = groupId ? groupById.get(groupId) : undefined;

      const expected = buildExpectation({
        formData: target.formData,
        groupReferenceNames: group
          ? group.referenceIds.map((id) => referenceNameById.get(id)).filter((n): n is string => Boolean(n))
          : [],
        versions,
        cohortStandard: groupId ? (cohorts.get(groupId) ?? []) : [],
        presentKeys: new Set(
          state.metafields.filter((m) => m.value).map((m) => m.qualifiedKey)
        ),
      });

      const missing = findMissingMedia(expected, state);

      results.push({
        product_id: target.deployment.product_id,
        product_name: target.productName,
        shopify_product_id: shopifyProductId,
        title: target.deployment.title,
        admin_url: target.deployment.admin_url,
        store: target.deployment.store_id ?? storeId,
        image_group_id: groupId,
        image_group_name: group?.name ?? null,
        versions,
        expected_count: expected.length,
        missing: missing.map((item) => ({
          key: item.key,
          kind: item.kind,
          reason: item.reason,
          reference_name: item.referenceName,
          source: item.source,
          confidence: item.confidence,
        })),
      });
    }

    // Worst first: an operator scanning the response wants the broken ones at
    // the top, not wherever the database happened to return them.
    results.sort((a, b) => b.missing.length - a.missing.length);

    const withIssues = results.filter((r) => r.missing.length > 0);

    return NextResponse.json({
      store: storeId,
      audited: results.length,
      products_with_issues: withIssues.length,
      results: body.only_issues === false ? results : withIssues,
      usage: {
        next_steps: [
          "1. Render ảnh thiếu: POST /api/v1/renders với {\"product\": \"<tên sản phẩm>\", \"references\": [\"<reference_name>\"]}",
          "2. Lấy link file khi xong: GET /api/v1/renders/<job_id>",
          "3. Up bù lên Shopify: POST /api/v1/shopify/media-repair với {\"product\": \"…\", \"media\": [{\"key\": \"<key>\", \"url\": \"<link>\"}]}",
        ],
        note:
          "`source` cho biết mức tin cậy: deploy = chắc chắn (tên ảnh lần deploy đó), " +
          "group = suy từ nhóm ảnh hiện tại, cohort = suy từ các sản phẩm cùng nhóm " +
          "(xem `confidence`). Nên xác nhận với người dùng trước khi sửa hàng loạt theo `cohort`.",
      },
    } satisfies ApiMediaAuditResponse);
  } catch (error) {
    return errorResponse(error, "POST /api/v1/shopify/media-audit");
  }
}

/**
 * Resolve which deployments to audit.
 *
 * Scoped to the token owner by hand — this runs on the service key, so nothing
 * else is checking. An admin's token sweeps every product, matching the reach
 * that person already has in the dashboard.
 */
async function resolveTargets(
  db: ReturnType<typeof createAdminServiceClient>,
  body: ApiMediaAuditRequest,
  userId: string,
  canActOnAnyProduct: boolean,
  storeId: string
): Promise<AuditTarget[]> {
  const wanted = [body.product, ...(body.products ?? [])].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );

  // Which products may this token see at all?
  let productQuery = db.from("products").select("id, name");
  if (!canActOnAnyProduct) productQuery = productQuery.eq("user_id", userId);
  const { data: productRows, error: productError } = await productQuery;
  if (productError) {
    throw new RenderPayloadError(`Failed to load products: ${productError.message}`, 500);
  }

  const products = (productRows ?? []) as Array<{ id: string; name: string | null }>;
  const nameById = new Map(products.map((row) => [row.id, row.name]));
  if (products.length === 0) return [];

  // Deployments are loaded BEFORE the identifier is resolved, because the
  // Shopify title lives here and not on `products` — and the title is what an
  // operator can actually copy off the storefront. Resolving first would mean
  // only ids and internal names ever worked.
  //
  // Only rows that actually reached Shopify: a draft row (shopify_product_id
  // null) has nothing to audit, and reporting it as "missing everything" would
  // bury the real findings.
  let deploymentQuery = db
    .from("shopify_deployments")
    .select(
      "product_id, store_id, shopify_product_id, title, shopify_handle, admin_url, image_group_id, form_data"
    )
    .eq("store_id", storeId)
    .not("shopify_product_id", "is", null)
    .in(
      "product_id",
      products.map((row) => row.id)
    )
    .order("created_at", { ascending: false });

  if (body.image_group) {
    const groupId = body.image_group.trim();
    if (/^[0-9a-f-]{36}$/i.test(groupId)) deploymentQuery = deploymentQuery.eq("image_group_id", groupId);
  }

  const { data: deploymentRows, error: deploymentError } = await deploymentQuery;
  if (deploymentError) {
    throw new RenderPayloadError(`Failed to load deployments: ${deploymentError.message}`, 500);
  }

  let deployments = (deploymentRows ?? []) as DeploymentRow[];
  if (deployments.length === 0) return [];

  if (wanted.length > 0) {
    const lookupRows: DeployedProductRow[] = deployments.map((row) => ({
      productId: row.product_id,
      productName: nameById.get(row.product_id) ?? null,
      title: row.title,
      shopifyHandle: row.shopify_handle,
      shopifyProductId: row.shopify_product_id,
    }));

    const resolvedIds = new Set<string>();
    for (const value of wanted) {
      const result = resolveDeployedProduct(value, lookupRows);
      if (result.ok) {
        resolvedIds.add(result.match.productId);
        continue;
      }
      if (result.reason === "ambiguous") {
        // Never pick one: these endpoints write to a live product, and nine
        // titles are genuinely duplicated across the catalogue.
        const list = result.candidates
          .map((c) => `${c.productName ?? "(không tên)"} — "${c.title ?? ""}"`)
          .join(" | ");
        throw new RenderPayloadError(
          `"${value}" khớp ${result.candidates.length} sản phẩm: ${list}. ` +
            "Gửi `product` là mã sản phẩm (vd \"n05-26-Skull\") hoặc product_id để chỉ đích danh.",
          409
        );
      }
      throw new RenderPayloadError(
        `Product not found: ${value}. Nhận: mã sản phẩm (n05-26-Skull), product_id, ` +
          "tiêu đề trên Shopify, handle, shopify_product_id, hoặc link sản phẩm.",
        404
      );
    }

    deployments = deployments.filter((row) => resolvedIds.has(row.product_id));
    if (deployments.length === 0) return [];
  } else {
    const limit = Math.min(Math.max(1, body.limit ?? DEFAULT_SWEEP_LIMIT), MAX_SWEEP_PRODUCTS);
    deployments = deployments.slice(0, limit);
  }

  // The shared draft holds the authoritative form_data for most products; the
  // deployment row's own copy is the fallback for older/store2 rows.
  const { data: draftRows } = await db
    .from("shopify_drafts")
    .select("product_id, form_data")
    .in(
      "product_id",
      deployments.map((row) => row.product_id)
    );
  const draftByProduct = new Map(
    ((draftRows ?? []) as DraftRow[]).map((row) => [row.product_id, row.form_data])
  );

  return deployments.map((deployment) => ({
    deployment,
    productName: nameById.get(deployment.product_id) ?? null,
    formData: draftByProduct.get(deployment.product_id) ?? deployment.form_data ?? null,
  }));
}

/** Read each product's metafields + gallery from Shopify, bounded concurrency. */
async function readShopifyStates(
  targets: AuditTarget[]
): Promise<Map<number, { metafields: Awaited<ReturnType<typeof getProductMetafields>>; galleryImageAlts: string[] }>> {
  const states = new Map<
    number,
    { metafields: Awaited<ReturnType<typeof getProductMetafields>>; galleryImageAlts: string[] }
  >();

  const ids = targets
    .map((target) => target.deployment.shopify_product_id)
    .filter((id): id is number => typeof id === "number");

  for (let i = 0; i < ids.length; i += SHOPIFY_CONCURRENCY) {
    const slice = ids.slice(i, i + SHOPIFY_CONCURRENCY);
    await Promise.all(
      slice.map(async (shopifyProductId) => {
        try {
          const [metafields, images] = await Promise.all([
            getProductMetafields(shopifyProductId),
            getProductImages(shopifyProductId),
          ]);
          states.set(shopifyProductId, {
            metafields,
            galleryImageAlts: images.map((image) => (image as { alt?: string }).alt ?? "").filter(Boolean),
          });
        } catch (error) {
          // One unreadable product must not fail a 200-product sweep; it is
          // simply left out of the results rather than reported as empty,
          // which would read as "missing everything".
          console.warn(
            `[media-audit] read ${shopifyProductId}:`,
            error instanceof Error ? error.message : error
          );
        }
      })
    );
  }

  return states;
}

/**
 * Build the per-group cohort standard from what the audited products carry.
 *
 * Uses only media keys — `custom.shaft_config` being universal says nothing
 * about images, and listing it as "missing media" would send an agent off to
 * render a config file.
 */
function buildCohorts(
  targets: AuditTarget[],
  states: Map<number, { metafields: Awaited<ReturnType<typeof getProductMetafields>>; galleryImageAlts: string[] }>
): Map<string, ExpectedMedia[]> {
  const membersByGroup = new Map<string, CohortMember[]>();

  for (const target of targets) {
    const groupId = target.deployment.image_group_id ?? target.formData?.imageGroupId ?? null;
    if (!groupId) continue;
    const shopifyProductId = target.deployment.shopify_product_id;
    if (!shopifyProductId) continue;
    const state = states.get(shopifyProductId);
    if (!state) continue;

    const presentKeys = new Set(
      state.metafields
        .filter((record) => record.value && isMediaMetafieldKey(record.qualifiedKey))
        .map((record) => record.qualifiedKey)
    );

    const list = membersByGroup.get(groupId) ?? [];
    list.push({ productId: target.deployment.product_id, presentKeys });
    membersByGroup.set(groupId, list);
  }

  const standards = new Map<string, ExpectedMedia[]>();
  for (const [groupId, members] of membersByGroup) {
    standards.set(groupId, inferCohortStandard(members));
  }
  return standards;
}

/**
 * Merge the three expectation sources, strongest first.
 *
 * A key claimed by more than one source keeps the strongest claim: `deploy`
 * states what was actually sent, so it must not be downgraded to a cohort
 * guess for the same key.
 */
function buildExpectation(input: {
  formData: ShopifyFormData | null;
  groupReferenceNames: string[];
  versions: string[];
  cohortStandard: ExpectedMedia[];
  presentKeys: Set<string>;
}): ExpectedMedia[] {
  const { formData, groupReferenceNames, versions, cohortStandard, presentKeys } = input;
  const byKey = new Map<string, ExpectedMedia>();

  // First: what the storefront needs for the versions this product sells NOW.
  // Ahead of the others because it is the only source that survives a version
  // change after deploy — the case where every name-derived source still
  // describes the product as it used to be.
  for (const item of versionRuleExpectations(versions, presentKeys)) {
    byKey.set(item.key, item);
  }

  const deployNames = (formData?.imageNames ?? []).filter(Boolean);
  if (deployNames.length > 0) {
    for (const item of expectedMediaFromReferenceNames(deployNames, versions, "deploy")) {
      byKey.set(item.key, item);
    }
  }

  if (groupReferenceNames.length > 0) {
    for (const item of expectedMediaFromReferenceNames(groupReferenceNames, versions, "group")) {
      if (!byKey.has(item.key)) byKey.set(item.key, item);
    }
  }

  for (const item of cohortStandard) {
    if (!byKey.has(item.key)) byKey.set(item.key, item);
  }

  return [...byKey.values()];
}

export type { MissingMedia };
