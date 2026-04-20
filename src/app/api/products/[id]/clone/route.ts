import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/products/[id]/clone - Clone a product (copy all fields, new owner = current user)
export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch the source product (any authenticated user can view any product now)
    const { data: source, error: srcError } = await supabase
      .from("products")
      .select("*")
      .eq("id", id)
      .single();

    if (srcError || !source) {
      return NextResponse.json({ error: "Không tìm thấy sản phẩm" }, { status: 404 });
    }

    // Fetch the source threejs_settings
    let newSettingsId: string | null = null;
    if (source.threejs_settings_id) {
      const { data: srcSettings } = await supabase
        .from("threejs_settings")
        .select("settings")
        .eq("id", source.threejs_settings_id)
        .single();

      if (srcSettings?.settings) {
        const { data: newSettings, error: settingsError } = await supabase
          .from("threejs_settings")
          .insert({
            name: `product_clone_${Date.now()}`,
            settings: srcSettings.settings,
          })
          .select()
          .single();

        if (settingsError) {
          return NextResponse.json({ error: settingsError.message }, { status: 500 });
        }
        newSettingsId = newSettings.id;
      }
    }

    // Create new product with current user as owner
    const { data: cloned, error: cloneError } = await supabase
      .from("products")
      .insert({
        user_id: user.id,
        name: `${source.name} (bản sao)`,
        type: source.type,
        surface_url: source.surface_url,
        texture_type: source.texture_type,
        texture_url: source.texture_url,
        color: source.color,
        threejs_settings_id: newSettingsId,
      })
      .select()
      .single();

    if (cloneError) {
      if (newSettingsId) {
        await supabase.from("threejs_settings").delete().eq("id", newSettingsId);
      }
      return NextResponse.json({ error: cloneError.message }, { status: 500 });
    }

    return NextResponse.json(cloned, { status: 201 });
  } catch (error) {
    console.error("POST /api/products/[id]/clone error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
