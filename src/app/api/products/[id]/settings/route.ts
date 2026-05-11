import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/products/[id]/settings - Get threejs settings JSON for a product
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: product } = await supabase
      .from("products")
      .select("threejs_settings_id")
      .eq("id", id)
      .single();

    if (!product?.threejs_settings_id) {
      return NextResponse.json({ error: "Product not found or has no settings" }, { status: 404 });
    }

    const { data: settings, error } = await supabase
      .from("threejs_settings")
      .select("settings")
      .eq("id", product.threejs_settings_id)
      .single();

    if (error || !settings?.settings) {
      return NextResponse.json({ error: "Settings not found" }, { status: 404 });
    }

    return NextResponse.json(settings.settings);
  } catch (error) {
    console.error("GET /api/products/[id]/settings error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
