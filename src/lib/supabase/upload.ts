/**
 * Client-side direct upload to Supabase Storage
 * Bypasses Next.js API route for faster uploads (browser → Supabase directly)
 */

import { createClient } from "./client";

/**
 * Upload a file directly to Supabase Storage from the browser
 * Requires authenticated user session
 */
export async function uploadToStorage(
  file: File,
  productId: string,
  fileType: "surface" | "texture",
  userId: string
): Promise<string> {
  const supabase = createClient();

  // Validate file type
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    throw new Error("Invalid file type. Allowed: JPEG, PNG, WebP");
  }

  // Generate file path matching server-side convention
  const ext = file.name.split(".").pop() || "jpg";
  const fileName = fileType === "texture" ? `texture.${ext}` : `surface.${ext}`;
  const filePath = `${userId}/${productId}/${fileName}`;

  // Upload directly to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from("product-assets")
    .upload(filePath, file, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) {
    console.error("[Upload] Storage upload error:", uploadError);
    throw new Error(uploadError.message);
  }

  // Get public URL — append cache-buster so the browser/CDN doesn't serve
  // the stale file when the same path is upserted with new content.
  const { data: urlData } = supabase.storage
    .from("product-assets")
    .getPublicUrl(filePath);

  const bustUrl = `${urlData.publicUrl}?t=${Date.now()}`;
  console.log("[Upload] File uploaded successfully:", filePath);
  return bustUrl;
}

/**
 * Upload a product asset through the server instead of directly to Storage.
 *
 * Needed when the caller is a tool admin editing a product they do NOT own:
 * assets belong in the OWNER's folder, and storage RLS requires the first path
 * segment to equal auth.uid(), so the browser cannot write there. The route
 * re-checks the admin role before using the service client.
 */
export async function uploadProductAssetViaServer(
  file: File,
  productId: string,
  fileType: "surface" | "texture"
): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("fileType", fileType);

  const res = await fetch(`/api/products/${productId}/asset`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Không thể tải lên tệp");
  }

  const data = (await res.json()) as { url: string };
  return data.url;
}

/**
 * Upload a blob directly to Supabase Storage with a custom path.
 * Used for shopify mockup images and videos.
 */
export async function uploadBlobToStorage(
  blob: Blob,
  path: string,
  contentType: string,
): Promise<string> {
  const supabase = createClient();

  const { error: uploadError } = await supabase.storage
    .from("product-assets")
    .upload(path, blob, {
      contentType,
      upsert: true,
    });

  if (uploadError) {
    console.error("[Upload] Blob upload error:", uploadError);
    throw new Error(uploadError.message);
  }

  const { data: urlData } = supabase.storage
    .from("product-assets")
    .getPublicUrl(path);

  return `${urlData.publicUrl}?t=${Date.now()}`;
}

export async function uploadFilesInParallel(
  files: Array<{
    file: File;
    fileType: "surface" | "texture";
  }>,
  productId: string,
  userId: string
): Promise<{ surface?: string; texture?: string }> {
  const results = await Promise.all(
    files.map(async ({ file, fileType }) => {
      const url = await uploadToStorage(file, productId, fileType, userId);
      return { fileType, url };
    })
  );

  return results.reduce(
    (acc, { fileType, url }) => {
      acc[fileType] = url;
      return acc;
    },
    {} as { surface?: string; texture?: string }
  );
}
