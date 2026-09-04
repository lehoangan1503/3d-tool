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
  /**
   * How wide the "video owns the GPU" rule reaches (see migration 033).
   *
   * "worker" (default) — isolation is per pod, which is what a serverless
   * endpoint wants: each pod is its own container on its own card, so two
   * videos on two pods do not disturb each other.
   * "global" — every pod shares one physical GPU (a single rented box), so a
   * video must be alone across the whole fleet.
   */
  exclusiveScope?: "worker" | "global";
  /**
   * Set false to skip the wait-for-a-quiet-GPU rule on a targeted claim, for a
   * one-shot pod that has nothing to share with (WORKER_MODE=job, local runs).
   */
  deferIfBusy?: boolean;
}

/**
 * Postgres rejects a non-UUID `p_job_id` with a hard error, which would
 * otherwise surface as a 500 — "server broken" — for what is really a bad
 * request. Worse, that error short-circuits the fallback below, so a pod woken
 * with a malformed id would exit instead of draining the queue it can see.
 *
 * A pod can be handed a junk id by a manual test request or a stale dispatch
 * record, so this is validated rather than assumed.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const exclusiveScope = body.exclusiveScope === "global" ? "global" : "worker";
    const deferIfBusy = body.deferIfBusy !== false;

    // A malformed id is treated as "no specific job" rather than an error: the
    // pod is already warm and the queue may well have work for it, so drainage
    // is a better outcome than a failed run. Logged so a dispatcher that keeps
    // sending junk is still visible.
    const targetJobId = body.jobId && UUID_RE.test(body.jobId) ? body.jobId : null;
    if (body.jobId && !targetJobId) {
      console.warn(
        `[render-worker] ignoring malformed jobId "${body.jobId.slice(0, 64)}" — draining queue instead`
      );
    }

    // Atomic either way: FOR UPDATE SKIP LOCKED inside the functions means two
    // pods polling at the same instant never take the same job.
    //
    // A pod woken for a specific job takes THAT job. Only if it is already
    // gone (claimed by a retry, canceled, finished) does the pod fall back to
    // draining the queue — the card is warm, so an extra job is nearly free.
    const { data, error } = targetJobId
      ? await auth.ctx.admin.rpc<RenderJobRow | RenderJobRow[] | null>("claim_render_job_by_id", {
          p_job_id: targetJobId,
          p_worker_provider: provider,
          p_worker_job_id: workerJobId,
          p_lease_seconds: leaseSeconds,
          p_exclusive_scope: exclusiveScope,
          p_defer_if_busy: deferIfBusy,
        })
      : await auth.ctx.admin.rpc<RenderJobRow | RenderJobRow[] | null>("claim_render_job", {
          p_worker_provider: provider,
          p_worker_job_id: workerJobId,
          p_lease_seconds: leaseSeconds,
          p_kind: kind,
          p_exclusive_scope: exclusiveScope,
        });

    if (error) {
      console.error("[render-worker] claim failed:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // The RPC returns NULL (or an all-null composite) when nothing was claimable.
    let row = Array.isArray(data) ? (data[0] ?? null) : data;

    // Targeted claim missed. Two very different reasons, and they must not be
    // conflated:
    //
    //  a) the job is GONE (already taken, canceled, finished) — draining the
    //     queue is right, the card is warm and an immediate exit wastes it;
    //  b) the job is DEFERRED by migration 033 — the GPU is busy and this job
    //     is waiting for it to go quiet. Falling through to the drain claim
    //     here would hand the pod an image job and leave the video waiting
    //     exactly as long again, which is the opposite of the intent.
    //
    // So the fallback runs only when the row is really gone.
    if (!row?.id && targetJobId) {
      const { data: stillQueued } = await auth.ctx.admin
        .from("render_jobs")
        .select<{ id: string }>("id")
        .eq("id", targetJobId)
        .eq("status", "queued")
        .maybeSingle();

      if (stillQueued?.id) {
        // Case (b). 202 tells the pod "your job exists, the GPU is not free
        // yet" — distinct from the 204 that means "nothing to do, exit".
        return NextResponse.json(
          { deferred: true, jobId: targetJobId, reason: "gpu-busy" },
          { status: 202 }
        );
      }

      const { data: fallback, error: fallbackError } = await auth.ctx.admin.rpc<
        RenderJobRow | RenderJobRow[] | null
      >("claim_render_job", {
        p_worker_provider: provider,
        p_worker_job_id: workerJobId,
        p_lease_seconds: leaseSeconds,
        p_kind: kind,
        p_exclusive_scope: exclusiveScope,
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
