import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const DB_SCHEMA = process.env.NEXT_PUBLIC_DB_SCHEMA || "shopify_customizer";

function isShadowTemplateSchemaCacheMiss(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST205" && (error.message ?? "").includes("shadow_config_templates");
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/shadow-config-templates/[id] - Get single template
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: template, error } = await supabase
      .schema(DB_SCHEMA)
      .from("shadow_config_templates")
      .select("*")
      .eq("id", id)
      .single();

    if (isShadowTemplateSchemaCacheMiss(error)) {
      return NextResponse.json(
        { error: error!.message, code: error!.code },
        { status: 503 }
      );
    }

    if (error || !template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json(template);
  } catch (error) {
    console.error("GET /api/shadow-config-templates/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/shadow-config-templates/[id] - Update template
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
      .schema(DB_SCHEMA)
      .from("shadow_config_templates")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (isShadowTemplateSchemaCacheMiss(error)) {
      return NextResponse.json(
        { error: error!.message, code: error!.code },
        { status: 503 }
      );
    }

    if (error || !template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json(template);
  } catch (error) {
    console.error("PUT /api/shadow-config-templates/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/shadow-config-templates/[id] - Delete template
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { error } = await supabase
      .schema(DB_SCHEMA)
      .from("shadow_config_templates")
      .delete()
      .eq("id", id);

    if (isShadowTemplateSchemaCacheMiss(error)) {
      return NextResponse.json(
        { error: error!.message, code: error!.code },
        { status: 503 }
      );
    }

    if (error) {
      return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("DELETE /api/shadow-config-templates/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
