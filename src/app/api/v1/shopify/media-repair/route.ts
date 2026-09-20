import { NextResponse } from "next/server";
import { createAdminServiceClient } from "@/lib/supabase/server";
import { requireApiToken } from "@/lib/api-tokens/auth";
import { errorResponse } from "@/lib/render/enqueue";
import { RenderPayloadError } from "@/lib/render/build-payload";
import { withStore } from "@/lib/shopify/store-context";
import { getStore } from "@/lib/shopify/stores";
import {
  addProductImage,
  createFileFromImageUrl,
  getProductImages,
  getProductMetafields,
  setProductMetafield,
} from "@/lib/shopify/client";
import { isMediaMetafieldKey, referenceNameForMetafieldKey } from "@/lib/shopify/media-audit";
import type {
  ApiMediaRepairRequest,
  ApiMediaRepairResponse,
  ApiMediaRepairResult,
} from "@/types/api-token";
import {
  resolveDeployedProduct,
  type DeployedProductRow,
} from "@/lib/shopify/resolve-deployed-product";
import type { ShopifyFormData } from "@/types/product";

/**
 * POST /api/v1/shopify/media-repair — put a missing image back on a live product.
 *
 * The write half of the audit. An agent that has read
 * POST /api/v1/shopify/media-audit, rendered the missing slot with
 * POST /api/v1/renders and collected the file URL from
 * GET /api/v1/renders/{jobId} comes here to close the loop — without a person
 * opening the deploy dialog and re-deploying a live product to fix one image.
 *
 *   {"product": "n05-26-skull",
 *    "media": [{"key": "custom.package_box", "url": "https://…/Package-2.png"}]}
 *
 * FILLS GAPS ONLY. A key that already has a working value is skipped and
 * reported as `skipped`, never overwritten — this route runs unattended against
 * products that are live and selling, and the failure mode of a too-eager
 * repair (replacing a good image with a re-render) is far worse than the
 * failure mode of a too-cautious one (a `skipped` line an agent can read). A
 * metafield whose file reference is BROKEN does get rewritten: there is nothing
 * there to protect.
 *
 * Repair is deliberately narrow — it writes image metafields, the slots that go
 * missing silently. It does not reorder the gallery or touch variants, prices,
 * title or description; those belong to a deploy, which has a UI and a person
 * behind it.
 */

/** Ceiling per request: each key costs a file upload plus a metafield write. */
const MAX_MEDIA_PER_REQUEST = 20;

interface DeploymentRow {
  product_id: string;
  store_id: string | null;
  shopify_product_id: number | null;
  title: string | null;
  shopify_handle: string | null;
  admin_url: string | null;
  form_data: ShopifyFormData | null;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;

    const body = (await request.json().catch(() => ({}))) as ApiMediaRepairRequest;
    const storeId = getStore(body.store)?.id ?? "main";

    const media = (body.media ?? []).filter(
      (item) => item && typeof item.key === "string" && typeof item.url === "string"
    );
    if (media.length === 0) {
      throw new RenderPayloadError(
        '`media` là bắt buộc: [{"key": "custom.package_box", "url": "https://…"}]',
        400
      );
    }
    if (media.length > MAX_MEDIA_PER_REQUEST) {
      throw new RenderPayloadError(
        `Tối đa ${MAX_MEDIA_PER_REQUEST} ảnh mỗi request (nhận ${media.length}).`,
        400
      );
    }

    for (const item of media) {
      if (!/^https?:\/\//i.test(item.url)) {
        throw new RenderPayloadError(
          `URL không hợp lệ cho \`${item.key}\`: phải là http(s) công khai để Shopify tải về được.`,
          400
        );
      }
      if (!isMediaMetafieldKey(item.key)) {
        throw new RenderPayloadError(
          `\`${item.key}\` không phải metafield ảnh. Chỉ nhận custom.details_N[_version], ` +
            "custom.package_product_standard, custom.package_product_pro, custom.package_box.",
          400
        );
      }
    }

    const db = createAdminServiceClient();
    const deployment = await resolveDeployment(
      db,
      body.product,
      auth.ctx.userId,
      auth.ctx.canActOnAnyProduct,
      storeId
    );

    const shopifyProductId = deployment.shopify_product_id;
    if (!shopifyProductId) {
      throw new RenderPayloadError(
        `Sản phẩm chưa được deploy lên store "${storeId}", không có gì để sửa.`,
        409
      );
    }

    // Alt text for the uploaded file. The deployment title is the human-facing
    // name; the product id is a last resort so the upload never carries "undefined".
    const title = deployment.title ?? body.product?.trim() ?? deployment.product_id;

    const results = await withStore(storeId, async () => {
      // Read current state ONCE: what is already set decides skip vs write.
      const existing = await getProductMetafields(shopifyProductId);
      const byKey = new Map(existing.map((record) => [record.qualifiedKey, record]));

      const applied: ApiMediaRepairResult[] = [];

      for (const item of media) {
        const current = byKey.get(item.key);
        const isBroken = Boolean(current?.value) && current?.type === "file_reference" && !current?.url;

        if (current?.value && !isBroken && body.overwrite !== true) {
          applied.push({
            key: item.key,
            status: "skipped",
            detail: "Đã có ảnh — repair chỉ điền chỗ trống. Gửi overwrite: true nếu thực sự muốn thay.",
          });
          continue;
        }

        try {
          const fileGid = await uploadAndSetMetafield({
            shopifyProductId,
            key: item.key,
            url: item.url,
            title,
          });
          applied.push({
            key: item.key,
            status: isBroken ? "replaced" : "filled",
            detail: isBroken ? "Metafield cũ trỏ vào file đã mất — đã ghi đè." : null,
            file_gid: fileGid,
            reference_name: referenceNameForMetafieldKey(item.key),
          });
        } catch (error) {
          applied.push({
            key: item.key,
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return applied;
    });

    const failed = results.filter((r) => r.status === "failed").length;

    return NextResponse.json(
      {
        product_id: deployment.product_id,
        shopify_product_id: shopifyProductId,
        store: storeId,
        admin_url: deployment.admin_url,
        filled: results.filter((r) => r.status === "filled").length,
        replaced: results.filter((r) => r.status === "replaced").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed,
        results,
        note:
          failed > 0
            ? "Một số ảnh không ghi được — xem `detail`. Chạy lại media-audit để xác nhận kết quả."
            : "Chạy lại POST /api/v1/shopify/media-audit để xác nhận sản phẩm đã đủ ảnh.",
      } satisfies ApiMediaRepairResponse,
      { status: failed > 0 && failed === results.length ? 502 : 200 }
    );
  } catch (error) {
    return errorResponse(error, "POST /api/v1/shopify/media-repair");
  }
}

/**
 * Upload the image to Shopify Files and point the metafield at it.
 *
 * Mirrors what the deploy path does (post-create.ts), including the fallback:
 * `fileCreate` is the clean route because the resulting File is independent of
 * the product's gallery, but it can fail or return a file that is still
 * processing. When it does, the image is added to the gallery to obtain a media
 * GID which becomes the metafield value. That gallery copy is then KEPT: the
 * metafield points at it, so deleting it would leave the metafield referencing
 * nothing — the very bug this endpoint exists to fix. post-create.ts makes the
 * same distinction (it only deletes the temporary image when fileCreate gave it
 * an independent File).
 */
async function uploadAndSetMetafield(input: {
  shopifyProductId: number;
  key: string;
  url: string;
  title: string;
}): Promise<string> {
  const { shopifyProductId, key, url, title } = input;
  const metafieldKey = key.startsWith("custom.") ? key.slice("custom.".length) : key;

  let fileGid: string | null = null;
  try {
    fileGid = await createFileFromImageUrl(url, title);
  } catch (error) {
    console.warn(
      `[media-repair] fileCreate ${key}:`,
      error instanceof Error ? error.message : error
    );
  }

  if (fileGid) {
    await setProductMetafield(shopifyProductId, {
      namespace: "custom",
      key: metafieldKey,
      type: "file_reference",
      value: fileGid,
    });
    return fileGid;
  }

  // Fallback: park the image in the gallery to mint a media GID.
  const images = await getProductImages(shopifyProductId);
  const added = await addProductImage(shopifyProductId, {
    src: url,
    alt: `${title} — ${key}`,
    position: images.length + 1,
  });

  const mediaGid = `gid://shopify/MediaImage/${added.id}`;
  await setProductMetafield(shopifyProductId, {
    namespace: "custom",
    key: metafieldKey,
    type: "file_reference",
    value: mediaGid,
  });

  // The metafield now depends on this media, so the gallery copy stays. It is
  // hidden from the storefront gallery by the theme's own naming rules, and
  // removing it would break the metafield we just wrote.
  return mediaGid;
}

/** Find the deployment row, scoped to what this token may act on. */
async function resolveDeployment(
  db: ReturnType<typeof createAdminServiceClient>,
  product: string | undefined,
  userId: string,
  canActOnAnyProduct: boolean,
  storeId: string
): Promise<DeploymentRow> {
  const wanted = product?.trim();
  if (!wanted) {
    throw new RenderPayloadError("`product` là bắt buộc (tên sản phẩm hoặc id).", 400);
  }

  let productQuery = db.from("products").select("id, name");
  if (!canActOnAnyProduct) productQuery = productQuery.eq("user_id", userId);
  const { data: productRows, error: productError } = await productQuery;
  if (productError) {
    throw new RenderPayloadError(`Failed to load products: ${productError.message}`, 500);
  }

  const products = (productRows ?? []) as Array<{ id: string; name: string | null }>;
  if (products.length === 0) {
    throw new RenderPayloadError(`Product not found: ${wanted}`, 404);
  }
  const nameById = new Map(products.map((row) => [row.id, row.name]));

  // Every deployment on this store the caller may touch. Loaded before the
  // identifier is resolved so the Shopify TITLE can be matched — that is what
  // an operator copies off the storefront, and it lives here, not on `products`.
  const { data: rows, error } = await db
    .from("shopify_deployments")
    .select("product_id, store_id, shopify_product_id, title, shopify_handle, admin_url, form_data")
    .eq("store_id", storeId)
    .in(
      "product_id",
      products.map((row) => row.id)
    );

  if (error) {
    throw new RenderPayloadError(`Failed to load deployment: ${error.message}`, 500);
  }

  const deployments = (rows ?? []) as DeploymentRow[];
  if (deployments.length === 0) {
    throw new RenderPayloadError(
      `Chưa có sản phẩm nào của token này được deploy lên store "${storeId}".`,
      404
    );
  }

  const lookupRows: DeployedProductRow[] = deployments.map((row) => ({
    productId: row.product_id,
    productName: nameById.get(row.product_id) ?? null,
    title: row.title,
    shopifyHandle: row.shopify_handle,
    shopifyProductId: row.shopify_product_id,
  }));

  const result = resolveDeployedProduct(wanted, lookupRows);

  if (!result.ok && result.reason === "ambiguous") {
    // Refused rather than guessed: this route WRITES to a live product, and
    // duplicate titles exist in the catalogue.
    const list = result.candidates
      .map((c) => `${c.productName ?? "(không tên)"} — "${c.title ?? ""}"`)
      .join(" | ");
    throw new RenderPayloadError(
      `"${wanted}" khớp ${result.candidates.length} sản phẩm: ${list}. ` +
        "Gửi `product` là mã sản phẩm (vd \"n05-26-Skull\") hoặc product_id để chỉ đích danh.",
      409
    );
  }
  if (!result.ok) {
    throw new RenderPayloadError(
      `Product not found: ${wanted}. Nhận: mã sản phẩm (n05-26-Skull), product_id, ` +
        "tiêu đề trên Shopify, handle, shopify_product_id, hoặc link sản phẩm.",
      404
    );
  }

  const deployment = deployments.find((row) => row.product_id === result.match.productId);
  if (!deployment) {
    throw new RenderPayloadError(
      `Sản phẩm "${wanted}" chưa được deploy lên store "${storeId}".`,
      404
    );
  }

  return deployment;
}
