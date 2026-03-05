import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_THREEJS_SETTINGS, DEFAULT_LEATHER_SETTINGS } from "@/types/settings";

// GET /api/settings - Get Three.js settings
export async function GET() {
  try {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("threejs_settings")
      .select("name, settings");

    if (error) {
      console.error("Settings fetch error:", error);
      // Return default settings if table doesn't exist or error
      return NextResponse.json({
        default: DEFAULT_THREEJS_SETTINGS,
        leather: DEFAULT_LEATHER_SETTINGS,
      });
    }

    // Transform array to object
    const settings: Record<string, unknown> = {
      default: DEFAULT_THREEJS_SETTINGS,
      leather: DEFAULT_LEATHER_SETTINGS,
    };

    data?.forEach((row) => {
      settings[row.name] = row.settings;
    });

    return NextResponse.json(settings);
  } catch (error) {
    console.error("GET /api/settings error:", error);
    // Return defaults on error
    return NextResponse.json({
      default: DEFAULT_THREEJS_SETTINGS,
      leather: DEFAULT_LEATHER_SETTINGS,
    });
  }
}
