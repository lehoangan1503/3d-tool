import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST /api/upload-overlay - Upload an overlay image for image extractor frames
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const customName = ((formData.get("customName") as string | null) ?? "").trim();

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Allowed: JPEG, PNG, WebP, GIF" },
        { status: 400 }
      );
    }

    const ext = file.name.split(".").pop() || "jpg";
    // Use custom name if provided, otherwise fall back to original file name (without ext)
    const baseName = customName || file.name.replace(/\.[^.]+$/, "");
    // Sanitize: keep alphanumeric, underscores, hyphens; replace everything else with _
    const sanitized = baseName
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") || "image";
    const uniqueName = `${sanitized}_${Date.now()}.${ext}`;
    const filePath = `${user.id}/overlays/${uniqueName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from("product-assets")
      .upload(filePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      console.error("Overlay upload error:", uploadError);
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: urlData } = supabase.storage
      .from("product-assets")
      .getPublicUrl(filePath);

    return NextResponse.json({ url: urlData.publicUrl, path: filePath });
  } catch (error) {
    console.error("POST /api/upload-overlay error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
