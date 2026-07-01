import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_SILVER_GLOBAL, type SilverGlobalConfig } from "@/lib/three/silver-coating";

// Single global "Phủ bạc" config shared by ALL products, stored as one row in
// the threejs_settings table keyed by this name.
const SILVER_CONFIG_NAME = "silver_frost_global";

function coerce(raw: unknown): SilverGlobalConfig {
  const r = (raw ?? {}) as Partial<SilverGlobalConfig>;
  const clamp = (v: unknown, min: number, max: number, fallback: number) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  return {
    density: clamp(r.density, 0, 100, DEFAULT_SILVER_GLOBAL.density),
    metalness: clamp(r.metalness, 0, 1, DEFAULT_SILVER_GLOBAL.metalness),
    normalScale: clamp(r.normalScale, 0, 2, DEFAULT_SILVER_GLOBAL.normalScale),
  };
}

// GET /api/silver-config — load the global silver config (falls back to default).
export async function GET() {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("threejs_settings")
      .select("settings")
      .eq("name", SILVER_CONFIG_NAME)
      .single();

    if (error || !data) {
      return NextResponse.json(DEFAULT_SILVER_GLOBAL);
    }
    return NextResponse.json(coerce(data.settings));
  } catch (err) {
    console.error("GET /api/silver-config error:", err);
    return NextResponse.json(DEFAULT_SILVER_GLOBAL);
  }
}

// POST /api/silver-config — save the global silver config (upsert single row).
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const body = await request.json();
    const config = coerce(body);

    const { error } = await supabase
      .from("threejs_settings")
      .upsert(
        { name: SILVER_CONFIG_NAME, settings: config, updated_at: new Date().toISOString() },
        { onConflict: "name" }
      );

    if (error) {
      console.error("Save silver-config error:", error);
      return NextResponse.json({ error: "Failed to save silver config" }, { status: 500 });
    }
    return NextResponse.json({ success: true, config });
  } catch (err) {
    console.error("POST /api/silver-config error:", err);
    return NextResponse.json({ error: "Failed to save silver config" }, { status: 500 });
  }
}
