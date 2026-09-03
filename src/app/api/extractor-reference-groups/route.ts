import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveCreatorNames } from "@/lib/supabase/creator";
import { getSessionRole } from "@/lib/auth/roles";

// GET /api/extractor-reference-groups - List ALL reference groups globally (with creator info)
export async function GET() {
  try {
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: groups, error } = await supabase
      .from("extractor_reference_groups")
      .select("id, user_id, name, reference_ids, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Fetch groups error:", error);
      return NextResponse.json({ error: "Failed to fetch groups" }, { status: 500 });
    }

    const creatorIds = (groups ?? []).map((g: any) => g.user_id).filter(Boolean) as string[];
    const creatorMap = await resolveCreatorNames(supabase, creatorIds);

    // Tool admins may edit/delete anyone's group.
    const { canEditAnyProduct } = await getSessionRole();

    const result = (groups || []).map((g) => ({
      id: g.id,
      name: g.name,
      referenceIds: g.reference_ids ?? [],
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      createdByName: (g as any).user_id ? (creatorMap[(g as any).user_id] ?? "Unknown") : undefined,
      isOwner: (g as any).user_id === user.id,
      canEdit: (g as any).user_id === user.id || canEditAnyProduct,
    }));

    return NextResponse.json({ items: result });
  } catch (error) {
    console.error("GET /api/extractor-reference-groups error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/extractor-reference-groups - Create a new group
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { name, referenceIds } = body as { name: string; referenceIds: string[] };

    if (!name?.trim() || !Array.isArray(referenceIds) || referenceIds.length === 0) {
      return NextResponse.json({ error: "name and referenceIds are required" }, { status: 400 });
    }

    const { data: group, error } = await supabase
      .from("extractor_reference_groups")
      .insert({ user_id: user.id, name: name.trim(), reference_ids: referenceIds })
      .select("id, name, reference_ids, created_at, updated_at")
      .single();

    if (error || !group) {
      console.error("Create group error:", error);
      return NextResponse.json({ error: "Failed to create group" }, { status: 500 });
    }

    return NextResponse.json({
      id: group.id,
      name: group.name,
      referenceIds: group.reference_ids ?? [],
      createdAt: group.created_at,
      updatedAt: group.updated_at,
      isOwner: true,
      canEdit: true,
    });
  } catch (error) {
    console.error("POST /api/extractor-reference-groups error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
