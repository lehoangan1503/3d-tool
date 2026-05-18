import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// GET /api/storage-images - List overlay images from Supabase Storage
// Query params: search, limit (default 30, max 100), offset (default 0), filter (all|mine)
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
    const filter = searchParams.get("filter") || "all"; // "all" or "mine"

    type ImageEntry = { name: string; path: string; url: string; createdAt: string | undefined; isOwn: boolean };
    let allImages: ImageEntry[] = [];

    if (filter === "mine") {
      // Fast path: only current user's images
      const folder = `${user.id}/overlays`;
      const { data: files, error } = await supabase.storage
        .from("product-assets")
        .list(folder, { limit: 200, offset: 0, sortBy: { column: "created_at", order: "desc" } });

      if (error) {
        console.error("Storage list error:", error);
        return NextResponse.json({ error: "Failed to list images" }, { status: 500 });
      }

      for (const file of files || []) {
        const { data: urlData } = supabase.storage.from("product-assets").getPublicUrl(`${folder}/${file.name}`);
        allImages.push({ name: file.name, path: `${folder}/${file.name}`, url: urlData.publicUrl, createdAt: file.created_at, isOwn: true });
      }
    } else {
      // Full path: list all users via service role, then fetch each user's overlays
      const adminSupabase = await createServiceClient();

      // List root of bucket to discover user-id folders
      const { data: rootFolders } = await adminSupabase.storage
        .from("product-assets")
        .list("", { limit: 1000, offset: 0 });

      // Fetch overlays for all user folders in parallel
      await Promise.all((rootFolders || []).map(async (folder) => {
        const overlaysPath = `${folder.name}/overlays`;
        const { data: files } = await adminSupabase.storage
          .from("product-assets")
          .list(overlaysPath, { limit: 200, offset: 0, sortBy: { column: "created_at", order: "desc" } });

        for (const file of files || []) {
          const filePath = `${overlaysPath}/${file.name}`;
          const { data: urlData } = adminSupabase.storage.from("product-assets").getPublicUrl(filePath);
          allImages.push({
            name: file.name,
            path: filePath,
            url: urlData.publicUrl,
            createdAt: file.created_at,
            isOwn: folder.name === user.id,
          });
        }
      }));

      // Sort: own images first, then by createdAt desc
      allImages.sort((a, b) => {
        if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
        return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      });
    }

    // Filter by search (substring match on name)
    const filtered = search
      ? allImages.filter((img) => img.name.toLowerCase().includes(search))
      : allImages;

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    return NextResponse.json({ images: page, total });
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
