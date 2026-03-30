import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/storage-images - List overlay images from Supabase Storage
// Query params: search, limit (default 30, max 100), offset (default 0)
export async function GET(request: Request) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const search = (searchParams.get("search") || "").trim().toLowerCase();
    const limit = Math.min(parseInt(searchParams.get("limit") || "30", 10), 100);
    const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10), 0);

    const folder = `${user.id}/overlays`;

    // Fetch a large batch for server-side filtering; storage list doesn't do substring search
    const { data: files, error } = await supabase.storage
      .from("product-assets")
      .list(folder, {
        limit: 200,
        offset: 0,
        sortBy: { column: "created_at", order: "desc" },
      });

    if (error) {
      console.error("Storage list error:", error);
      return NextResponse.json({ error: "Failed to list images" }, { status: 500 });
    }

    // Filter by search (substring match on name, case-insensitive)
    const allFiles = files || [];
    const filtered = search
      ? allFiles.filter((f) => f.name.toLowerCase().includes(search))
      : allFiles;

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    // Build public URLs
    const images = page.map((file) => {
      const { data: urlData } = supabase.storage
        .from("product-assets")
        .getPublicUrl(`${folder}/${file.name}`);
      return {
        name: file.name,
        path: `${folder}/${file.name}`,
        url: urlData.publicUrl,
        createdAt: file.created_at,
      };
    });

    return NextResponse.json({ images, total });
  } catch (error) {
    console.error("GET /api/storage-images error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/storage-images?path=<storage_path> - Delete an overlay image
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path");
    if (!path) {
      return NextResponse.json({ error: "Missing path" }, { status: 400 });
    }

    // Security: ensure the path belongs to this user
    if (!path.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await supabase.storage
      .from("product-assets")
      .remove([path]);

    if (error) {
      console.error("Storage delete error:", error);
      return NextResponse.json({ error: "Failed to delete image" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/storage-images error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
