import { NextResponse } from "next/server";
import {
  errorResponse,
  requireUser,
  type RenderJobSource,
} from "@/lib/render/enqueue";
import { RenderPayloadError } from "@/lib/render/build-payload";
import {
  attachProductNames,
  RENDER_JOB_COLUMNS,
  type RenderJobRow,
} from "@/lib/render/job-mapper";
import type { RenderJobKind, RenderJobStatus } from "@/types/render-job";

const VALID_STATUSES: RenderJobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
];

/**
 * GET /api/render-jobs — the caller's render queue.
 *
 * Backs a "Đang render" panel: one poll returns every in-flight job across all
 * selected products, so a batch of 5 products needs one request per tick
 * instead of five.
 *
 * Query: ?status=queued,running &kind=image|video &source=api|dashboard &limit=50
 *
 * `source` splits the two queues that share this table: jobs a person started
 * in the dashboard, and jobs an AI agent started through /api/v1/renders. Omit
 * it to see both — the parameter narrows, it never widens.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 100);
    const kindParam = searchParams.get("kind");
    const statusParam = searchParams.get("status");

    let query = auth.ctx.supabase
      .from("render_jobs")
      .select<RenderJobRow>(RENDER_JOB_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (kindParam === "image" || kindParam === "video") {
      query = query.eq("kind", kindParam satisfies RenderJobKind);
    }

    if (statusParam) {
      const statuses = statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is RenderJobStatus => VALID_STATUSES.includes(s as RenderJobStatus));
      if (statuses.length > 0) query = query.in("status", statuses);
    }

    const sourceParam = searchParams.get("source");
    if (sourceParam === "api" || sourceParam === "dashboard") {
      query = query.eq("source", sourceParam satisfies RenderJobSource);
    }

    const productId = searchParams.get("product_id");
    if (productId) query = query.eq("product_id", productId);

    const { data, error } = await query;
    if (error) {
      throw new RenderPayloadError(`Failed to list render jobs: ${error.message}`, 500);
    }

    const jobs = await attachProductNames(auth.ctx.supabase, data ?? []);
    return NextResponse.json({ jobs });
  } catch (error) {
    return errorResponse(error, "GET /api/render-jobs");
  }
}
