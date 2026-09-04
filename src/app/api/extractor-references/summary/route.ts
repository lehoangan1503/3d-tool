import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";

/** One row of the picker list — name and thumbnail, nothing else. */
interface ReferenceSummary {
  id: string;
  name: string;
  thumbUrl: string | null;
}

/** Guards the URL length and keeps one request from scanning the whole table. */
const MAX_IDS = 200;

/**
 * GET /api/extractor-references/summary?ids=uuid,uuid,...
 *
 * The name + thumbnail for a set of references, for the render page's
 * "which images in this group?" dialog.
 *
 * Why not the existing list endpoints:
 *   - GET /api/extractor-references returns every frame of every reference
 *     (hdri_layers, shadow_config, image_settings...) — tens of KB per row when
 *     the dialog needs two fields.
 *   - GET /api/extractor-references/[id] is one request per reference, so a
 *     22-image group meant 22 round trips just to draw a checklist.
 *
 * Unknown ids are simply absent from the response. A group can list a reference
 * that no longer exists, and the caller renders what came back — the same
 * "silently drop" contract the render payload builder uses.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const ids = (searchParams.get("ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return NextResponse.json({ items: [] });
    }
    if (ids.length > MAX_IDS) {
      return NextResponse.json(
        { error: `Too many ids (max ${MAX_IDS})` },
        { status: 400 }
      );
    }

    // RLS decides which of these the caller may see, exactly as elsewhere.
    const { data, error } = await supabase
      .from("extractor_references")
      .select("id, name, thumb_url")
      .in("id", ids);

    if (error) {
      console.error("GET /api/extractor-references/summary error:", error);
      return NextResponse.json({ error: "Failed to load references" }, { status: 500 });
    }

    const byId = new Map(
      (data ?? []).map((row): [string, ReferenceSummary] => [
        row.id,
        {
          id: row.id,
          name: row.name ?? "(không tên)",
          // Thumbnails are served through the same rewrite as every other
          // storage asset, so the raw public URL must be resolved.
          thumbUrl: row.thumb_url ? (resolveStorageUrl(row.thumb_url) ?? row.thumb_url) : null,
        },
      ])
    );

    // Returned in the ORDER THE CALLER ASKED, not the table's order: for an
    // image group that order is the gallery slot order (Mockup-Web-1, -2, ...),
    // which the dialog must show faithfully.
    const items = ids
      .map((id) => byId.get(id))
      .filter((r): r is ReferenceSummary => r !== undefined);

    return NextResponse.json({ items });
  } catch (error) {
    console.error("GET /api/extractor-references/summary error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
