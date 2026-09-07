import { NextResponse } from "next/server";
import { createAdminServiceClient } from "@/lib/supabase/server";
import { asRenderStorageClient } from "@/lib/render/supabase-surface";
import { requireApiToken } from "@/lib/api-tokens/auth";
import { resolveProductName } from "@/lib/api-tokens/product-name";
import {
  DEFAULT_CONFIG_BY_TYPE,
  configToSettingsJson,
  isLeatherLikeType,
} from "@/types/product";
import type { ApiCreatedProduct } from "@/types/api-token";
import type { ApiTokenContext } from "@/types/api-token";

/**
 * POST /api/v1/products — create a product from a surface template.
 *
 * The external entry point: an AI (or any script) that has produced a surface
 * template sends the image and gets back a finished product, doing in one
 * request what a person does in two (create, then upload).
 *
 *   curl -X POST https://app/api/v1/products \
 *        -H "Authorization: Bearer cue_live_..." \
 *        -F file=@dragon-gold.jpg
 *
 * The token supplies the cue type and the name prefix, so the body carries
 * nothing but the file. `name` may be sent to override the filename; there is
 * deliberately nothing else to send, because every additional field is another
 * thing a prompt-driven caller can get wrong.
 *
 * Versioned under /api/v1 because this is the one route in the app with
 * callers we do not deploy: the dashboard's own routes can change shape with
 * the code that calls them, and this one cannot.
 */

/** Matches /api/upload — the formats the surface pipeline can read. */
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * Ceiling on an upload.
 *
 * Surface templates are 2K-4K textures, comfortably inside this; the limit is
 * here so a malformed or hostile request cannot buffer something enormous into
 * the route's memory.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The storage bucket product assets live in, same as the dashboard's upload. */
const ASSET_BUCKET = "product-assets";

interface CreatedProductRow {
  id: string;
  name: string;
  type: string;
  surface_url: string | null;
  created_at: string;
}

interface SettingsRow {
  id: string;
}

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Absolute URL of the editor for a product.
 *
 * Derived from the request rather than an env var so it is correct on every
 * deployment without configuration — the caller is talking to this host, so
 * this host is the right one to name.
 */
function editorUrl(request: Request, productId: string): string {
  return new URL(`/dashboard/products/${productId}`, request.url).toString();
}

/**
 * Reads and validates the multipart body.
 *
 * Returns the file plus the optional name override, or a response to send back.
 */
async function readUpload(
  request: Request
): Promise<{ ok: true; file: File; name: string | null } | { ok: false; response: NextResponse }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return {
      ok: false,
      response: badRequest(
        "Send the template as multipart/form-data with a `file` field."
      ),
    };
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, response: badRequest("Could not parse the multipart body.") };
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return { ok: false, response: badRequest("Missing `file` field.") };
  }

  if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
    return {
      ok: false,
      response: badRequest(
        `Unsupported image type "${file.type || "unknown"}". Allowed: JPEG, PNG, WebP.`
      ),
    };
  }

  if (file.size === 0) {
    return { ok: false, response: badRequest("The uploaded file is empty.") };
  }

  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `File is ${Math.round(file.size / 1024 / 1024)}MB; the limit is ${
            MAX_FILE_BYTES / 1024 / 1024
          }MB.`,
        },
        { status: 413 }
      ),
    };
  }

  const rawName = form.get("name");
  return {
    ok: true,
    file,
    name: typeof rawName === "string" && rawName.trim().length > 0 ? rawName : null,
  };
}

/**
 * Creates the product row and its default 3D settings.
 *
 * Split out because the storage upload that follows needs the product's id in
 * its path, so the row must exist first — which is also the order the
 * dashboard does it in.
 */
async function createProductRow(
  db: ReturnType<typeof asRenderStorageClient>,
  ctx: ApiTokenContext,
  name: string
): Promise<
  | { ok: true; product: CreatedProductRow; settingsId: string }
  | { ok: false; response: NextResponse }
> {
  const defaultConfig =
    DEFAULT_CONFIG_BY_TYPE[ctx.productType] ?? DEFAULT_CONFIG_BY_TYPE.smooth;

  const { data: settings, error: settingsError } = await db
    .from("threejs_settings")
    .insert({
      name: `product_${Date.now()}`,
      settings: configToSettingsJson(defaultConfig),
    })
    .select<SettingsRow>("id")
    .single();

  if (settingsError || !settings) {
    console.error("api/v1/products: settings insert failed:", settingsError?.message);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Could not create 3D settings for the product." },
        { status: 500 }
      ),
    };
  }

  // user_id comes from the TOKEN, never from the request: this runs on the
  // service key, so RLS will not catch a mistake here.
  const { data: product, error: productError } = await db
    .from("products")
    .insert({
      user_id: ctx.userId,
      name,
      type: ctx.productType,
      // Leather-like types need these columns populated to render; smooth
      // leaves them null. Same defaults the dashboard's create form applies.
      texture_type: isLeatherLikeType(ctx.productType) ? "crocodile" : null,
      color: isLeatherLikeType(ctx.productType) ? "black" : null,
      threejs_settings_id: settings.id,
    })
    .select<CreatedProductRow>("id, name, type, surface_url, created_at")
    .single();

  if (productError || !product) {
    // The settings row would otherwise be orphaned — nothing references it and
    // nothing would ever collect it.
    await db.from("threejs_settings").delete().eq("id", settings.id);
    console.error("api/v1/products: product insert failed:", productError?.message);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Could not create the product." },
        { status: 500 }
      ),
    };
  }

  return { ok: true, product, settingsId: settings.id };
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;

    const upload = await readUpload(request);
    if (!upload.ok) return upload.response;

    const { ctx } = auth;
    const name = resolveProductName({
      namePrefix: ctx.namePrefix,
      fileName: upload.file.name,
      requestedName: upload.name,
    });

    // Service key throughout: the caller has no Supabase session for RLS to
    // evaluate. Every write below is scoped to ctx.userId by hand.
    const db = asRenderStorageClient(createAdminServiceClient());

    const created = await createProductRow(db, ctx, name);
    if (!created.ok) return created.response;
    const { product, settingsId } = created;

    // Same layout as /api/upload, so a product created here is indistinguishable
    // from one created in the dashboard — the editor, the render worker and the
    // Shopify deploy all resolve surfaces by this path shape.
    const extension = upload.file.name.split(".").pop()?.toLowerCase() || "jpg";
    const storagePath = `${ctx.userId}/${product.id}/surface.${extension}`;

    const bytes = new Uint8Array(await upload.file.arrayBuffer());
    const { error: uploadError } = await db.storage
      .from(ASSET_BUCKET)
      .upload(storagePath, bytes, {
        contentType: upload.file.type,
        upsert: true,
      });

    if (uploadError) {
      // Roll the product back rather than leaving a surface-less shell behind:
      // the caller got an error, so from its side this product does not exist,
      // and a product with no template is not usable in the editor either.
      await db.from("products").delete().eq("id", product.id);
      await db.from("threejs_settings").delete().eq("id", settingsId);
      console.error("api/v1/products: surface upload failed:", uploadError.message);
      return NextResponse.json(
        { error: "Could not store the surface image." },
        { status: 502 }
      );
    }

    const { data: urlData } = db.storage.from(ASSET_BUCKET).getPublicUrl(storagePath);
    const surfaceUrl = urlData.publicUrl;

    const { error: linkError } = await db
      .from("products")
      .update({ surface_url: surfaceUrl, updated_at: new Date().toISOString() })
      .eq("id", product.id);

    if (linkError) {
      // The file is uploaded but unreferenced. Reporting failure would be
      // worse than it looks — the product exists and a retry would create a
      // duplicate — so this is surfaced as a 500 with the id, letting the
      // caller decide.
      console.error("api/v1/products: could not link surface:", linkError.message);
      return NextResponse.json(
        {
          error: "Product was created but the surface could not be linked to it.",
          product_id: product.id,
        },
        { status: 500 }
      );
    }

    const body: ApiCreatedProduct = {
      id: product.id,
      name: product.name,
      type: ctx.productType,
      surface_url: surfaceUrl,
      created_at: product.created_at,
      editor_url: editorUrl(request, product.id),
    };

    return NextResponse.json(body, { status: 201 });
  } catch (error) {
    console.error("POST /api/v1/products error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
