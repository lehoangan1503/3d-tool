import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { UpdateProductInput, ThreeJSSettingsJson } from "@/types/product";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Extended update input to include config
interface UpdateProductWithConfigInput extends UpdateProductInput {
  config?: ThreeJSSettingsJson;
}

// GET /api/products/[id] - Get a single product
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json({ error: "Product not found" }, { status: 404 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/products/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/products/[id] - Update a product
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: UpdateProductWithConfigInput = await request.json();

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (body.name !== undefined) updateData.name = body.name;
    if (body.surface_url !== undefined) updateData.surface_url = body.surface_url;
    if (body.texture_type !== undefined) updateData.texture_type = body.texture_type;
    if (body.texture_url !== undefined) updateData.texture_url = body.texture_url;
    if (body.color !== undefined) updateData.color = body.color;

    // Update threejs_settings if config is provided
    if (body.config) {
      // Get the product's settings ID first
      const { data: productData } = await supabase
        .from("products")
        .select("threejs_settings_id")
        .eq("id", id)
        .eq("user_id", user.id)
        .single();

      if (productData?.threejs_settings_id) {
        const { error: settingsError } = await supabase
          .from("threejs_settings")
          .update({ 
            settings: body.config,
            updated_at: new Date().toISOString(),
          })
          .eq("id", productData.threejs_settings_id);

        if (settingsError) {
          console.error("Failed to update threejs_settings:", settingsError);
        }
      }
    }

    const { data, error } = await supabase
      .from("products")
      .update(updateData)
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return NextResponse.json({ error: "Product not found" }, { status: 404 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("PUT /api/products/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/products/[id] - Delete a product
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // First, delete associated files from storage
    const { data: product } = await supabase
      .from("products")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (product) {
      // Delete files in the product folder
      const folderPath = `${user.id}/${id}`;
      const { data: files } = await supabase.storage
        .from("product-assets")
        .list(folderPath);

      if (files && files.length > 0) {
        const filePaths = files.map(f => `${folderPath}/${f.name}`);
        await supabase.storage.from("product-assets").remove(filePaths);
      }
    }

    // Delete the product record
    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/products/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
