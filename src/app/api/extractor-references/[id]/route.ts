import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ExtractorFrame } from "@/types/extractor";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/extractor-references/[id] - Get single reference
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: reference, error } = await supabase
      .from("extractor_references")
      .select(`
        id, name, created_at, updated_at,
        extractor_frames (*)
      `)
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (error || !reference) {
      return NextResponse.json({ error: "Reference not found" }, { status: 404 });
    }

    const result = {
      id: reference.id,
      name: reference.name,
      createdAt: reference.created_at,
      updatedAt: reference.updated_at,
      frames: (reference.extractor_frames || [])
        .sort((a: any, b: any) => a.frame_order - b.frame_order)
        .map((f: any) => ({
          id: f.id,
          order: f.frame_order,
          transform: { x: f.pos_x, y: f.pos_y, width: f.width, height: f.height, rotation: f.rotation },
          cue: { orbitX: f.cue_orbit_x, orbitY: f.cue_orbit_y, zoom: f.cue_zoom, offsetX: f.cue_offset_x, offsetY: f.cue_offset_y, lightAngle: f.light_angle },
        })),
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/extractor-references/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/extractor-references/[id] - Update reference
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { name, frames } = body as { name?: string; frames?: ExtractorFrame[] };

    // Verify ownership
    const { data: existing } = await supabase
      .from("extractor_references")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "Reference not found" }, { status: 404 });
    }

    // Update name if provided
    if (name) {
      await supabase
        .from("extractor_references")
        .update({ name, updated_at: new Date().toISOString() })
        .eq("id", id);
    }

    // Update frames if provided
    if (frames && Array.isArray(frames)) {
      // Delete existing frames
      await supabase.from("extractor_frames").delete().eq("reference_id", id);

      // Insert new frames
      const frameRows = frames.map((f, idx) => ({
        reference_id: id,
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

      await supabase.from("extractor_frames").insert(frameRows);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("PUT /api/extractor-references/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/extractor-references/[id] - Delete reference
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { error } = await supabase
      .from("extractor_references")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/extractor-references/[id] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
