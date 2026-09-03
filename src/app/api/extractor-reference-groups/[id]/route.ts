import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// PUT /api/extractor-reference-groups/[id] - Update a group (owner, or tool admin for anyone's)
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: existing } = await supabase
      .from("extractor_reference_groups")
      .select("user_id")
      .eq("id", id)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }

    const isOwner = existing.user_id === user.id;
    const { canEditAnyProduct } = await getSessionRole();

    if (!isOwner && !canEditAnyProduct) {
      return NextResponse.json(
        { error: "Bạn không có quyền sửa bố cục của người dùng khác." },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { name, referenceIds } = body as { name?: string; referenceIds?: string[] };

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name.trim();
    if (referenceIds !== undefined) updates.reference_ids = referenceIds;

    // Owners write as themselves (RLS applies). Cross-owner admin edits bypass
    // RLS via the service client, only after the check above passed.
    const writeClient = isOwner ? supabase : createAdminServiceClient();

    let query = writeClient
      .from("extractor_reference_groups")
      .update(updates)
      .eq("id", id);
    if (isOwner) query = query.eq("user_id", user.id);

    const { data: group, error } = await query
      .select("id, user_id, name, reference_ids, created_at, updated_at")
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
      isOwner: group.user_id === user.id,
    });
  } catch (error) {
    console.error("PUT /api/extractor-reference-groups/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/extractor-reference-groups/[id] - Delete a group (owner, or tool admin for anyone's)
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: existing } = await supabase
      .from("extractor_reference_groups")
      .select("user_id")
      .eq("id", id)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }

    const isOwner = existing.user_id === user.id;
    const { canEditAnyProduct } = await getSessionRole();

    if (!isOwner && !canEditAnyProduct) {
      return NextResponse.json(
        { error: "Bạn không có quyền xoá bố cục của người dùng khác." },
        { status: 403 }
      );
    }

    const writeClient = isOwner ? supabase : createAdminServiceClient();

    let query = writeClient.from("extractor_reference_groups").delete().eq("id", id);
    if (isOwner) query = query.eq("user_id", user.id);

    const { error } = await query;

    if (error) {
      return NextResponse.json({ error: "Failed to delete group" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/extractor-reference-groups/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
