import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * POST /api/products/[id]/asset — upload a surface/texture image for a product
 * the caller does NOT own.
 *
 * Owners upload straight from the browser (see lib/supabase/upload.ts); that
 * path is fine because storage RLS requires the first path segment to equal
 * auth.uid(). A tool admin editing someone else's product must write into the
 * OWNER's folder, which the browser cannot do — so it goes through here and the
 * service client, after the role check.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const fileType = formData.get("fileType");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (fileType !== "surface" && fileType !== "texture") {
      return NextResponse.json(
        { error: "fileType must be 'surface' or 'texture'" },
        { status: 400 }
      );
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Allowed: JPEG, PNG, WebP" },
        { status: 400 }
      );
    }

    const { data: product, error: productError } = await supabase
      .from("products")
      .select("user_id")
      .eq("id", id)
      .maybeSingle();

    if (productError) {
      return NextResponse.json({ error: productError.message }, { status: 500 });
    }
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const isOwner = product.user_id === user.id;
    const { canEditAnyProduct } = await getSessionRole();

    if (!isOwner && !canEditAnyProduct) {
      return NextResponse.json(
        { error: "Bạn không có quyền sửa sản phẩm của người dùng khác." },
        { status: 403 }
      );
    }

    // Assets always live under the OWNER's folder so they stay with the product
    // no matter who edited it.
    const ext = file.name.split(".").pop() || "jpg";
    const fileName = fileType === "texture" ? `texture.${ext}` : `surface.${ext}`;
    const filePath = `${product.user_id}/${id}/${fileName}`;

    const storage = isOwner ? supabase : createAdminServiceClient();
    const buffer = new Uint8Array(await file.arrayBuffer());

    const { error: uploadError } = await storage.storage
      .from("product-assets")
      .upload(filePath, buffer, { contentType: file.type, upsert: true });

    if (uploadError) {
      console.error("[products/asset] upload failed:", uploadError);
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: urlData } = storage.storage
      .from("product-assets")
      .getPublicUrl(filePath);

    // Cache-buster: the same path is upserted with new content.
    return NextResponse.json({
      url: `${urlData.publicUrl}?t=${Date.now()}`,
      path: filePath,
    });
  } catch (error) {
    console.error("POST /api/products/[id]/asset error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
