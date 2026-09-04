import type { RenderDbClient } from "@/lib/render/supabase-surface";
import type {
  ClaimedRenderJob,
  RenderJob,
  RenderJobOutput,
  RenderJobPayload,
  RenderWorkerProvider,
} from "@/types/render-job";

/** Raw shopify_customizer.render_jobs row. */
export interface RenderJobRow {
  id: string;
  user_id: string;
  product_id: string | null;
  kind: string;
  group_id: string | null;
  template_id: string | null;
  status: string;
  progress_done: number;
  progress_total: number;
  progress_label: string | null;
  payload: RenderJobPayload | Record<string, never>;
  outputs: RenderJobOutput[] | null;
  error_message: string | null;
  worker_provider: string | null;
  worker_job_id: string | null;
  /**
   * The provider's own run id (RunPod /run). Kept apart from worker_job_id
   * because the claiming pod overwrites that one with its own id — see
   * migration 035.
   */
  provider_run_id: string | null;
  claimed_at?: string | null;
  lease_until?: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at?: string | null;
  purged_at?: string | null;
}

/** Columns every job read needs — payload is heavy, so it stays opt-in. */
export const RENDER_JOB_COLUMNS =
  "id, user_id, product_id, kind, group_id, template_id, status, " +
  "progress_done, progress_total, progress_label, outputs, error_message, " +
  "worker_provider, worker_job_id, provider_run_id, attempts, created_at, started_at, finished_at, " +
  "expires_at, purged_at";

export function mapRenderJob(row: RenderJobRow, productName?: string | null): RenderJob {
  return {
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    productName: productName ?? null,
    kind: row.kind === "video" ? "video" : "image",
    groupId: row.group_id,
    templateId: row.template_id,
    status: row.status as RenderJob["status"],
    progressDone: row.progress_done,
    progressTotal: row.progress_total,
    progressLabel: row.progress_label,
    outputs: row.outputs ?? [],
    errorMessage: row.error_message,
    workerProvider: (row.worker_provider as RenderWorkerProvider | null) ?? null,
    workerJobId: row.worker_job_id,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at ?? null,
    purgedAt: row.purged_at ?? null,
  };
}

export function mapClaimedJob(row: RenderJobRow): ClaimedRenderJob {
  return {
    id: row.id,
    kind: row.kind === "video" ? "video" : "image",
    userId: row.user_id,
    productId: row.product_id,
    payload: row.payload as RenderJobPayload,
    attempts: row.attempts,
    leaseUntil: row.lease_until ?? null,
  };
}

/**
 * Attaches product names to a job list in one query, so the dashboard can label
 * a batch ("NOVERA-D · Cue A / Cue B / Cue C") without N+1 reads.
 */
export async function attachProductNames(
  supabase: RenderDbClient,
  rows: RenderJobRow[]
): Promise<RenderJob[]> {
  const ids = [...new Set(rows.map((r) => r.product_id).filter(Boolean))] as string[];
  const names: Record<string, string> = {};

  if (ids.length > 0) {
    const { data } = await supabase
      .from("products")
      .select<{ id: string; name: string }>("id, name")
      .in("id", ids);
    for (const p of data ?? []) names[p.id] = p.name;
  }

  return rows.map((r) => mapRenderJob(r, r.product_id ? (names[r.product_id] ?? null) : null));
}
