import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/render/enqueue";
import { RenderPayloadError } from "@/lib/render/build-payload";
import {
  attachProductNames,
  RENDER_JOB_COLUMNS,
  type RenderJobRow,
} from "@/lib/render/job-mapper";
import {
  dispatchRenderJob,
  isGpuConfigured,
  resolveAppBaseUrl,
} from "@/lib/render/gpu-dispatch";
import { asRenderDbClient } from "@/lib/render/supabase-surface";
import { createAdminServiceClient } from "@/lib/supabase/server";
import type { RenderJobPayload } from "@/types/render-job";

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

/**
 * POST /api/render-jobs/[jobId]/retry
 *
 * Re-queues a finished job IN PLACE: the same row goes back to 'queued' and the
 * card the user is looking at becomes the running one.
 *
 * Inserting a copy instead would leave two cards for one cue — the dead attempt
 * and the live one — which reads as a duplicate render rather than a retry. The
 * previous error is cleared because it now describes an attempt that no longer
 * exists.
 *
 * The frozen payload is reused untouched, so the retry reproduces the same
 * pixels even if the image group or product has been edited since — the whole
 * reason payload lives in the row.
 *
 * Only terminal jobs can be retried. A queued or running job already has a pod
 * coming for it, and re-queueing would pay for the same render twice.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const auth = await requireUser();
    if (!auth.ok) return auth.response;

    // RLS scopes this to the caller's own jobs, so a user cannot re-run — and
    // bill GPU time for — somebody else's render.
    const { data: source, error } = await auth.ctx.supabase
      .from("render_jobs")
      .select<RenderJobRow>(`${RENDER_JOB_COLUMNS}, payload`)
      .eq("id", jobId)
      .maybeSingle();

    if (error) {
      throw new RenderPayloadError(`Failed to load job: ${error.message}`, 500);
    }
    if (!source) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (!["failed", "canceled", "succeeded"].includes(source.status)) {
      return NextResponse.json(
        { error: `Job đang ${source.status} — không thể render lại` },
        { status: 409 }
      );
    }

    const payload = source.payload as RenderJobPayload;
    if (!payload || !("kind" in payload)) {
      return NextResponse.json(
        { error: "Job này không còn payload để render lại" },
        { status: 422 }
      );
    }

    const kind = source.kind === "video" ? "video" : "image";

    // progress_total comes from the payload, not the old row: a job that failed
    // early may never have had its total set.
    const progressTotal =
      payload.kind === "image" ? payload.references.length : 1;

    // Every field the previous attempt left behind is reset. Outputs go too:
    // a partial set from a failed run would otherwise sit alongside the new
    // one and the UI could not tell which files belong to which attempt.
    //
    // The Storage objects those outputs point at are deliberately NOT deleted
    // here — the retry overwrites them by path (upsert) as it re-uploads, and
    // anything genuinely orphaned is collected by the retention purge.
    const { data: rows, error: updateError } = await auth.ctx.supabase
      .from("render_jobs")
      .update({
        status: "queued",
        // A manual retry is a fresh start, so the automatic-recovery budget
        // resets with it. `claim_render_job` only re-queues a dead worker's job
        // while `attempts < 3`; without this reset, a job the user retried a few
        // times would silently lose the right to be recovered after a pod crash.
        attempts: 0,
        progress_done: 0,
        progress_total: progressTotal,
        progress_label: null,
        outputs: [],
        error_message: null,
        started_at: null,
        finished_at: null,
        claimed_at: null,
        lease_until: null,
        // The retry is a fresh retention window; the old expiry described files
        // that are being replaced.
        expires_at: null,
        purged_at: null,
      })
      .eq("id", jobId)
      // Re-check the status inside the write: between the SELECT above and here
      // a worker could have claimed the job, and clobbering a running render is
      // exactly what the terminal-only rule exists to prevent.
      .in("status", ["failed", "canceled", "succeeded"])
      .select<RenderJobRow>(RENDER_JOB_COLUMNS);

    if (updateError) {
      throw new RenderPayloadError(`Failed to queue retry: ${updateError.message}`, 500);
    }
    if (!rows?.[0]) {
      return NextResponse.json(
        { error: "Job vừa đổi trạng thái — tải lại trang rồi thử lại" },
        { status: 409 }
      );
    }

    const [job] = await attachProductNames(auth.ctx.supabase, rows);

    if (!isGpuConfigured()) {
      return NextResponse.json({
        job,
        warning:
          "Job đã vào hàng đợi, nhưng chưa cấu hình GPU worker — nó sẽ chạy khi có worker kết nối.",
      });
    }

    const dispatch = await dispatchRenderJob({
      jobId: job.id,
      kind,
      appBaseUrl: resolveAppBaseUrl(request),
    });

    if (dispatch.dispatched) {
      // Worker bookkeeping belongs to the server, same as the enqueue path.
      const admin = asRenderDbClient(createAdminServiceClient());
      await admin
        .from("render_jobs")
        .update({
          worker_provider: dispatch.provider,
          worker_job_id: dispatch.workerJobId,
        })
        .eq("id", job.id);
    }

    return NextResponse.json({
      job: {
        ...job,
        workerProvider: dispatch.dispatched ? dispatch.provider : job.workerProvider,
        workerJobId: dispatch.workerJobId ?? job.workerJobId,
      },
      // A failed poke is not an error: the job stays queued for the next
      // polling worker.
      warning: dispatch.dispatched
        ? undefined
        : `Không gọi được GPU (${dispatch.error}). Job vẫn nằm trong hàng đợi.`,
    });
  } catch (error) {
    return errorResponse(error, "POST /api/render-jobs/[jobId]/retry");
  }
}
