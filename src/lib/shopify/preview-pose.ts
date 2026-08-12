/**
 * Preview-pose extraction.
 *
 * The storefront product page shows a static 2D mockup and then silently layers
 * a 3D canvas over it at the SAME camera angle, so the customer never notices
 * the swap. That only works if the image is something a single 3D view can
 * actually reproduce.
 *
 * Most Mockup-Web references are NOT reproducible: the real Mockup-Web-1 is a
 * composite of three cues at three different angles, offset and rotated ~-42°
 * inside the canvas. Overlaying one 3D cue on that would look broken, so this
 * module deliberately REFUSES such references (returns null → the page just
 * stays 2D) instead of writing a pose that cannot line up.
 *
 * To opt an image into the swap, give its reference one of PREVIEW_POSE_NAMES
 * and build it as a single full-canvas, unrotated cue frame.
 */

import {
  isCueFrame,
  STUDIO_WHITE_HDRI,
  type CueFrame,
  type ExtractorReference,
  type HdriLayer,
} from "@/types/extractor";
import type { PreviewPose, PreviewPoseHdri } from "@/types/product";

/**
 * Reference names that opt an image into the 2D → 3D swap, most preferred
 * first. A dedicated reference is required because the generic Mockup-Web-N
 * images are art-directed composites, not single-camera renders.
 */
export const PREVIEW_POSE_NAMES = ["Preview-3D", "Mockup-Web-3D"];

/** The render pipeline always orbits at this radius (setCameraPhi's default). */
const RENDER_DISTANCE = 2;

/** Frame offset/rotation tolerated before the overlay would visibly misalign. */
const MAX_OFFSET_PX = 8;
const MAX_ROTATION_DEG = 0.5;
/** Frame may differ from the canvas by this fraction and still count as full. */
const SIZE_TOLERANCE = 0.02;

/** Number(null) is 0, so null/""/undefined must be rejected before coercing —
 *  otherwise a missing zoom becomes 0 and the renderer's `50 / zoom` yields
 *  Infinity, which silently destroys the camera. */
function finite(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Zoom feeds `fov = 50 / zoom`, so zero and negatives are never valid. */
function positive(value: unknown, fallback: number): number {
  const n = finite(value, fallback);
  return n > 0 ? n : fallback;
}

/** Why a reference cannot drive the swap — surfaced so deploys can log it. */
export type PoseRejection =
  | "no-cue-frame"
  | "multiple-cue-frames"
  | "frame-not-full-canvas"
  | "frame-rotated"
  | "studio-snapshot";

export interface PoseEligibility {
  eligible: boolean;
  reason?: PoseRejection;
  detail?: string;
}

/**
 * Decide whether a reference renders a single, reproducible camera view.
 *
 * Every rejection here corresponds to a real way the overlay breaks:
 *  - multiple cue frames  → the image shows several cues; 3D can only show one
 *  - partial/offset frame → the cue sits in part of the canvas, 3D fills it all
 *  - rotated frame        → the canvas draw is rotated; the 3D camera is not
 *  - studio snapshot      → the camera came from the snapshot, so the stored
 *                           phi/zoom are stale values that describe nothing
 */
export function checkPoseEligibility(reference: ExtractorReference): PoseEligibility {
  const cueFrames = reference.frames.filter(isCueFrame);

  if (cueFrames.length === 0) return { eligible: false, reason: "no-cue-frame" };
  if (cueFrames.length > 1) {
    return {
      eligible: false,
      reason: "multiple-cue-frames",
      detail: `${cueFrames.length} cue frames — a single 3D view cannot match a composite`,
    };
  }

  const frame = cueFrames[0];
  if (frame.cue.studioShadow?.studioConfigSnapshot) {
    return {
      eligible: false,
      reason: "studio-snapshot",
      detail: "rendered via studio snapshot, so cue.phi/zoom do not describe the camera",
    };
  }

  const canvasW = finite(reference.canvasWidth, 2048);
  const canvasH = finite(reference.canvasHeight, 2048);
  const t = frame.transform;

  if (Math.abs(finite(t.rotation, 0)) > MAX_ROTATION_DEG) {
    return {
      eligible: false,
      reason: "frame-rotated",
      detail: `frame rotated ${finite(t.rotation, 0).toFixed(1)}°`,
    };
  }

  const offsetOk =
    Math.abs(finite(t.x, 0)) <= MAX_OFFSET_PX && Math.abs(finite(t.y, 0)) <= MAX_OFFSET_PX;
  const sizeOk =
    Math.abs(finite(t.width, 0) - canvasW) <= canvasW * SIZE_TOLERANCE &&
    Math.abs(finite(t.height, 0) - canvasH) <= canvasH * SIZE_TOLERANCE;

  if (!offsetOk || !sizeOk) {
    return {
      eligible: false,
      reason: "frame-not-full-canvas",
      detail:
        `frame ${Math.round(finite(t.width, 0))}×${Math.round(finite(t.height, 0))} ` +
        `at (${Math.round(finite(t.x, 0))},${Math.round(finite(t.y, 0))}) ` +
        `vs canvas ${Math.round(canvasW)}×${Math.round(canvasH)}`,
    };
  }

  return { eligible: true };
}

/**
 * Pick the reference that should drive the 3D swap.
 *
 * Only the opt-in names are considered, and only if they pass eligibility —
 * there is intentionally no "fall back to the first mockup", because that is
 * exactly how a composite image would get a pose it cannot honour.
 */
export function pickPoseReference(
  references: ExtractorReference[],
): ExtractorReference | null {
  for (const name of PREVIEW_POSE_NAMES) {
    const match = references.find(
      (ref) => ref.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (match && checkPoseEligibility(match).eligible) return match;
  }
  return null;
}

/**
 * Lighting of the rendered frame, in the renderer's layer order.
 *
 * Studio-white layers are dropped: they are a flat synthetic light with no
 * equirectangular texture, so the storefront (which only loads real .hdr files)
 * cannot reproduce them and would be better off with the next real layer.
 *
 * Falls back to the legacy single `lightAngle` field, which older frames used
 * before multi-layer HDRI existed — that angle was a Y rotation.
 */
function hdriFromCue(cue: CueFrame["cue"]): PreviewPoseHdri[] | undefined {
  const layers: HdriLayer[] = Array.isArray(cue.hdriLayers) ? cue.hdriLayers : [];
  const usable = layers.filter(
    (l) => l && l.enabled !== false && l.hdriType && l.hdriType !== STUDIO_WHITE_HDRI,
  );

  if (usable.length) {
    return usable.map((l) => ({
      hdriType: String(l.hdriType),
      rotationX: finite(l.rotationX, 0),
      rotationY: finite(l.rotationY, 0),
      intensity: positive(l.intensity, 1),
    }));
  }

  if (cue.hdriType && cue.hdriType !== STUDIO_WHITE_HDRI) {
    return [{
      hdriType: String(cue.hdriType),
      rotationX: 0,
      rotationY: finite(cue.lightAngle, 0),
      intensity: 1,
    }];
  }

  return undefined;
}

function poseFromFrame(
  frame: CueFrame,
  reference: ExtractorReference,
  imageUrl: string | null,
): PreviewPose {
  const cue = frame.cue;
  return {
    version: 1,
    spinY: finite(cue.spinY, 0),
    phi: finite(cue.phi, Math.PI / 2),
    zoom: positive(cue.zoom, 1),
    offsetX: finite(cue.offsetX, 0),
    offsetY: finite(cue.offsetY, 0),
    distance: RENDER_DISTANCE,
    hdri: hdriFromCue(cue),
    imageName: reference.name || null,
    imageUrl,
  };
}

/**
 * Extract the pose of a reference's cue frame, or null when that reference
 * cannot be reproduced by a single 3D view (see checkPoseEligibility).
 */
export function extractPreviewPose(
  reference: ExtractorReference | null,
  options?: { imageUrl?: string | null; onReject?: (e: PoseEligibility) => void },
): PreviewPose | null {
  if (!reference) return null;

  const eligibility = checkPoseEligibility(reference);
  if (!eligibility.eligible) {
    options?.onReject?.(eligibility);
    return null;
  }

  const frame = reference.frames.filter(isCueFrame)[0];
  return poseFromFrame(frame, reference, options?.imageUrl ?? null);
}

/**
 * Resolve the pose for a deploy: find the opted-in reference and pair it with
 * the public URL of the image it rendered.
 *
 * Returns null when no reference opted in — the storefront then shows the
 * normal 2D gallery with no 3D overlay, which is the correct behaviour for
 * art-directed composite mockups.
 */
export function buildPreviewPose(
  references: ExtractorReference[],
  imageUrlByRefName?: Map<string, string>,
): PreviewPose | null {
  const chosen = pickPoseReference(references);
  if (!chosen) return null;
  const imageUrl = imageUrlByRefName?.get(chosen.name.trim().toLowerCase()) ?? null;
  return extractPreviewPose(chosen, { imageUrl });
}
