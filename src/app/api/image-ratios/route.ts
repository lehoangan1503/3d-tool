import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ImageRatio } from "@/types/extractor";

// GET /api/image-ratios - List all canvas ratio presets
export async function GET() {
  try {
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .schema("shopify_customizer")
      .from("image_ratios")
      .select("id, label, width, height, is_default, created_at")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Fetch image_ratios error:", error);
      return NextResponse.json({ error: "Failed to fetch ratios" }, { status: 500 });
    }

    const ratios: ImageRatio[] = (data || []).map((r: any) => ({
      id: r.id,
      label: r.label,
      width: r.width,
      height: r.height,
      isDefault: r.is_default,
    }));

    return NextResponse.json({ ratios });
  } catch (error) {
    console.error("GET /api/image-ratios error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/image-ratios - Create a new custom ratio
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { label, width, height } = body as { label?: string; width?: number; height?: number };

    if (!width || !height || width <= 0 || height <= 0) {
      return NextResponse.json({ error: "Invalid width or height" }, { status: 400 });
    }

    const finalLabel = (label?.trim()) || `Custom (${width} × ${height})`;

    const { data, error } = await supabase
      .schema("shopify_customizer")
      .from("image_ratios")
      .insert({ label: finalLabel, width, height, is_default: false })
      .select("id, label, width, height, is_default")
      .single();

    if (error || !data) {
      console.error("Insert image_ratio error:", error);
      return NextResponse.json({ error: "Failed to create ratio" }, { status: 500 });
    }

    const ratio: ImageRatio = {
      id: data.id,
      label: data.label,
      width: data.width,
      height: data.height,
      isDefault: data.is_default,
    };

    return NextResponse.json({ ratio }, { status: 201 });
  } catch (error) {
    console.error("POST /api/image-ratios error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
