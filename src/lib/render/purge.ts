/**
 * Deletes render output whose 24h retention window has passed.
 *
 * Why anything has to be deleted at all: a 1920x1080 studio clip is tens of MB
 * and a batch queues one job per product, so a few afternoons of rendering can
 * outweigh every other asset in the bucket. The output is also the one thing
 * here that is cheap to lose — the job payload is frozen at enqueue time, so
 * re-running an old job reproduces the same pixels. Storage is a delivery
 * buffer, not an archive.
 *
 * TWO callers, ONE implementation (`purgeExpiredRenders`), deliberately:
 *
 *   1. POST /api/render-worker/purge — a cron on the VPS hits this hourly.
 *      This is the real collector; it runs whether or not anyone is using
 *      the app.
 *   2. `maybePurgeInBackground()` from the enqueue path — unawaited, throttled.
 *      A safety net for when the cron is broken or was never installed. It
 *      aims itself well: the only way Storage grows is somebody rendering, and
 *      that is exactly when this fires.
 *
 * Splitting the two into separate delete routines is how they drift, so they
 * share every line except how they are triggered.
 */

import { createAdminServiceClient } from "@/lib/supabase/server";
import {
  asRenderStorageClient,
  type RenderStorageClient,
} from "@/lib/render/supabase-surface";
import type { RenderJobOutput } from "@/types/render-job";

/**
 * How long a finished job's files stay downloadable. Counted from completion,
 * not from enqueue: a job that waited 20 hours in the queue must still give its
 * owner a full day, and the countdown in the UI has to mean "time left to
 * download".
 */
export const RENDER_TTL_HOURS = Number(process.env.RENDER_TTL_HOURS ?? 24);

/** Supabase Storage caps one remove() call at 1000 paths. */
const STORAGE_REMOVE_BATCH = 1000;

/** Jobs handled per run. Bounded so a neglected backlog cannot make one
 *  request run for minutes; the next run picks up where this stopped. */
const DEFAULT_JOB_LIMIT = 200;

const BUCKET = process.env.RENDER_OUTPUT_BUCKET ?? "product-assets";

/** Computes the expiry stamp for a job finishing now. */
export function renderExpiryFrom(finishedAt: Date = new Date()): string {
  return new Date(finishedAt.getTime() + RENDER_TTL_HOURS * 3600_000).toISOString();
}

export interface PurgeResult {
  /** Jobs whose outputs were deleted and marked purged. */
  jobsPurged: number;
  /** Individual Storage objects removed. */
  filesDeleted: number;
  /** Jobs that were due but could not be cleaned; they stay due for next run. */
  jobsFailed: number;
  /** True when the job limit was hit, i.e. more work remains right now. */
  more: boolean;
  errors: string[];
}

/** The columns the purge reads. */
interface ExpiredJobRow {
  id: string;
  status: string;
  outputs: RenderJobOutput[] | null;
}

/**
 * Deletes Storage files for every job past its expiry, then empties `outputs`
 * and stamps `purged_at`.
 *
 * Jobs still `queued` or `running` are never touched even if somehow due: a
 * worker may be mid-upload, and deleting under it would leave a job that
 * reports success with no files. Only terminal states are collected.
 */
export async function purgeExpiredRenders(
  options: { limit?: number; now?: Date } = {}
): Promise<PurgeResult> {
  const limit = options.limit ?? DEFAULT_JOB_LIMIT;
  const now = options.now ?? new Date();
  const admin = asRenderStorageClient(createAdminServiceClient());

  const result: PurgeResult = {
    jobsPurged: 0,
    filesDeleted: 0,
    jobsFailed: 0,
    more: false,
    errors: [],
  };

  const { data: rows, error } = await admin
    .from("render_jobs")
    .select<ExpiredJobRow>("id, status, outputs")
    .lt("expires_at", now.toISOString())
    .is("purged_at", null)
    .in("status", ["succeeded", "failed", "canceled"])
    .order("expires_at", { ascending: true })
    .limit(limit);

  if (error) {
    result.errors.push(`Failed to list expired jobs: ${error.message}`);
    return result;
  }

  const jobs = rows ?? [];
  result.more = jobs.length === limit;
  if (jobs.length === 0) return result;

  // One Storage call for many jobs. Files are grouped back to their job so a
  // job is only marked purged when ITS files are actually gone — a per-job
  // loop would be one round-trip per file instead.
  const pathToJob = new Map<string, string>();
  for (const job of jobs) {
    for (const output of job.outputs ?? []) {
      // Older rows may predate `storagePath`; those files can only be found by
      // hand, so leave them and say so rather than silently marking them clean.
      if (output.storagePath) pathToJob.set(output.storagePath, job.id);
    }
  }

  const allPaths = [...pathToJob.keys()];
  const failedJobIds = new Set<string>();

  for (let i = 0; i < allPaths.length; i += STORAGE_REMOVE_BATCH) {
    const batch = allPaths.slice(i, i + STORAGE_REMOVE_BATCH);
    const { data: removed, error: removeError } = await admin.storage
      .from(BUCKET)
      .remove(batch);

    if (removeError) {
      // Every job in this batch keeps its outputs and stays due. Retrying is
      // safe: remove() does not error on paths that are already gone.
      for (const path of batch) {
        const jobId = pathToJob.get(path);
        if (jobId) failedJobIds.add(jobId);
      }
      result.errors.push(`Storage remove failed: ${removeError.message}`);
      continue;
    }

    result.filesDeleted += (removed ?? []).length;
  }

  const purgeable = jobs.filter((job) => !failedJobIds.has(job.id));
  result.jobsFailed = jobs.length - purgeable.length;

  if (purgeable.length > 0) {
    const { error: markError } = await admin
      .from("render_jobs")
      .update({ outputs: [], purged_at: now.toISOString() })
      .in("id", purgeable.map((job) => job.id));

    if (markError) {
      // Files are gone but the rows still advertise their URLs — the worse of
      // the two half-states, so it is reported loudly. The next run retries.
      result.errors.push(`Files deleted but rows not marked purged: ${markError.message}`);
      result.jobsFailed += purgeable.length;
    } else {
      result.jobsPurged = purgeable.length;
    }
  }

  return result;
}

/**
 * Fire-and-forget purge for the enqueue path.
 *
 * Never awaited and never throws into the caller: queueing a render must not
 * get slower, or fail, because cleanup had a bad day. Throttled in-process so a
 * batch of 20 products triggers one sweep, not twenty.
 *
 * In-process state means each server instance keeps its own timer — which is
 * fine, since the purge is idempotent and the cron is the real collector.
 */
let lastBackgroundPurge = 0;
const BACKGROUND_PURGE_INTERVAL_MS = 30 * 60_000;

export function maybePurgeInBackground(): void {
  const now = Date.now();
  if (now - lastBackgroundPurge < BACKGROUND_PURGE_INTERVAL_MS) return;
  lastBackgroundPurge = now;

  void purgeExpiredRenders()
    .then((result) => {
      if (result.jobsPurged > 0 || result.errors.length > 0) {
        console.log(
          `[render-purge] background sweep: ${result.jobsPurged} job(s), ` +
            `${result.filesDeleted} file(s)` +
            (result.errors.length ? ` — ${result.errors.join("; ")}` : "")
        );
      }
    })
    .catch((error: unknown) => {
      console.error("[render-purge] background sweep threw:", error);
    });
}
