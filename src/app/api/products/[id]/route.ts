import { NextResponse } from "next/server";
import { createClient, createAdminServiceClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/auth/roles";
import type { UpdateProductInput, ThreeJSSettingsJson } from "@/types/product";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Extended update input to include config
interface UpdateProductWithConfigInput extends UpdateProductInput {
  config?: ThreeJSSettingsJson;
}

// GET /api/products/[id] - Get a single product (any authenticated user can view)
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

    // Ownership / permission. A tool admin (user_profiles.role === 'admin') and
    // the superadmin may edit ANY user's product; everyone else only their own.
    // Reads go through the caller's client (SELECT is open to all authenticated
    // users); cross-owner WRITES need the service client because the products
    // UPDATE policy is still USING (auth.uid() = user_id).
    const { data: existing, error: existingError } = await supabase
      .from("products")
      .select("user_id, threejs_settings_id")
      .eq("id", id)
      .maybeSingle();

    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const isOwner = existing.user_id === user.id;
    const { canEditAnyProduct } = await getSessionRole();

    if (!isOwner && !canEditAnyProduct) {
      return NextResponse.json(
        { error: "Bạn không có quyền sửa sản phẩm của người dùng khác." },
        { status: 403 }
      );
    }

    // Owners write as themselves (RLS applies). Cross-owner admin edits bypass
    // RLS via the service client, only after the check above passed.
    const writeClient = isOwner ? supabase : createAdminServiceClient();

    const body: UpdateProductWithConfigInput = await request.json();

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (body.name !== undefined) updateData.name = body.name;
    if (body.surface_url !== undefined) updateData.surface_url = body.surface_url;
    if (body.surface_slots !== undefined) updateData.surface_slots = body.surface_slots;
    if (body.shaft_config !== undefined) updateData.shaft_config = body.shaft_config;
    if (body.texture_type !== undefined) updateData.texture_type = body.texture_type;
    if (body.texture_url !== undefined) updateData.texture_url = body.texture_url;
    if (body.color !== undefined) updateData.color = body.color;

    // Update threejs_settings if config is provided (settings id read above).
    if (body.config && existing.threejs_settings_id) {
      const { error: settingsError } = await writeClient
        .from("threejs_settings")
        .update({
          settings: body.config,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.threejs_settings_id);

      if (settingsError) {
        console.error("Failed to update threejs_settings:", settingsError);
      }
    }

    let query = writeClient.from("products").update(updateData).eq("id", id);
    // Keep the owner guard for self-edits; admins already passed the check above.
    if (isOwner) query = query.eq("user_id", user.id);

    const { data, error } = await query.select().single();

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

// DELETE /api/products/[id] - Delete a product.
//
// Deliberately OWNER-ONLY: the tool 'admin' role may edit, update and deploy
// any user's product but must NOT be able to delete someone else's work. The
// .eq("user_id", user.id) filters below are the enforcement — do not relax them
// to an admin bypass without an explicit product decision.
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
