import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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

    // Verify ownership — only the creator may update
    const { data: existing } = await supabase
      .from("video_studio_templates")
      .select("created_by")
      .eq("id", id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
    if (existing.created_by && existing.created_by !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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

    const { data: template, error } = await supabase
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

    // Verify ownership — only the creator may delete
    const { data: existing } = await supabase
      .from("video_studio_templates")
      .select("created_by")
      .eq("id", id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
    if (existing.created_by && existing.created_by !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await supabase
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
