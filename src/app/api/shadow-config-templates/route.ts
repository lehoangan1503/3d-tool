import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const DB_SCHEMA = process.env.NEXT_PUBLIC_DB_SCHEMA || "shopify_customizer";

function isShadowTemplateSchemaCacheMiss(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST205" && (error.message ?? "").includes("shadow_config_templates");
}

// GET /api/shadow-config-templates - List templates with pagination + search
export async function GET(request: Request) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit  = Math.min(parseInt(searchParams.get("limit")  ?? "40", 10), 100);
    const offset = Math.max(parseInt(searchParams.get("offset") ?? "0",  10), 0);
    const search = (searchParams.get("search") ?? "").trim();

    let query = supabase
      .schema(DB_SCHEMA)
      .from("shadow_config_templates")
      .select("*", { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.ilike("name", `%${search}%`);
    }

    const { data: templates, error, count } = await query;

    if (error) {
      if (isShadowTemplateSchemaCacheMiss(error)) {
        return NextResponse.json({
          items: [],
          total: 0,
          unavailable: true,
          error: error.message,
        });
      }
      console.error("Fetch shadow config templates error:", error);
      return NextResponse.json({ error: "Failed to fetch templates" }, { status: 500 });
    }

    return NextResponse.json({ items: templates ?? [], total: count ?? 0 });
  } catch (error) {
    console.error("GET /api/shadow-config-templates error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/shadow-config-templates - Create new template
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { name, config } = body as {
      name: string;
      config: Record<string, unknown>;
    };

    if (!name || !config) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { data: template, error } = await supabase
      .schema(DB_SCHEMA)
      .from("shadow_config_templates")
      .insert({ name, config })
      .select()
      .single();

    if (error || !template) {
      if (isShadowTemplateSchemaCacheMiss(error)) {
        return NextResponse.json(
          { error: error!.message, code: error!.code },
          { status: 503 }
        );
      }
      console.error("Create shadow config template error:", error);
      return NextResponse.json({ error: "Failed to create template" }, { status: 500 });
    }

    return NextResponse.json(template);
  } catch (error) {
    console.error("POST /api/shadow-config-templates error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
