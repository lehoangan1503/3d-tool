import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const BUCKET = "product-assets";

/**
 * Downloads a file from storage and re-uploads it under the new product's path.
 * Returns the new public URL, or null if the copy fails.
 */
async function copyAssetToNewProduct(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  sourceUrl: string,
  newUserId: string,
  newProductId: string,
  fileType: "surface" | "texture"
): Promise<string | null> {
  try {
    const marker = `/${BUCKET}/`;
    const markerIdx = sourceUrl.indexOf(marker);
    if (markerIdx === -1) return null;
    // Strip query params from path
    const srcPath = sourceUrl.slice(markerIdx + marker.length).split("?")[0];

    const { data: fileData, error: downloadError } = await supabase.storage
      .from(BUCKET)
      .download(srcPath);

    if (downloadError || !fileData) {
      console.error("Clone: failed to download asset:", downloadError);
      return null;
    }

    const ext = srcPath.split(".").pop() || "jpg";
    const fileName = fileType === "texture" ? `texture.${ext}` : `surface.${ext}`;
    const newPath = `${newUserId}/${newProductId}/${fileName}`;

    const buffer = new Uint8Array(await fileData.arrayBuffer());
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(newPath, buffer, { contentType: fileData.type, upsert: true });

    if (uploadError) {
      console.error("Clone: failed to upload copied asset:", uploadError);
      return null;
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(newPath);
    return urlData.publicUrl;
  } catch (err) {
    console.error("Clone: copyAssetToNewProduct error:", err);
    return null;
  }
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

    // Create new product first (surface/texture URLs will be updated after file copy)
    const { data: cloned, error: cloneError } = await supabase
      .from("products")
      .insert({
        user_id: user.id,
        name: `${source.name} (bản sao)`,
        type: source.type,
        surface_url: null,
        texture_type: source.texture_type,
        texture_url: null,
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

    // Copy surface and texture files into the new product's storage folder
    const urlUpdates: Record<string, string> = {};

    if (source.surface_url) {
      const newUrl = await copyAssetToNewProduct(
        supabase, source.surface_url, user.id, cloned.id, "surface"
      );
      if (newUrl) urlUpdates.surface_url = newUrl;
    }

    if (source.texture_url) {
      const newUrl = await copyAssetToNewProduct(
        supabase, source.texture_url, user.id, cloned.id, "texture"
      );
      if (newUrl) urlUpdates.texture_url = newUrl;
    }

    if (Object.keys(urlUpdates).length > 0) {
      const { data: updated, error: updateError } = await supabase
        .from("products")
        .update({ ...urlUpdates, updated_at: new Date().toISOString() })
        .eq("id", cloned.id)
        .select()
        .single();

      if (updateError) {
        console.error("Clone: failed to update product URLs:", updateError);
        return NextResponse.json(cloned, { status: 201 });
      }

      return NextResponse.json(updated, { status: 201 });
    }

    return NextResponse.json(cloned, { status: 201 });
  } catch (error) {
    console.error("POST /api/products/[id]/clone error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
