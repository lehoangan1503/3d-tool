import { NextResponse } from "next/server";
import { createAdminServiceClient } from "@/lib/supabase/server";
import { asRenderStorageClient } from "@/lib/render/supabase-surface";
import type { RenderStorageClient } from "@/lib/render/supabase-surface";
import { requireApiToken } from "@/lib/api-tokens/auth";
import { resolveAppBaseUrl } from "@/lib/render/gpu-dispatch";
import {
  canActOn,
  errorResponse,
  findProduct,
  loadLiveDeployments,
} from "@/lib/api-tokens/product-lookup";
import {
  PRODUCT_ASSET_BUCKET,
  readSurfaceFile,
  surfaceExtension,
} from "@/lib/api-tokens/surface-file";
import type { ApiProductDeleted, ApiSurfaceReplaced } from "@/types/api-token";

/**
 * /api/v1/products/[product] — act on one existing product.
 *
 *   PUT     replace the product's surface template (the image wrapped on the 3D cue)
 *   DELETE  delete the product
 *
 *   curl -X PUT https://app/api/v1/products/n02-dragon-gold \
 *        -H "Authorization: Bearer cue_live_..." \
 *        -F file=@dragon-gold-v2.jpg
 *
 *   curl -X DELETE https://app/api/v1/products/n02-dragon-gold \
 *        -H "Authorization: Bearer cue_live_..."
 *
 * `[product]` takes the product NAME or its id, same as POST /api/v1/renders:
 * the caller is usually an agent holding the name it was told. Names resolve
 * only against the token owner's own products; an id reaches other users'
 * products only for an admin's token.
 *
 * Permissions — owner, or any admin token (tool admin or superadmin), for both.
 * Deleting is broader here than in the dashboard, whose delete stays
 * owner-only; that difference was asked for, not overlooked.
 *
 * A product deployed to Shopify can NEVER be deleted through this route —
 * there is deliberately no override flag.
 */

interface RouteParams {
  params: Promise<{ product: string }>;
}

/** Folder depth walked when deleting — products keep at most a couple of levels. */
const MAX_FOLDER_DEPTH = 3;

/** See POST /api/v1/products for why this is not `new URL(..., request.url)`. */
function editorUrl(request: Request, productId: string): string {
  return `${resolveAppBaseUrl(request)}/dashboard/products/${productId}`;
}

/** Every file path under a storage folder, walking sub-folders. */
async function listFolderFiles(
  db: RenderStorageClient,
  folder: string,
  depth = 0
): Promise<string[]> {
  const { data, error } = await db.storage
    .from(PRODUCT_ASSET_BUCKET)
    .list(folder, { limit: 1000 });

  if (error) {
    console.warn(`api/v1/products/[product]: could not list ${folder}:`, error.message);
    return [];
  }

  const paths: string[] = [];
  for (const entry of data ?? []) {
    const path = `${folder}/${entry.name}`;
    if (entry.id !== null) {
      paths.push(path);
    } else if (depth < MAX_FOLDER_DEPTH) {
      paths.push(...(await listFolderFiles(db, path, depth + 1)));
    }
  }
  return paths;
}

/** `surface.png` from a stored surface URL, ignoring its `?t=` cache-buster. */
function storedFileName(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.split("/").pop() ?? null;
  } catch {
    return null;
  }
}

/**
 * PUT — replace the surface template.
 *
 * Writes to the same `surface.<ext>` path the dashboard uses, in the OWNER's
 * folder (an admin editing someone else's product must not move the file into
 * their own). The stored URL carries a cache-buster, because the path is
 * reused: without it the editor and the render worker would keep serving the
 * old image from cache.
 */
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return errorResponse(
        "Send the new template as multipart/form-data with a `file` field.",
        400
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return errorResponse("Could not parse the multipart body.", 400);
    }

    const checked = readSurfaceFile(form);
    if (!checked.ok) return checked.response;
    const { file } = checked;

    // Service key: the caller has no session for RLS. The ownership check
    // below is what stands in for it.
    const db = asRenderStorageClient(createAdminServiceClient());

    const { product: wanted } = await params;
    const found = await findProduct(db, ctx, wanted);
    if (!found.ok) return found.response;
    const product = found.value;

    if (!canActOn(ctx, product)) {
      return errorResponse(`Product not found: ${wanted}`, 404);
    }

    const deployed = await loadLiveDeployments(db, product.id);
    if (!deployed.ok) return deployed.response;
    const stores = deployed.value.map((deployment) => deployment.store);

    const folder = `${product.user_id}/${product.id}`;
    const fileName = `surface.${surfaceExtension(file)}`;
    const storagePath = `${folder}/${fileName}`;

    const { error: uploadError } = await db.storage
      .from(PRODUCT_ASSET_BUCKET)
      .upload(storagePath, new Uint8Array(await file.arrayBuffer()), {
        contentType: file.type,
        upsert: true,
      });

    if (uploadError) {
      console.error("api/v1/products/[product]: surface upload failed:", uploadError.message);
      return errorResponse("Could not store the surface image.", 502);
    }

    const { data: urlData } = db.storage
      .from(PRODUCT_ASSET_BUCKET)
      .getPublicUrl(storagePath);
    const surfaceUrl = `${urlData.publicUrl}?t=${Date.now()}`;
    const updatedAt = new Date().toISOString();

    const { error: linkError } = await db
      .from("products")
      .update({ surface_url: surfaceUrl, updated_at: updatedAt })
      .eq("id", product.id);

    if (linkError) {
      // The new file IS stored — but when the extension is unchanged it has
      // overwritten the old one in place, so the product already shows the
      // new image through its old URL. Say so rather than claiming nothing
      // happened.
      console.error("api/v1/products/[product]: could not link surface:", linkError.message);
      return NextResponse.json(
        {
          error: "The image was uploaded but the product could not be updated to point at it.",
          product_id: product.id,
        },
        { status: 500 }
      );
    }

    // A template replaced with a different format (png -> jpg) leaves the old
    // file behind under another name. Best-effort: the product no longer
    // references it, so a failure here costs only storage.
    //
    // NOT for a deployed product: the live store still points at the old file
    // by name, and deleting it would break the storefront's 3D viewer until
    // someone redeploys. Leaving it costs a few MB.
    const { data: siblings } = stores.length > 0 ? { data: null } : await db.storage
      .from(PRODUCT_ASSET_BUCKET)
      .list(folder, { limit: 1000 });
    const stale = (siblings ?? [])
      .filter((entry) => entry.id !== null)
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("surface.") && name !== fileName)
      .map((name) => `${folder}/${name}`);
    if (stale.length > 0) {
      const { error: removeError } = await db.storage
        .from(PRODUCT_ASSET_BUCKET)
        .remove(stale);
      if (removeError) {
        console.warn("api/v1/products/[product]: stale surface cleanup failed:", removeError.message);
      }
    }

    const body: ApiSurfaceReplaced = {
      id: product.id,
      name: product.name,
      surface_url: surfaceUrl,
      previous_surface_url: product.surface_url,
      updated_at: updatedAt,
      editor_url: editorUrl(request, product.id),
      shopify_stores: stores,
      // Same file name -> the live store's URL now serves the new bytes.
      // A new name (format changed) -> the store still points at the old file.
      shopify_sync:
        stores.length === 0
          ? "not_deployed"
          : storedFileName(product.surface_url) === fileName
            ? "auto"
            : "redeploy_required",
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error("PUT /api/v1/products/[product] error:", error);
    return errorResponse("Internal server error", 500);
  }
}

/**
 * DELETE — delete the product, its stored files and its 3D settings.
 *
 * Always refuses a product deployed to Shopify (409): its deployment rows
 * would cascade away with it, leaving a live listing nothing here tracks.
 * There is intentionally no force flag — take it off Shopify first.
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    const db = asRenderStorageClient(createAdminServiceClient());

    const { product: wanted } = await params;
    const found = await findProduct(db, ctx, wanted);
    if (!found.ok) return found.response;
    const product = found.value;

    if (!canActOn(ctx, product)) {
      return errorResponse(`Product not found: ${wanted}`, 404);
    }

    const deployed = await loadLiveDeployments(db, product.id);
    if (!deployed.ok) return deployed.response;
    const stores = deployed.value.map((deployment) => deployment.store);
    if (stores.length > 0) {
      return NextResponse.json(
        {
          error:
            `Product is deployed to Shopify (${stores.join(", ")}) and cannot be ` +
            "deleted. Remove it from Shopify first.",
          shopify_stores: stores,
        },
        { status: 409 }
      );
    }

    // Row first, files after: if the delete fails the product is still whole,
    // where the reverse order could leave a product pointing at deleted files.
    const { error: deleteError } = await db
      .from("products")
      .delete()
      .eq("id", product.id)
      .eq("user_id", product.user_id);

    if (deleteError) {
      console.error("api/v1/products/[product]: delete failed:", deleteError.message);
      return errorResponse("Could not delete the product.", 500);
    }

    // Every create path (dashboard, clone, this API) gives a product its own
    // settings row, but nothing in the schema enforces that — so it is only
    // collected when no other product still points at it.
    const settingsId = product.threejs_settings_id;
    const { data: sharers } = settingsId
      ? await db
          .from("products")
          .select<{ id: string }>("id")
          .eq("threejs_settings_id", settingsId)
          .limit(1)
      : { data: null };
    if (settingsId && sharers !== null && sharers.length === 0) {
      const { error: settingsError } = await db
        .from("threejs_settings")
        .delete()
        .eq("id", settingsId);
      if (settingsError) {
        console.warn("api/v1/products/[product]: settings cleanup failed:", settingsError.message);
      }
    }

    const files = await listFolderFiles(db, `${product.user_id}/${product.id}`);
    let removedFiles = 0;
    if (files.length > 0) {
      const { error: removeError } = await db.storage
        .from(PRODUCT_ASSET_BUCKET)
        .remove(files);
      if (removeError) {
        console.warn("api/v1/products/[product]: file cleanup failed:", removeError.message);
      } else {
        removedFiles = files.length;
      }
    }

    const body: ApiProductDeleted = {
      id: product.id,
      name: product.name,
      deleted: true,
      removed_files: removedFiles,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error("DELETE /api/v1/products/[product] error:", error);
    return errorResponse("Internal server error", 500);
  }
}
