import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/video-studio-templates/[id] - Get single template (global read)
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: template, error } = await supabase
      .from("video_studio_templates")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json(template);
  } catch (error) {
    console.error("GET /api/video-studio-templates/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/video-studio-templates/[id] - Update template (owner only)
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify ownership — the creator, or a tool admin for anyone's template.
    // Legacy rows with a NULL created_by have no owner, so only admins may
    // touch them.
    const { data: existing } = await supabase
      .from("video_studio_templates")
      .select("created_by")
      .eq("id", id)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const isOwner = !!existing.created_by && existing.created_by === user.id;
    const { canEditAnyProduct } = await getSessionRole();

    if (!isOwner && !canEditAnyProduct) {
      return NextResponse.json(
        { error: "Bạn không có quyền sửa mẫu studio của người dùng khác." },
        { status: 403 }
      );
    }

    // Owners write as themselves (RLS applies). Cross-owner admin edits bypass
    // RLS via the service client, only after the check above passed.
    const writeClient = isOwner ? supabase : createAdminServiceClient();

    const body = await request.json();
    const { name, config } = body as {
      name?: string;
      config?: Record<string, unknown>;
    };

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (name !== undefined) updates.name = name;
    if (config !== undefined) updates.config = config;

    const { data: template, error } = await writeClient
      .from("video_studio_templates")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error || !template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json(template);
  } catch (error) {
    console.error("PUT /api/video-studio-templates/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/video-studio-templates/[id] - Delete template (owner only)
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify ownership — the creator, or a tool admin for anyone's template.
    // Legacy rows with a NULL created_by have no owner, so only admins may
    // delete them.
    const { data: existing } = await supabase
      .from("video_studio_templates")
      .select("created_by")
      .eq("id", id)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const isOwner = !!existing.created_by && existing.created_by === user.id;
    const { canEditAnyProduct } = await getSessionRole();

    if (!isOwner && !canEditAnyProduct) {
      return NextResponse.json(
        { error: "Bạn không có quyền xoá mẫu studio của người dùng khác." },
        { status: 403 }
      );
    }

    const writeClient = isOwner ? supabase : createAdminServiceClient();

    const { error } = await writeClient
      .from("video_studio_templates")
      .delete()
      .eq("id", id);

    if (error) {
      return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("DELETE /api/video-studio-templates/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
