/**
 * The surface-template file rules shared by every /api/v1 route that accepts
 * one — creating a product, and replacing an existing product's template.
 *
 * One definition so the two cannot drift: a file the create route accepts must
 * also be accepted as a replacement, or an agent that built a product would
 * fail to update it with the very same image.
 */

import { NextResponse } from "next/server";

/** Matches /api/upload — the formats the surface pipeline can read. */
export const SURFACE_ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * Ceiling on an upload.
 *
 * Surface templates are 2K-4K textures, comfortably inside this; the limit is
 * here so a malformed or hostile request cannot buffer something enormous into
 * the route's memory.
 */
export const SURFACE_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The storage bucket product assets live in, same as the dashboard's upload. */
export const PRODUCT_ASSET_BUCKET = "product-assets";

/**
 * Validates the `file` field of a multipart form.
 *
 * Returns the file, or the response to send back when it is unusable.
 */
export function readSurfaceFile(
  form: FormData
): { ok: true; file: File } | { ok: false; response: NextResponse } {
  const file = form.get("file");
  if (!(file instanceof File)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Missing `file` field." }, { status: 400 }),
    };
  }

  if (!SURFACE_ALLOWED_MIME.includes(file.type as (typeof SURFACE_ALLOWED_MIME)[number])) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Unsupported image type "${file.type || "unknown"}". Allowed: JPEG, PNG, WebP.`,
        },
        { status: 400 }
      ),
    };
  }

  if (file.size === 0) {
    return {
      ok: false,
      response: NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 }),
    };
  }

  if (file.size > SURFACE_MAX_FILE_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `File is ${Math.round(file.size / 1024 / 1024)}MB; the limit is ${
            SURFACE_MAX_FILE_BYTES / 1024 / 1024
          }MB.`,
        },
        { status: 413 }
      ),
    };
  }

  return { ok: true, file };
}

/** `jpg` / `png` / `webp`, from the filename, defaulting to jpg as /api/upload does. */
export function surfaceExtension(file: File): string {
  return file.name.split(".").pop()?.toLowerCase() || "jpg";
}
