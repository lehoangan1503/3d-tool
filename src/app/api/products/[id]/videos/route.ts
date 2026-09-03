import { NextResponse } from "next/server";
import {
  buildVideoPayload,
  loadRenderProducts,
  loadVideoTemplate,
  RenderPayloadError,
} from "@/lib/render/build-payload";
import {
  errorResponse,
  insertAndDispatch,
  requireUser,
  resolveProductIds,
  type JobSeed,
} from "@/lib/render/enqueue";
import { attachProductNames, RENDER_JOB_COLUMNS, type RenderJobRow } from "@/lib/render/job-mapper";
import type { CreateVideoRenderRequest } from "@/types/render-job";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Recording resolutions the worker's headless Chrome is sized for. */
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 2560;

/**
 * POST /api/products/[id]/videos
 *
 * Queues a studio video render from a saved video_studio_templates config.
 * Unlike images, video recording needs a real Chrome (MediaRecorder +
 * canvas.captureStream), which is exactly what the GPU worker runs — so the
 * template renders on the rented card instead of the operator's laptop.
 *
 * Body: { templateId, productIds?, width?, height?, fps? }
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireUser();
    if (!auth.ok) return auth.response;

    const body = (await request.json()) as CreateVideoRenderRequest;
    if (!body?.templateId) {
      return NextResponse.json({ error: "templateId is required" }, { status: 400 });
    }

    const width = Math.min(Math.max(body.width ?? 1920, 320), MAX_WIDTH);
    const height = Math.min(Math.max(body.height ?? 1080, 320), MAX_HEIGHT);
    const fps = Math.min(Math.max(body.fps ?? 60, 24), 120);

    const productIds = resolveProductIds(id, body.productIds);
    // Video is far heavier than a mockup (minutes of GPU per clip), so the
    // batch cap is tighter than the image endpoint's.
    if (productIds.length > 10) {
      return NextResponse.json(
        { error: "Too many products in one request (max 10 for video)" },
        { status: 400 }
      );
    }

    const [products, template] = await Promise.all([
      loadRenderProducts(auth.ctx.supabase, productIds),
      loadVideoTemplate(auth.ctx.supabase, body.templateId),
    ]);

    const seeds: JobSeed[] = products.map((product) => ({
      productId: product.id,
      groupId: null,
      templateId: body.templateId,
      payload: buildVideoPayload(
        product,
        body.templateId,
        template.templateName,
        template.config,
        width,
        height,
        fps
      ),
      // Video progress is a percentage, not a frame count.
      progressTotal: 100,
    }));

    const result = await insertAndDispatch(auth.ctx, request, "video", seeds);

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error, "POST /api/products/[id]/videos");
  }
}

/** GET /api/products/[id]/videos — this product's recent video jobs. */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireUser();
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 100);

    const { data, error } = await auth.ctx.supabase
      .from("render_jobs")
      .select<RenderJobRow>(RENDER_JOB_COLUMNS)
      .eq("product_id", id)
      .eq("kind", "video")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new RenderPayloadError(`Failed to list video jobs: ${error.message}`, 500);
    }

    const jobs = await attachProductNames(auth.ctx.supabase, data ?? []);
    return NextResponse.json({ jobs });
  } catch (error) {
    return errorResponse(error, "GET /api/products/[id]/videos");
  }
}
