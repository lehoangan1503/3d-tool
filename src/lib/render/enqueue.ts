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

  // Poke one worker per job so the provider scales out. Dispatch never throws;
  // an un-poked job simply waits for the next polling worker.
  const appBaseUrl = resolveAppBaseUrl(request);
  const dispatches = await Promise.all(
    jobs.map((job) => dispatchRenderJob({ jobId: job.id, kind, appBaseUrl }))
  );

  // Record the provider's run id with the service client: the RLS UPDATE policy
  // lets a user touch their own row, but worker bookkeeping belongs to the
  // server, and this also keeps the write out of the user's rate limits.
  const admin = asRenderDbClient(createAdminServiceClient());
  await Promise.all(
    dispatches.map((d, i) =>
      d.dispatched
        ? admin
            .from("render_jobs")
            .update({ worker_provider: d.provider, worker_job_id: d.workerJobId })
            .eq("id", jobs[i].id)
        : Promise.resolve(null)
    )
  );

  const failed = dispatches.filter((d) => !d.dispatched);
  return {
    jobs: jobs.map((job, i) => ({
      ...job,
      workerProvider: dispatches[i].dispatched ? dispatches[i].provider : job.workerProvider,
      workerJobId: dispatches[i].workerJobId ?? job.workerJobId,
    })),
    warning:
      failed.length > 0
        ? `${failed.length}/${jobs.length} job(s) could not reach the GPU service (${failed[0].error}). They stay queued.`
        : undefined,
  };
}

/** Maps a thrown RenderPayloadError to its intended HTTP status. */
export function errorResponse(error: unknown, route: string): NextResponse {
  if (error instanceof RenderPayloadError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`${route} error:`, error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
