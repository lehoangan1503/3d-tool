import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateProductInput } from "@/types/product";
import { DEFAULT_SMOOTH_CONFIG, DEFAULT_LEATHER_CONFIG, configToSettingsJson } from "@/types/product";

// GET /api/products - List all products for current user
export async function GET() {
  try {
    const supabase = await createClient();
    
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/products error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/products - Create a new product
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: CreateProductInput = await request.json();

    // Validate required fields
    if (!body.name || !body.type) {
      return NextResponse.json(
        { error: "Name and type are required" },
        { status: 400 }
      );
    }

    if (!["smooth", "leather"].includes(body.type)) {
      return NextResponse.json(
        { error: "Type must be 'smooth' or 'leather'" },
        { status: 400 }
      );
    }

    // Create threejs_settings record with type-specific default config
    const defaultConfig = body.type === "leather" ? DEFAULT_LEATHER_CONFIG : DEFAULT_SMOOTH_CONFIG;
    const settingsJson = configToSettingsJson(defaultConfig);
    const { data: settingsData, error: settingsError } = await supabase
      .from("threejs_settings")
      .insert({
        name: `product_${Date.now()}`,
        settings: settingsJson,
      })
      .select()
      .single();

    if (settingsError) {
      console.error("Failed to create threejs_settings:", settingsError);
      return NextResponse.json({ error: settingsError.message }, { status: 500 });
    }

    // Create product with reference to settings
    const { data, error } = await supabase
      .from("products")
      .insert({
        user_id: user.id,
        name: body.name,
        type: body.type,
        surface_url: body.surface_url || null,
        texture_type: body.type === "leather" ? (body.texture_type || "crocodile") : null,
        color: body.type === "leather" ? (body.color || "black") : null,
        threejs_settings_id: settingsData.id,
      })
      .select()
      .single();

    if (error) {
      // Clean up settings if product creation fails
      await supabase.from("threejs_settings").delete().eq("id", settingsData.id);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error("POST /api/products error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
