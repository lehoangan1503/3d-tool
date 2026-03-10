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

  // Get public URL
  const { data: urlData } = supabase.storage
    .from("product-assets")
    .getPublicUrl(filePath);

  console.log("[Upload] File uploaded successfully:", filePath);
  return urlData.publicUrl;
}

/**
 * Upload multiple files in parallel
 * Returns object with URLs keyed by fileType
 */
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
