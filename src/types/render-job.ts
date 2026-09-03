import type { ExtractorReference } from "@/types/extractor";
import type { VideoStudioConfig } from "@/types/video-studio";
import type {
  LeatherColor,
  LeatherTextureType,
  ProductConfig,
  ProductType,
  ShaftConfig,
  SurfaceSlotsConfig,
} from "@/types/product";

/** What a job produces: mockup PNGs, or a studio video. */
export type RenderJobKind = "image" | "video";

export type RenderJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

/** Where the pixels were produced. "local" is a dev worker on the operator's machine. */
export type RenderWorkerProvider = "runpod" | "beam" | "modal" | "local";

/**
 * The product data a worker needs to rebuild the 3D scene. Copied into the job
 * payload at enqueue time so the worker never touches the caller's session and
 * an old job re-renders identically even after the product is edited.
 */
export interface RenderJobProduct {
  id: string;
  name: string;
  /** Picks the GLB via MODEL_PATHS, exactly as loadProductIntoEsm does. */
  type: ProductType;
  /** Flat surface design: the cue texture AND what dynamic-surface frames draw. */
  surfaceUrl: string | null;
  textureType: LeatherTextureType | null;
  textureUrl: string | null;
  color: LeatherColor | null;
  /**
   * Material/lighting settings, already resolved from
   * /api/products/[id]/settings. Inlined because the worker has no session and
   * must not call an authenticated endpoint.
   */
  config: ProductConfig | null;
  /** Per-slot surface designs, when the product uses surface slots. */
  surfaceSlots: SurfaceSlotsConfig | null;
  shaftConfig: ShaftConfig | null;
}

/** Frozen input for an image job: render every reference, in this order. */
export interface RenderImagePayload {
  kind: "image";
  product: RenderJobProduct;
  groupId: string;
  groupName: string;
  /** Fully resolved references — the worker does no DB reads of its own. */
  references: ExtractorReference[];
  /** PNG unless the caller asked for JPEG to shrink Shopify uploads. */
  format: "png" | "jpeg";
  /** JPEG quality 0-1; ignored for PNG. */
  quality: number;
}

/** Frozen input for a video job. */
export interface RenderVideoPayload {
  kind: "video";
  product: RenderJobProduct;
  templateId: string;
  templateName: string;
  config: VideoStudioConfig;
  width: number;
  height: number;
  fps: number;
}

export type RenderJobPayload = RenderImagePayload | RenderVideoPayload;

export function isImagePayload(p: RenderJobPayload): p is RenderImagePayload {
  return p.kind === "image";
}

export function isVideoPayload(p: RenderJobPayload): p is RenderVideoPayload {
  return p.kind === "video";
}

/** One finished file in Supabase Storage. */
export interface RenderJobOutput {
  /** Reference/template name — the gallery order key (Mockup-Web-1, ...). */
  name: string;
  url: string;
  storagePath: string;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
  /** Set when a single reference in a batch failed but the rest succeeded. */
  error?: string;
}

export interface RenderJob {
  id: string;
  userId: string;
  productId: string | null;
  productName: string | null;
  kind: RenderJobKind;
  groupId: string | null;
  templateId: string | null;
  status: RenderJobStatus;
  progressDone: number;
  progressTotal: number;
  progressLabel: string | null;
  outputs: RenderJobOutput[];
  errorMessage: string | null;
  workerProvider: RenderWorkerProvider | null;
  workerJobId: string | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** When the Storage output is deleted. Null while queued/running, and on
   *  jobs that finished before retention existed. */
  expiresAt: string | null;
  /** Set once the files were deleted and `outputs` emptied — the difference
   *  between "results expired, render again" and "this job made nothing". */
  purgedAt: string | null;
}

/** POST /api/products/[productId]/renders — body. */
export interface CreateImageRenderRequest {
  groupId: string;
  /** Batch: render this group for several products at once (defaults to the URL's product). */
  productIds?: string[];
  format?: "png" | "jpeg";
  quality?: number;
}

/** POST /api/products/[productId]/videos — body. */
export interface CreateVideoRenderRequest {
  templateId: string;
  productIds?: string[];
  width?: number;
  height?: number;
  fps?: number;
}

export interface CreateRenderResponse {
  jobs: RenderJob[];
}

/** The shape a GPU worker gets back when it claims a job. */
export interface ClaimedRenderJob {
  id: string;
  kind: RenderJobKind;
  userId: string;
  productId: string | null;
  payload: RenderJobPayload;
  attempts: number;
  leaseUntil: string | null;
}

/** PATCH /api/render-jobs/[id]/progress — worker heartbeat. */
export interface RenderProgressUpdate {
  done: number;
  total: number;
  label?: string;
}

/** POST /api/render-jobs/[id]/complete — worker result. */
export interface RenderCompleteRequest {
  status: "succeeded" | "failed";
  outputs?: RenderJobOutput[];
  errorMessage?: string;
}
