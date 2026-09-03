/**
 * DB row -> ExtractorReference mapping, shared by the references API and the
 * render-job payload builder. Kept in one place so a render on the GPU sees
 * exactly the layout the editor sees — a divergence here would silently shift
 * frames in server-rendered mockups only.
 */

import type {
  CueFrame,
  ExtractorFrame,
  ExtractorReference,
  ImageFrame,
} from "@/types/extractor";
import { DEFAULT_CANVAS_HEIGHT, DEFAULT_CANVAS_WIDTH } from "@/types/extractor";

/** The select() list every reference read uses, frames included. */
export const REFERENCE_WITH_FRAMES_COLUMNS = `
  id,
  user_id,
  name,
  thumb_url,
  canvas_width,
  canvas_height,
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
`;

interface FrameRow {
  id: string;
  frame_order: number;
  frame_type: string | null;
  frame_name: string | null;
  pos_x: number;
  pos_y: number;
  width: number;
  height: number;
  rotation: number;
  cue_orbit_x: number | null;
  cue_orbit_y: number | null;
  cue_zoom: number;
  cue_offset_x: number;
  cue_offset_y: number;
  light_angle: number | null;
  hdri_layers: CueFrame["cue"]["hdriLayers"] | null;
  image_settings: ImageFrame["imageSettings"] | null;
  shadow_config: CueFrame["cue"]["studioShadow"] | null;
}

export interface ReferenceRow {
  id: string;
  user_id?: string | null;
  name: string;
  thumb_url: string | null;
  canvas_width: number | null;
  canvas_height: number | null;
  created_at?: string;
  updated_at?: string;
  extractor_frames: FrameRow[] | null;
}

const DEFAULT_IMAGE_SETTINGS: ImageFrame["imageSettings"] = {
  imageUrl: null,
  backgroundColor: "#ffffff",
  objectFit: "cover",
  rotation3d: { x: 0, y: 0, z: 0 },
  opacity: 1,
  blendMode: "normal",
} as ImageFrame["imageSettings"];

function mapFrame(f: FrameRow): ExtractorFrame {
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

  if ((f.frame_type || "cue") === "image") {
    return {
      ...baseFrame,
      frameType: "image" as const,
      imageSettings: f.image_settings ?? DEFAULT_IMAGE_SETTINGS,
    } as ImageFrame;
  }

  // Legacy rows stored a single lightAngle instead of HDRI layers; synthesize
  // the default layer so old references still light correctly.
  let hdriLayers = f.hdri_layers;
  if (!hdriLayers || (Array.isArray(hdriLayers) && hdriLayers.length === 0)) {
    hdriLayers = [
      {
        id: crypto.randomUUID(),
        hdriType: "bloem_train_track_clear_2k.hdr",
        rotationX: 0,
        rotationY: f.light_angle ?? 0,
      },
    ] as CueFrame["cue"]["hdriLayers"];
  }

  return {
    ...baseFrame,
    frameType: "cue" as const,
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
}

export function mapReferenceRow(row: ReferenceRow): ExtractorReference {
  return {
    id: row.id,
    name: row.name,
    thumbUrl: row.thumb_url ?? undefined,
    canvasWidth: row.canvas_width ?? DEFAULT_CANVAS_WIDTH,
    canvasHeight: row.canvas_height ?? DEFAULT_CANVAS_HEIGHT,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    frames: (row.extractor_frames ?? [])
      .slice()
      .sort((a, b) => a.frame_order - b.frame_order)
      .map(mapFrame),
  };
}
