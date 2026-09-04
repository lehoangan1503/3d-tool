/**
 * Shared enqueue path for both render endpoints.
 *
 * One job per product: picking 3 products and one image group creates 3 rows,
 * so three GPU workers can run them at once and each product reports its own
 * progress. The alternative — one job holding N products — serializes the
 * batch on a single container and makes a partial failure all-or-nothing.
 */

import { NextResponse } from "next/server";
import { asRenderDbClient, type RenderDbClient } from "@/lib/render/supabase-surface";
import { createAdminServiceClient, createClient } from "@/lib/supabase/server";
import {
  dispatchRenderJob,
  isGpuConfigured,
  resolveAppBaseUrl,
} from "@/lib/render/gpu-dispatch";
import {
  attachProductNames,
  RENDER_JOB_COLUMNS,
  type RenderJobRow,
} from "@/lib/render/job-mapper";
import { RenderPayloadError } from "@/lib/render/build-payload";
import { maybePurgeInBackground } from "@/lib/render/purge";
import type { RenderJob, RenderJobPayload } from "@/types/render-job";

export interface EnqueueContext {
  supabase: RenderDbClient;
  userId: string;
}

/** Resolves the session, or returns the 401 to hand straight back. */
export async function requireUser(): Promise<
  { ok: true; ctx: EnqueueContext } | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, ctx: { supabase: asRenderDbClient(supabase), userId: user.id } };
}

/**
 * Normalizes the product list: the URL's product plus any extras from the body,
 * de-duplicated, order preserved. Lets one endpoint serve both "render this
 * product" and the multi-select batch.
 */
export function resolveProductIds(urlProductId: string, bodyIds?: string[]): string[] {
  const ids = [urlProductId, ...(bodyIds ?? [])]
    .map((id) => id?.trim())
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

export interface JobSeed {
  productId: string;
  groupId: string | null;
  templateId: string | null;
  payload: RenderJobPayload;
  progressTotal: number;
}

export interface EnqueueResult {
  jobs: RenderJob[];
  /** Set when the jobs are queued but no GPU backend is wired up yet. */
  warning?: string;
}

export async function insertAndDispatch(
  ctx: EnqueueContext,
  request: Request,
  kind: "image" | "video",
  seeds: JobSeed[]
): Promise<EnqueueResult> {
  // Backstop for the hourly cron: queueing a render is the only thing that
  // makes Storage grow, so it is also the right moment to sweep. Throttled and
  // never awaited — cleanup must not slow down or break an enqueue.
  maybePurgeInBackground();

  const { data: rows, error } = await ctx.supabase
    .from("render_jobs")
    .insert(
      seeds.map((seed) => ({
        user_id: ctx.userId,
        product_id: seed.productId,
        kind,
        group_id: seed.groupId,
        template_id: seed.templateId,
        payload: seed.payload,
        progress_total: seed.progressTotal,
        status: "queued",
      }))
    )
    .select<RenderJobRow>(RENDER_JOB_COLUMNS);

  if (error || !rows) {
    throw new RenderPayloadError(`Failed to queue render: ${error?.message ?? "no rows"}`, 500);
  }

  const jobs = await attachProductNames(ctx.supabase, rows);

  if (!isGpuConfigured()) {
    return {
      jobs,
      warning:
        "Jobs queued, but no GPU worker is configured (set RENDER_GPU_PROVIDER + its keys). " +
        "They will run as soon as a worker connects.",
    };
  }

  // Poke one worker per job so the provider scales out — but do NOT make the
  // caller wait for it.
  //
  // The INSERT above is what queues a job; the dispatch is only a hint that
  // makes the provider spin a container now instead of on its next poll. It is
  // an HTTP round-trip to RunPod, which takes seconds and is allowed up to 15
  // (DISPATCH_TIMEOUT_MS). Awaiting it here meant the response — and so the
  // spinner on the Render button, and the row appearing in the list — was held
  // for the slowest provider call. With the /renders page sending one request
  // per target in sequence, 4 targets stacked into ~30s of "nothing happened"
  // for jobs that were in fact already queued in the first 200ms.
  //
  // So the response returns as soon as the rows exist, and the poking happens
  // after it. A dispatch that fails changes nothing about correctness: the job
  // stays `queued` and the next polling worker claims it.
  void dispatchInBackground(jobs, kind, resolveAppBaseUrl(request));

  return { jobs };
}

/**
 * Fire-and-forget the provider pokes and record their run ids.
 *
 * Deliberately not awaited by the request. Errors are logged, never thrown: an
 * unhandled rejection here would be a crash for work that is already safely in
 * Postgres.
 *
 * Note on serverless hosts: an un-awaited task can be cut short when the
 * function freezes after responding. That is survivable by design — a job that
 * never got poked is still `queued` and gets claimed by the next worker poll —
 * which is exactly why this is safe to background and the INSERT is not.
 */
export async function dispatchInBackground(
  jobs: RenderJob[],
  kind: "image" | "video",
  appBaseUrl: string
): Promise<void> {
  try {
    const dispatches = await Promise.all(
      jobs.map((job) => dispatchRenderJob({ jobId: job.id, kind, appBaseUrl }))
    );

    // Record the provider's run id with the service client: the RLS UPDATE
    // policy lets a user touch their own row, but worker bookkeeping belongs to
    // the server, and this also keeps the write out of the user's rate limits.
    const admin = asRenderDbClient(createAdminServiceClient());
    await Promise.all(
      dispatches.map((d, i) =>
        d.dispatched
          ? admin
              .from("render_jobs")
              // provider_run_id, not worker_job_id: the claiming pod overwrites
              // worker_job_id with its OWN id, which would destroy the only
              // handle we have for cancelling the run (see migration 035).
              .update({ worker_provider: d.provider, provider_run_id: d.workerJobId })
              .eq("id", jobs[i].id)
          : Promise.resolve(null)
      )
    );

    const failed = dispatches.filter((d) => !d.dispatched);
    if (failed.length > 0) {
      // Visible in the server log rather than the response: by the time this
      // resolves the caller has long since been answered. The jobs are queued,
      // so this is a "the GPU was slow to be woken" note, not an error the
      // user must act on.
      console.warn(
        `[render-enqueue] ${failed.length}/${jobs.length} job(s) could not reach ` +
          `the GPU service (${failed[0].error}). They stay queued for the next worker poll.`
      );
    }
  } catch (error) {
    console.error("[render-enqueue] background dispatch failed:", error);
  }
}

/** Maps a thrown RenderPayloadError to its intended HTTP status. */
export function errorResponse(error: unknown, route: string): NextResponse {
  if (error instanceof RenderPayloadError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`${route} error:`, error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
