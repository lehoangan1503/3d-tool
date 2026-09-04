/**
 * Collapsing a render batch into one card per product.
 *
 * A job is the unit of GPU work — one (product x group-or-template) — which is
 * the right granularity for a queue but the wrong one for a person. Rendering
 * two products against two image groups and one video template produces six
 * rows all named "n02-80" / "n02-81", and the screen becomes a list where the
 * product name is repeated and nothing tells the rows apart. The operator's
 * actual question is "is n02-80 done, and where are its files", so the product
 * is the card and the jobs inside it become sections.
 *
 * Grouping key is the product, NOT the batch: a re-render of one group an hour
 * later belongs on the same product's card next to the rest of its output.
 * Sections keep the jobs distinct inside it, so nothing is merged that the user
 * would later need separated — including at download time, where each section
 * stays its own folder (see downloadProductGroupAsZip).
 */

import type { RenderJob, RenderJobKind } from "@/types/render-job";

/** One job's worth of output inside a product card. */
export interface RenderSection {
  /** The job this section came from — actions still address a single job. */
  job: RenderJob;
  kind: RenderJobKind;
  /**
   * The image group or video template that produced it, resolved from the
   * pickers. Falls back to the kind when the target was deleted since, so a
   * section is never nameless.
   */
  targetName: string;
  /** group_id or template_id — the folder identity in a zip. */
  targetId: string | null;
}

/** Every render belonging to one product, newest job first. */
export interface ProductRenderGroup {
  /** Stable across polls: the product id, or the job id when there is none. */
  key: string;
  productId: string | null;
  productName: string;
  sections: RenderSection[];

  // ── Rolled-up state, so the header can be read without opening anything ──
  /** True while any job in the card is queued or running. */
  live: boolean;
  /** Overall percent across the card's jobs, weighted by their own totals. */
  percent: number;
  /** Files that exist right now, across sections. */
  fileCount: number;
  totalBytes: number;
  /** Per-status job counts, for the header's summary line. */
  counts: Record<RenderJob["status"], number>;
  /** Earliest createdAt, so cards keep the queue's ordering. */
  createdAt: string;
  /** The soonest purge-eligible expiry among sections that still have files. */
  expiresAt: string | null;
  /** True when every section's output has already been purged. */
  allPurged: boolean;
  /** First error on the card, for the collapsed header. */
  errorMessage: string | null;
}

/** Names for the render targets, keyed by id — what the pickers already hold. */
export interface TargetNameLookup {
  groups: Record<string, string>;
  templates: Record<string, string>;
}

const EMPTY_COUNTS = (): Record<RenderJob["status"], number> => ({
  queued: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0,
});

function targetNameFor(job: RenderJob, names: TargetNameLookup): string {
  if (job.kind === "video") {
    return (
      (job.templateId ? names.templates[job.templateId] : null) ?? "Video"
    );
  }
  return (job.groupId ? names.groups[job.groupId] : null) ?? "Nhóm ảnh";
}

/**
 * Percent for one job, using the same rules as the old card: a succeeded job is
 * 100 even if its heartbeat lagged, and a failed one is capped at 99 so a
 * worker that died on the last upload cannot read as complete.
 */
export function jobPercent(job: RenderJob): number {
  const raw =
    job.progressTotal > 0
      ? Math.round((job.progressDone / job.progressTotal) * 100)
      : 0;
  if (job.status === "succeeded") return 100;
  if (job.status === "failed" || job.status === "canceled") return Math.min(raw, 99);
  return raw;
}

/**
 * Groups a flat job list into product cards.
 *
 * Input order is preserved inside each card (the API returns newest first), and
 * cards themselves are ordered by their newest job so a freshly queued render
 * jumps to the top the way a single job used to.
 */
export function groupJobsByProduct(
  jobs: RenderJob[],
  names: TargetNameLookup
): ProductRenderGroup[] {
  const byProduct = new Map<string, ProductRenderGroup>();

  for (const job of jobs) {
    // A job whose product was deleted (product_id ON DELETE SET NULL) has no
    // grouping key of its own; giving it the job id keeps it on its own card
    // instead of merging every orphan into one.
    const key = job.productId ?? `job:${job.id}`;

    let group = byProduct.get(key);
    if (!group) {
      group = {
        key,
        productId: job.productId,
        productName: job.productName ?? job.productId ?? "(không rõ sản phẩm)",
        sections: [],
        live: false,
        percent: 0,
        fileCount: 0,
        totalBytes: 0,
        counts: EMPTY_COUNTS(),
        createdAt: job.createdAt,
        expiresAt: null,
        allPurged: false,
        errorMessage: null,
      };
      byProduct.set(key, group);
    }

    group.sections.push({
      job,
      kind: job.kind,
      targetName: targetNameFor(job, names),
      targetId: job.kind === "video" ? job.templateId : job.groupId,
    });
  }

  for (const group of byProduct.values()) {
    let weighted = 0;
    let weight = 0;

    for (const { job } of group.sections) {
      group.counts[job.status] += 1;
      if (job.status === "queued" || job.status === "running") group.live = true;

      // A video job's progressTotal is a percentage (always 100) while an
      // image job's is a file count, so totals are not comparable across kinds
      // — see expectedFiles(). Weighting by expected FILES keeps a 14-image
      // job from being averaged as equal to a one-clip video.
      const w = Math.max(1, expectedFiles(job));
      weighted += jobPercent(job) * w;
      weight += w;

      if (!job.purgedAt) {
        group.fileCount += job.outputs.length;
        group.totalBytes += job.outputs.reduce((sum, o) => sum + (o.bytes ?? 0), 0);
      }

      if (job.createdAt < group.createdAt) group.createdAt = job.createdAt;

      // Only sections that still HAVE files contribute a deadline: a purged job
      // keeps its expires_at, so including it would count down for files that
      // are already gone.
      if (!job.purgedAt && job.outputs.length > 0 && job.expiresAt) {
        if (!group.expiresAt || job.expiresAt < group.expiresAt) {
          group.expiresAt = job.expiresAt;
        }
      }

      if (!group.errorMessage && job.errorMessage) group.errorMessage = job.errorMessage;
    }

    group.percent = weight > 0 ? Math.round(weighted / weight) : 0;
    group.allPurged =
      group.sections.length > 0 && group.sections.every((s) => s.job.purgedAt !== null);
  }

  return [...byProduct.values()].sort((a, b) => {
    // Newest job on the card decides its place, so a re-render surfaces the
    // product again rather than leaving it buried by its oldest job.
    const an = newestCreatedAt(a);
    const bn = newestCreatedAt(b);
    return an < bn ? 1 : an > bn ? -1 : 0;
  });
}

function newestCreatedAt(group: ProductRenderGroup): string {
  return group.sections.reduce(
    (max, s) => (s.job.createdAt > max ? s.job.createdAt : max),
    group.sections[0]?.job.createdAt ?? ""
  );
}

/**
 * How many files a job produces when it succeeds.
 *
 * NOT `progressTotal`: for an image job that is the reference count (a file
 * count), but for a video job it is a percentage — always 100. A video records
 * exactly one clip (runVideoJob returns 1), so the count is fixed.
 */
export function expectedFiles(job: RenderJob): number {
  return job.kind === "video" ? 1 : job.progressTotal;
}

/** Sections that still hold downloadable files. */
export function downloadableSections(group: ProductRenderGroup): RenderSection[] {
  return group.sections.filter(
    (s) => s.job.purgedAt === null && s.job.outputs.some((o) => o.url)
  );
}
