import { NextResponse } from "next/server";
import {
  buildImagePayload,
  loadGroupReferences,
  loadRenderProducts,
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
import type { CreateImageRenderRequest } from "@/types/render-job";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/products/[id]/renders
 *
 * Queues server-side mockup rendering for an image group. Replaces the browser
 * loop in the deploy dialog: instead of the operator's GPU rendering 6 mockups
 * over half a minute, the caller gets job ids back immediately and polls
 * /api/render-jobs/[jobId].
 *
 * Body: { groupId, productIds?, referenceIds?, format?, quality? }
 *   groupId      — extractor_reference_groups.id ("NOVERA-D (6 ảnh)")
 *   productIds   — extra products to render the same group for (batch)
 *   referenceIds — render only this subset of the group (omit = all of it)
 *
 * One job is created per product.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireUser();
    if (!auth.ok) return auth.response;

    const body = (await request.json()) as CreateImageRenderRequest;
    if (!body?.groupId) {
      return NextResponse.json({ error: "groupId is required" }, { status: 400 });
    }

    const format = body.format === "jpeg" ? "jpeg" : "png";
    const quality = typeof body.quality === "number"
      ? Math.min(Math.max(body.quality, 0.1), 1)
      : 0.95;

    const productIds = resolveProductIds(id, body.productIds);
    if (productIds.length > 20) {
      return NextResponse.json(
        { error: "Too many products in one request (max 20)" },
        { status: 400 }
      );
    }

    // Both reads use the caller's client, so RLS decides what they may render.
    const [products, group] = await Promise.all([
      loadRenderProducts(auth.ctx.supabase, productIds),
      loadGroupReferences(auth.ctx.supabase, body.groupId, body.referenceIds),
    ]);

    const seeds: JobSeed[] = products.map((product) => ({
      productId: product.id,
      groupId: body.groupId,
      templateId: null,
      payload: buildImagePayload(
        product,
        body.groupId,
        group.groupName,
        group.references,
        format,
        quality
      ),
      progressTotal: group.references.length,
    }));

    const result = await insertAndDispatch(auth.ctx, request, "image", seeds);

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error, "POST /api/products/[id]/renders");
  }
}

/**
 * GET /api/products/[id]/renders — this product's recent image jobs, so the UI
 * can show previously rendered sets without re-rendering them.
 */
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
      .eq("kind", "image")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new RenderPayloadError(`Failed to list render jobs: ${error.message}`, 500);
    }

    const jobs = await attachProductNames(auth.ctx.supabase, data ?? []);
    return NextResponse.json({ jobs });
  } catch (error) {
    return errorResponse(error, "GET /api/products/[id]/renders");
  }
}
