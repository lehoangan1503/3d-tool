import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_IMAGE_EXTRACTOR_PRESET } from "@/types/extractor";

const PRESET_NAME = "image_extractor_preset";

// GET /api/extractor-presets - Load saved preset
export async function GET() {
  try {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("threejs_settings")
      .select("settings")
      .eq("name", PRESET_NAME)
      .single();

    if (error || !data) {
      // Return default if not found
      return NextResponse.json(DEFAULT_IMAGE_EXTRACTOR_PRESET);
    }

    return NextResponse.json(data.settings);
  } catch (error) {
    console.error("GET /api/extractor-presets error:", error);
    return NextResponse.json(DEFAULT_IMAGE_EXTRACTOR_PRESET);
  }
}

// POST /api/extractor-presets - Save preset
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const preset = await request.json();

    // Upsert the preset (insert or update)
    const { error } = await supabase
      .from("threejs_settings")
      .upsert(
        { name: PRESET_NAME, settings: preset, updated_at: new Date().toISOString() },
        { onConflict: "name" }
      );

    if (error) {
      console.error("Save preset error:", error);
      return NextResponse.json({ error: "Failed to save preset" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("POST /api/extractor-presets error:", error);
    return NextResponse.json({ error: "Failed to save preset" }, { status: 500 });
  }
}
