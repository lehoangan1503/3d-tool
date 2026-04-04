import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/video-studio-templates - List user's templates with pagination + search
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
    const productId = searchParams.get("product_id");

    let query = supabase
      .from("video_studio_templates")
      .select("*", { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (productId) {
      query = query.eq("product_id", productId);
    }

    if (search) {
      query = query.ilike("name", `%${search}%`);
    }

    const { data: templates, error, count } = await query;

    if (error) {
      console.error("Fetch video studio templates error:", error);
      return NextResponse.json({ error: "Failed to fetch templates" }, { status: 500 });
    }

    return NextResponse.json({ items: templates ?? [], total: count ?? 0 });
  } catch (error) {
    console.error("GET /api/video-studio-templates error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/video-studio-templates - Create new template
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { product_id, name, config } = body as {
      product_id: string;
      name: string;
      config: Record<string, unknown>;
    };

    if (!product_id || !name || !config) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { data: template, error } = await supabase
      .from("video_studio_templates")
      .insert({ product_id, name, config })
      .select()
      .single();

    if (error || !template) {
      console.error("Create video studio template error:", error);
      return NextResponse.json({ error: "Failed to create template" }, { status: 500 });
    }

    return NextResponse.json(template);
  } catch (error) {
    console.error("POST /api/video-studio-templates error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
