import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/extractor-references/[id]/thumbnail - Upload/update reference thumbnail
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify ownership — owners write their own; tool admins may write anyone's
    const { data: existing } = await supabase
      .from("extractor_references")
      .select("id, user_id")
      .eq("id", id)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: "Reference not found" }, { status: 404 });
    }

    const isOwner = existing.user_id === user.id;
    const { canEditAnyProduct } = await getSessionRole();

    if (!isOwner && !canEditAnyProduct) {
      return NextResponse.json(
        { error: "Bạn không có quyền sửa tham chiếu của người dùng khác." },
        { status: 403 }
      );
    }

    // Owners write as themselves (RLS applies). Cross-owner admin writes bypass
    // RLS via the service client, only after the check above passed.
    const writeClient = isOwner ? supabase : createAdminServiceClient();

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const filePath = `${existing.user_id}/reference-thumbnails/${id}.png`;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    // Remove old image first so upsert starts clean
    await writeClient.storage.from("product-assets").remove([filePath]);

    // Upload new image
    const { error: uploadError } = await writeClient.storage
      .from("product-assets")
      .upload(filePath, buffer, {
        contentType: "image/png",
        upsert: true,
      });

    if (uploadError) {
      console.error("Thumbnail upload error:", uploadError);
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    // Get public URL
    const { data: urlData } = writeClient.storage
      .from("product-assets")
      .getPublicUrl(filePath);

    // Rewrite internal IP to public HTTPS proxy, then append cache-buster
    const thumbUrl = `${resolveStorageUrl(urlData.publicUrl)}?v=${Date.now()}`;

    // Save thumb_url on the reference record
    const { error: updateError } = await writeClient
      .from("extractor_references")
      .update({ thumb_url: thumbUrl })
      .eq("id", id);

    if (updateError) {
      console.error("Thumbnail DB update error:", updateError);
      return NextResponse.json({ error: "Failed to update reference" }, { status: 500 });
    }

    return NextResponse.json({ thumb_url: thumbUrl });
  } catch (error) {
    console.error("POST /api/extractor-references/[id]/thumbnail error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
