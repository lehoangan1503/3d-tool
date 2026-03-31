import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// PUT /api/extractor-reference-groups/[id] - Update a group
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { name, referenceIds } = body as { name?: string; referenceIds?: string[] };

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name.trim();
    if (referenceIds !== undefined) updates.reference_ids = referenceIds;

    const { data: group, error } = await supabase
      .from("extractor_reference_groups")
      .update(updates)
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id, name, reference_ids, created_at, updated_at")
      .single();

    if (error || !group) {
      return NextResponse.json({ error: "Failed to update group" }, { status: 500 });
    }

    return NextResponse.json({
      id: group.id,
      name: group.name,
      referenceIds: group.reference_ids ?? [],
      createdAt: group.created_at,
      updatedAt: group.updated_at,
    });
  } catch (error) {
    console.error("PUT /api/extractor-reference-groups/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/extractor-reference-groups/[id] - Delete a group
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { error } = await supabase
      .from("extractor_reference_groups")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      return NextResponse.json({ error: "Failed to delete group" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/extractor-reference-groups/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
