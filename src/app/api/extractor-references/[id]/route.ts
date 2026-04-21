import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ExtractorFrame, CueFrame, ImageFrame } from "@/types/extractor";
import { isCueFrame, isImageFrame } from "@/types/extractor";

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
        id, name, thumb_url, canvas_width, canvas_height, created_at, updated_at,
        extractor_frames (*, frame_name)
      `)
      .eq("id", id)
      .single();

    if (error || !reference) {
      return NextResponse.json({ error: "Reference not found" }, { status: 404 });
    }

    // Map DB fields to discriminated union (cue or image frame)
    const result = {
      id: reference.id,
      name: reference.name,
      thumbUrl: (reference as any).thumb_url ?? undefined,
      canvasWidth: (reference as any).canvas_width ?? 2048,
      canvasHeight: (reference as any).canvas_height ?? 2048,
      createdAt: reference.created_at,
      updatedAt: reference.updated_at,
      frames: (reference.extractor_frames || [])
        .sort((a: any, b: any) => a.frame_order - b.frame_order)
        .map((f: any): ExtractorFrame => {
          const frameType = f.frame_type || 'cue';
          
          const baseFrame = {
            id: f.id,
            name: f.frame_name ?? undefined,
            order: f.frame_order,
            transform: { x: f.pos_x, y: f.pos_y, width: f.width, height: f.height, rotation: f.rotation },
          };
          
          if (frameType === 'image') {
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
          
          // Cue frame
          let hdriLayers = f.hdri_layers;
          if (!hdriLayers || (Array.isArray(hdriLayers) && hdriLayers.length === 0)) {
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
    const { name, frames, canvasWidth, canvasHeight } = body as { name?: string; frames?: ExtractorFrame[]; canvasWidth?: number; canvasHeight?: number };

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

    // Update name and/or canvas dims if provided
    if (name || canvasWidth !== undefined || canvasHeight !== undefined) {
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (name) updates.name = name;
      if (canvasWidth !== undefined) updates.canvas_width = canvasWidth;
      if (canvasHeight !== undefined) updates.canvas_height = canvasHeight;
      await supabase
        .from("extractor_references")
        .update(updates)
        .eq("id", id);
    }

    // Update frames if provided - handle both cue and image types
    if (frames && Array.isArray(frames)) {
      // Delete existing frames
      await supabase.from("extractor_frames").delete().eq("reference_id", id);

      // Insert new frames
      const frameRows = frames.map((f, idx) => {
        const baseRow = {
          reference_id: id,
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
