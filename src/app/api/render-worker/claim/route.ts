import { NextResponse } from "next/server";
import { requireWorker } from "@/lib/render/worker-auth";
import { mapClaimedJob, type RenderJobRow } from "@/lib/render/job-mapper";
import type { RenderJobKind } from "@/types/render-job";

interface ClaimBody {
  /**
   * Claim this specific job. The dispatcher pokes one pod per job, so the pod
   * knows which one it was woken for — without this it could pick up a
   * different queued job and leave its own for a pod that never comes.
   */
  jobId?: string;
  /** Restrict to one kind when a pod's image only handles images or only video. */
  kind?: RenderJobKind;
  /**
   * How long the worker promises to finish in. If it dies, the job returns to
   * 'queued' after this and another pod retries it (up to 3 attempts).
   */
  leaseSeconds?: number;
  /** The provider's own run id, echoed back for cost tracing. */
  workerJobId?: string;
  provider?: string;
}

/**
 * POST /api/render-worker/claim
 *
 * Called by the GPU container on start-up (and again after each finished job,
 * to drain the queue while the card is already warm — the expensive part is the
 * cold start, so one pod taking several jobs is much cheaper than one pod per
 * job).
 *
 * Returns 204 when the queue is empty, which is the worker's signal to exit and
 * stop the billing clock.
 */
export async function POST(request: Request) {
  try {
    const auth = requireWorker(request);
    if (!auth.ok) return auth.response;

    const body = (await request.json().catch(() => ({}))) as ClaimBody;
    const leaseSeconds = Math.min(Math.max(body.leaseSeconds ?? 900, 60), 3600);
    const kind = body.kind === "image" || body.kind === "video" ? body.kind : null;

    const provider = body.provider ?? "runpod";
    const workerJobId = body.workerJobId ?? auth.ctx.workerId;

    // Atomic either way: FOR UPDATE SKIP LOCKED inside the functions means two
    // pods polling at the same instant never take the same job.
    //
    // A pod woken for a specific job takes THAT job. Only if it is already
    // gone (claimed by a retry, canceled, finished) does the pod fall back to
    // draining the queue — the card is warm, so an extra job is nearly free.
    const { data, error } = body.jobId
      ? await auth.ctx.admin.rpc<RenderJobRow | RenderJobRow[] | null>("claim_render_job_by_id", {
          p_job_id: body.jobId,
          p_worker_provider: provider,
          p_worker_job_id: workerJobId,
          p_lease_seconds: leaseSeconds,
        })
      : await auth.ctx.admin.rpc<RenderJobRow | RenderJobRow[] | null>("claim_render_job", {
          p_worker_provider: provider,
          p_worker_job_id: workerJobId,
          p_lease_seconds: leaseSeconds,
          p_kind: kind,
        });

    if (error) {
      console.error("[render-worker] claim failed:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // The RPC returns NULL (or an all-null composite) when nothing was claimable.
    let row = Array.isArray(data) ? (data[0] ?? null) : data;

    // Targeted claim missed — the job was already taken, canceled, or done.
    // Drain the queue instead of wasting a warm GPU on an immediate exit.
    if (!row?.id && body.jobId) {
      const { data: fallback, error: fallbackError } = await auth.ctx.admin.rpc<
        RenderJobRow | RenderJobRow[] | null
      >("claim_render_job", {
        p_worker_provider: provider,
        p_worker_job_id: workerJobId,
        p_lease_seconds: leaseSeconds,
        p_kind: kind,
      });
      if (fallbackError) {
        console.error("[render-worker] fallback claim failed:", fallbackError);
        return NextResponse.json({ error: fallbackError.message }, { status: 500 });
      }
      row = Array.isArray(fallback) ? (fallback[0] ?? null) : fallback;
    }

    if (!row?.id) {
      return new NextResponse(null, { status: 204 });
    }

    return NextResponse.json(mapClaimedJob(row));
  } catch (error) {
    console.error("POST /api/render-worker/claim error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
