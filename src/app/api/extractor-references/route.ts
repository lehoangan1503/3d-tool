import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ExtractorReference, ExtractorFrame, CueFrame, ImageFrame } from "@/types/extractor";
import { isCueFrame, isImageFrame } from "@/types/extractor";

// GET /api/extractor-references - List user's references with pagination + search
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    
    // Get current user
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit  = Math.min(parseInt(searchParams.get("limit")  ?? "40", 10), 100);
    const offset = Math.max(parseInt(searchParams.get("offset") ?? "0",  10), 0);
    const search = (searchParams.get("search") ?? "").trim();

    // Fetch references with frames
    let query = supabase
      .from("extractor_references")
      .select(`
        id,
        name,
        thumb_url,
        created_at,
        updated_at,
        extractor_frames (
          id,
          frame_order,
          frame_type,
          frame_name,
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
          light_angle,
          hdri_layers,
          image_settings,
          shadow_config
        )
      `, { count: "exact" })
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.ilike("name", `%${search}%`);
    }

    const { data: references, error, count } = await query;

    if (error) {
      console.error("Fetch references error:", error);
      return NextResponse.json({ error: "Failed to fetch references" }, { status: 500 });
    }

    // Transform to match our types - handle both cue and image frame types
    const result: ExtractorReference[] = (references || []).map((ref: any) => ({
      id: ref.id,
      name: ref.name,
      thumbUrl: ref.thumb_url ?? undefined,
      createdAt: ref.created_at,
      updatedAt: ref.updated_at,
      frames: (ref.extractor_frames || [])
        .sort((a: any, b: any) => a.frame_order - b.frame_order)
        .map((f: any): ExtractorFrame => {
          const frameType = f.frame_type || 'cue';
          
          const baseFrame = {
            id: f.id,
            name: f.frame_name ?? undefined,
            order: f.frame_order,
            transform: {
              x: f.pos_x,
              y: f.pos_y,
              width: f.width,
              height: f.height,
              rotation: f.rotation,
            },
          };
          
          if (frameType === 'image') {
            // Image frame
            return {
              ...baseFrame,
              frameType: 'image' as const,
              imageSettings: f.image_settings || {
                imageUrl: null,
                backgroundColor: '#ffffff',
                objectFit: 'cover',
                rotation3d: { x: 0, y: 0, z: 0 },
                opacity: 1,
                blendMode: 'normal',
              },
            } as ImageFrame;
          }
          
          // Cue frame (default)
          let hdriLayers = f.hdri_layers;
          if (!hdriLayers || (Array.isArray(hdriLayers) && hdriLayers.length === 0)) {
            // Migrate old format to new
            hdriLayers = [{
              id: crypto.randomUUID(),
              hdriType: 'bloem_train_track_clear_2k.hdr',
              rotationX: 0,
              rotationY: f.light_angle ?? 0,
            }];
          }
          
          return {
            ...baseFrame,
            frameType: 'cue' as const,
            cue: {
              spinY: f.cue_orbit_x ?? 0,
              phi: f.cue_orbit_y ?? Math.PI / 2,
              zoom: f.cue_zoom,
              offsetX: f.cue_offset_x,
              offsetY: f.cue_offset_y,
              hdriLayers,
              lightAngle: f.light_angle,
              studioShadow: f.shadow_config ?? undefined,
            },
          } as CueFrame;
        }),
    }));

    return NextResponse.json({ items: result, total: count ?? 0 });
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

    // Create frames - handle both cue and image frame types
    const frameRows = frames.map((f, idx) => {
      const baseRow = {
        reference_id: reference.id,
        frame_order: f.order ?? idx,
        frame_type: f.frameType,
        frame_name: f.name ?? null,
        pos_x: f.transform.x,
        pos_y: f.transform.y,
        width: f.transform.width,
        height: f.transform.height,
        rotation: f.transform.rotation,
      };
      
      if (isCueFrame(f)) {
        return {
          ...baseRow,
          cue_orbit_x: f.cue.spinY,
          cue_orbit_y: f.cue.phi,
          cue_zoom: f.cue.zoom,
          cue_offset_x: f.cue.offsetX,
          cue_offset_y: f.cue.offsetY,
          light_angle: f.cue.hdriLayers?.[0]?.rotationY ?? f.cue.lightAngle ?? 0,
          hdri_layers: f.cue.hdriLayers,
          image_settings: null,
          shadow_config: f.cue.studioShadow ?? null,
        };
      } else if (isImageFrame(f)) {
        return {
          ...baseRow,
          cue_orbit_x: 0,
          cue_orbit_y: Math.PI / 2,
          cue_zoom: 1,
          cue_offset_x: 0,
          cue_offset_y: 0,
          light_angle: 0,
          hdri_layers: null,
          image_settings: f.imageSettings,
        };
      }
      
      return baseRow;
    });

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
