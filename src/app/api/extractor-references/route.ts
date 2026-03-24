import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ExtractorReference, ExtractorFrame } from "@/types/extractor";

// GET /api/extractor-references - List all user's references
export async function GET() {
  try {
    const supabase = await createClient();
    
    // Get current user
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch references with frames
    const { data: references, error } = await supabase
      .from("extractor_references")
      .select(`
        id,
        name,
        created_at,
        updated_at,
        extractor_frames (
          id,
          frame_order,
          pos_x,
          pos_y,
          width,
          height,
          rotation,
          cue_orbit_x,
          cue_orbit_y,
          cue_zoom,
          cue_offset_x,
          cue_offset_y,
          light_angle
        )
      `)
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("Fetch references error:", error);
      return NextResponse.json({ error: "Failed to fetch references" }, { status: 500 });
    }

    // Transform to match our types
    const result: ExtractorReference[] = (references || []).map((ref) => ({
      id: ref.id,
      name: ref.name,
      createdAt: ref.created_at,
      updatedAt: ref.updated_at,
      frames: (ref.extractor_frames || [])
        .sort((a: any, b: any) => a.frame_order - b.frame_order)
        .map((f: any) => ({
          id: f.id,
          order: f.frame_order,
          transform: {
            x: f.pos_x,
            y: f.pos_y,
            width: f.width,
            height: f.height,
            rotation: f.rotation,
          },
          cue: {
            orbitX: f.cue_orbit_x,
            orbitY: f.cue_orbit_y,
            zoom: f.cue_zoom,
            offsetX: f.cue_offset_x,
            offsetY: f.cue_offset_y,
            lightAngle: f.light_angle,
          },
        })),
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/extractor-references error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/extractor-references - Create new reference
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { name, frames } = body as { name: string; frames: ExtractorFrame[] };

    if (!name || !frames || !Array.isArray(frames)) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    // Create reference
    const { data: reference, error: refError } = await supabase
      .from("extractor_references")
      .insert({ user_id: user.id, name })
      .select()
      .single();

    if (refError || !reference) {
      console.error("Create reference error:", refError);
      return NextResponse.json({ error: "Failed to create reference" }, { status: 500 });
    }

    // Create frames
    const frameRows = frames.map((f, idx) => ({
      reference_id: reference.id,
      frame_order: f.order ?? idx,
      pos_x: f.transform.x,
      pos_y: f.transform.y,
      width: f.transform.width,
      height: f.transform.height,
      rotation: f.transform.rotation,
      cue_orbit_x: f.cue.orbitX,
      cue_orbit_y: f.cue.orbitY,
      cue_zoom: f.cue.zoom,
      cue_offset_x: f.cue.offsetX,
      cue_offset_y: f.cue.offsetY,
      light_angle: f.cue.lightAngle,
    }));

    const { error: framesError } = await supabase
      .from("extractor_frames")
      .insert(frameRows);

    if (framesError) {
      console.error("Create frames error:", framesError);
      // Rollback reference
      await supabase.from("extractor_references").delete().eq("id", reference.id);
      return NextResponse.json({ error: "Failed to create frames" }, { status: 500 });
    }

    return NextResponse.json({ id: reference.id, name: reference.name });
  } catch (error) {
    console.error("POST /api/extractor-references error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
