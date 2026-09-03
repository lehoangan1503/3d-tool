import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/render/enqueue";
import { RenderPayloadError } from "@/lib/render/build-payload";
import { renderExpiryFrom } from "@/lib/render/purge";
import {
  attachProductNames,
  RENDER_JOB_COLUMNS,
  type RenderJobRow,
} from "@/lib/render/job-mapper";

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

/**
 * GET /api/render-jobs/[jobId] — the poll endpoint.
 *
 * The client polls this after enqueueing (or subscribes to the row via
 * Supabase Realtime and uses this as the fallback). Returns progress while the
 * GPU works and the output URLs once it finishes.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const auth = await requireUser();
    if (!auth.ok) return auth.response;

    // RLS restricts this to the caller's own jobs (admins see all).
    const { data, error } = await auth.ctx.supabase
      .from("render_jobs")
      .select<RenderJobRow>(RENDER_JOB_COLUMNS)
      .eq("id", jobId)
      .maybeSingle();

    if (error) {
      throw new RenderPayloadError(`Failed to load job: ${error.message}`, 500);
    }
    if (!data) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const [job] = await attachProductNames(auth.ctx.supabase, [data]);
    return NextResponse.json(job);
  } catch (error) {
    return errorResponse(error, "GET /api/render-jobs/[jobId]");
  }
}

/**
 * DELETE /api/render-jobs/[jobId] — cancel.
 *
 * A job still queued is marked canceled so no worker claims it. One already
 * running is also marked canceled: the worker checks the status on each
 * progress heartbeat and aborts, which stops the GPU meter early.
 */
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const auth = await requireUser();
    if (!auth.ok) return auth.response;

    // A canceled job may already hold partial output (the worker uploads each
    // file as it finishes), so it needs an expiry too — otherwise those files
    // would be the one kind the collector never sees.
    const canceledAt = new Date();

    const { data, error } = await auth.ctx.supabase
      .from("render_jobs")
      .update({
        status: "canceled",
        finished_at: canceledAt.toISOString(),
        expires_at: renderExpiryFrom(canceledAt),
      })
      .eq("id", jobId)
      .in("status", ["queued", "running"])
      .select<RenderJobRow>(RENDER_JOB_COLUMNS)
      .maybeSingle();

    if (error) {
      throw new RenderPayloadError(`Failed to cancel job: ${error.message}`, 500);
    }
    if (!data) {
      return NextResponse.json(
        { error: "Job not found, or already finished" },
        { status: 409 }
      );
    }

    const [job] = await attachProductNames(auth.ctx.supabase, [data]);
    return NextResponse.json(job);
  } catch (error) {
    return errorResponse(error, "DELETE /api/render-jobs/[jobId]");
  }
}
