"use client";

/**
 * One PRODUCT's render output, however many jobs made it.
 *
 * The queue's unit is a job — one (product x group-or-template) — and the page
 * used to draw one card per job. Rendering two products against two image
 * groups and a video template therefore produced six cards, four of them
 * titled "n02-80" or "n02-81" with nothing on the header to tell them apart:
 * the same name, the same "100%", the same countdown. Finding a product's files
 * meant opening cards until the thumbnails looked right.
 *
 * So the product is the card and its jobs are SECTIONS inside it, each labelled
 * with the image group or video template that produced it. Nothing is actually
 * merged: cancel, retry, delete and the file grids still address one job, and
 * the download keeps every section in its own folder — see
 * downloadProductGroupAsZip. What changes is that the product appears once.
 *
 * Retention stays per section, deliberately. Jobs finished hours apart die in
 * different sweeps, so one number on the header would be a lie for the others;
 * the header shows the SOONEST and each section shows its own.
 */

import { useEffect, useState } from "react";
import Image from "next/image";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  FileArchive,
  Film,
  ImageIcon,
  Loader2,
  RotateCcw,
  Server,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatDeadlineClock,
  msUntilPurge,
  purgeDeadline,
} from "@/lib/render/retention";
import {
  downloadJobAsZip,
  downloadOutput,
  downloadProductGroupAsZip,
  type DownloadProgress,
} from "@/lib/render/download-outputs";
import {
  downloadableSections,
  expectedFiles,
  jobPercent,
  type ProductRenderGroup,
  type RenderSection,
} from "@/lib/render/group-jobs";
import type { RenderJob, RenderJobOutput } from "@/types/render-job";

/** Under this much retention left, the countdown turns urgent. */
const URGENT_MS = 2 * 3600_000;

function formatDuration(ms: number): string {
  if (ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const STATUS_META: Record<
  RenderJob["status"],
  { label: string; icon: typeof Clock; className: string }
> = {
  queued: { label: "Đang chờ GPU", icon: Clock, className: "text-muted-foreground" },
  running: { label: "Đang render", icon: Loader2, className: "text-blue-500" },
  succeeded: { label: "Hoàn thành", icon: CheckCircle2, className: "text-green-500" },
  failed: { label: "Thất bại", icon: XCircle, className: "text-destructive" },
  canceled: { label: "Đã huỷ", icon: Ban, className: "text-muted-foreground" },
};

interface RenderProductCardProps {
  group: ProductRenderGroup;
  onCancel?: (jobId: string) => void;
  /** Re-queues one section's job from its frozen payload. */
  onRetry?: (jobId: string) => Promise<void>;
  /** Deletes one section's row and its Storage files. */
  onRemove?: (jobId: string) => Promise<void>;
  /** Deletes every terminal job on the card at once. */
  onRemoveGroup?: (jobIds: string[]) => Promise<void>;
  /** Collapsed by default when a batch fills the screen with finished cards. */
  defaultCollapsed?: boolean;
}

export function RenderProductCard({
  group,
  onCancel,
  onRetry,
  onRemove,
  onRemoveGroup,
  defaultCollapsed = false,
}: RenderProductCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [zipping, setZipping] = useState<DownloadProgress | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // Two-step delete: the first click arms, the second commits. A confirm()
  // dialog for something this small is heavier than the action deserves, but
  // deleting a render on a stray click is not recoverable — the files go too.
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Ticks only while something on the card is live, so a finished card is not
  // re-rendering once a second forever.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!group.live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [group.live]);

  const downloadable = downloadableSections(group);
  const hasFiles = downloadable.length > 0;
  const terminalJobIds = group.sections
    .filter((s) => s.job.status !== "queued" && s.job.status !== "running")
    .map((s) => s.job.id);

  async function handleRemoveGroup() {
    if (!onRemoveGroup || terminalJobIds.length === 0) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setRemoving(true);
    try {
      await onRemoveGroup(terminalJobIds);
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  async function handleDownloadAll() {
    setZipError(null);
    setZipping({ done: 0, total: group.fileCount });
    try {
      await downloadProductGroupAsZip(group, setZipping);
    } catch (err) {
      setZipError(err instanceof Error ? err.message : "Tải thất bại");
    } finally {
      setZipping(null);
    }
  }

  // What the header says about a card holding several jobs. "3 mục" alone does
  // not answer "did any fail", which is the only reason to open a finished card.
  const summary: string[] = [];
  if (group.counts.running > 0) summary.push(`${group.counts.running} đang render`);
  if (group.counts.queued > 0) summary.push(`${group.counts.queued} đang chờ`);
  if (group.counts.succeeded > 0) summary.push(`${group.counts.succeeded} xong`);
  if (group.counts.failed > 0) summary.push(`${group.counts.failed} lỗi`);
  if (group.counts.canceled > 0) summary.push(`${group.counts.canceled} đã huỷ`);

  const kinds = new Set(group.sections.map((s) => s.kind));

  // One definition, used by the inline bar and its narrow-screen fallback, so
  // the two can never disagree about what colour "done" is.
  const barTone =
    group.counts.failed > 0 && !group.live
      ? "bg-destructive"
      : !group.live && group.percent === 100
        ? "bg-green-500"
        : "bg-blue-500";

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Header: the product, and where all of its renders stand. Doubles as
          the collapse toggle — a finished batch is otherwise metres of
          thumbnails to scroll past. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((v) => !v);
          }
        }}
        className={cn(
          "flex cursor-pointer items-start justify-between gap-3 p-3 transition-colors hover:bg-muted/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !collapsed && "border-b"
        )}
      >
        <div className="flex min-w-0 shrink items-start gap-2">
          <ChevronDown
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              collapsed && "-rotate-90"
            )}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Both icons when the card holds images AND video, so the mix is
                  visible without opening it. */}
              {kinds.has("image") && (
                <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              {kinds.has("video") && (
                <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-medium">{group.productName}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {group.sections.length} mục
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {summary.length > 0 && (
                <span
                  className={cn(
                    group.counts.failed > 0
                      ? "text-destructive"
                      : group.live
                        ? "text-blue-500"
                        : "text-green-500"
                  )}
                >
                  {summary.join(" · ")}
                </span>
              )}
              {group.fileCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <ImageIcon className="h-3 w-3" />
                  {group.fileCount} file · {formatBytes(group.totalBytes)}
                </span>
              )}
            </div>

            {/* The target names, so a collapsed card still answers "which group
                did I render". Truncates rather than wrapping to a third line. */}
            {collapsed && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {group.sections.map((s) => s.targetName).join(" · ")}
              </p>
            )}

            {collapsed && group.errorMessage && (
              <p className="mt-1 truncate text-xs text-destructive">{group.errorMessage}</p>
            )}
          </div>
        </div>

        {/* Rolled-up progress, INLINE with the name and the percent.
            As a full-width bar under the header it sat directly above each
            section's own identical-looking bar, so two green lines stacked
            2px apart and neither read as belonging to anything. On the header
            row, flanked by the product name and the number it represents, it
            is unambiguously the product's total. */}
        <div className="hidden h-6 min-w-0 flex-1 items-center px-2 sm:flex">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                barTone
              )}
              style={{ width: `${Math.max(group.percent, group.live ? 3 : 0)}%` }}
            />
          </div>
        </div>

        <div className="flex shrink-0 items-start gap-2">
          {/* Just the percent: the file count already sits in the meta line
              beside its size, and repeating it here read as two different
              numbers about the same thing. */}
          <div className="flex h-6 items-center">
            <span
              className={cn(
                "text-lg font-semibold leading-none tabular-nums",
                group.counts.failed > 0 && !group.live && "text-destructive",
                !group.live && group.counts.failed === 0 && group.percent === 100 && "text-green-500"
              )}
            >
              {group.percent}%
            </span>
          </div>

          {/* In the header so it is reachable while collapsed, which is when a
              screen full of finished cards most needs clearing. Clears the whole
              product — per-section delete lives inside. */}
          {terminalJobIds.length > 0 && onRemoveGroup && (
            <button
              // The header is itself a toggle; without this the click would
              // collapse the card on its way to the delete.
              onClick={(e) => {
                e.stopPropagation();
                void handleRemoveGroup();
              }}
              onBlur={() => setConfirmRemove(false)}
              disabled={removing}
              title={
                confirmRemove
                  ? `Bấm lần nữa để xoá ${terminalJobIds.length} mục`
                  : `Xoá ${terminalJobIds.length} mục đã xong (kèm file)`
              }
              className={cn(
                "rounded-md p-1.5 transition-colors",
                "mt-0.5",
                confirmRemove
                  ? "bg-destructive text-destructive-foreground"
                  : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              )}
            >
              {removing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : confirmRemove ? (
                <Trash2 className="h-4 w-4" />
              ) : (
                <X className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Narrow screens have no room for the bar on the header row, so it drops
          below — still above the sections, but only where the inline one is
          hidden, so the two never both appear. */}
      <div className="px-3 pb-2 sm:hidden">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all duration-500", barTone)}
            style={{ width: `${Math.max(group.percent, group.live ? 3 : 0)}%` }}
          />
        </div>
      </div>

      {!collapsed && (
        <div className="divide-y">
          {group.sections.map((section) => (
            <SectionBlock
              key={section.job.id}
              section={section}
              now={now}
              onCancel={onCancel}
              onRetry={onRetry}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}

      {/* Card-level retention + download. One button takes the product's whole
          output, still foldered per section. */}
      {(hasFiles || group.allPurged) && (
        <div className="flex items-center justify-between gap-2 border-t p-3">
          <GroupRetentionLine group={group} now={now} />

          <div className="flex shrink-0 items-center gap-2">
            {zipError && <span className="text-xs text-destructive">{zipError}</span>}

            {hasFiles && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleDownloadAll()}
                disabled={zipping !== null}
                title={`Tải ${group.fileCount} file — mỗi mục một thư mục riêng`}
                className="gap-1.5"
              >
                {zipping ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {zipping.done}/{zipping.total}
                  </>
                ) : (
                  <>
                    <FileArchive className="h-3.5 w-3.5" />
                    Tải tất cả ({group.fileCount})
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One job inside the product card.
 *
 * Everything that used to be a whole card, minus the product name: the target
 * it rendered, its own status and phase timings, its file grid, its own
 * retention deadline, and its own cancel / retry / delete.
 */
function SectionBlock({
  section,
  now,
  onCancel,
  onRetry,
  onRemove,
}: {
  section: RenderSection;
  now: number;
  onCancel?: (jobId: string) => void;
  onRetry?: (jobId: string) => Promise<void>;
  onRemove?: (jobId: string) => Promise<void>;
}) {
  const { job, targetName, kind } = section;
  const [open, setOpen] = useState(true);
  const [zipping, setZipping] = useState<DownloadProgress | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const live = job.status === "queued" || job.status === "running";
  const meta = STATUS_META[job.status];
  const StatusIcon = meta.icon;
  const percent = jobPercent(job);

  const created = new Date(job.createdAt).getTime();
  const started = job.startedAt ? new Date(job.startedAt).getTime() : null;
  const finished = job.finishedAt ? new Date(job.finishedAt).getTime() : null;
  const waitMs = (started ?? now) - created;
  const renderMs = started ? (finished ?? now) - started : 0;
  const totalMs = (finished ?? now) - created;

  const perItemMs = job.progressDone > 0 ? renderMs / job.progressDone : null;
  const remaining = job.progressTotal - job.progressDone;
  const etaMs = perItemMs !== null && remaining > 0 ? perItemMs * remaining : null;

  const hasFiles = job.outputs.length > 0 && !job.purgedAt;
  const totalBytes = job.outputs.reduce((sum, o) => sum + (o.bytes ?? 0), 0);

  // Retry is offered on any terminal job: failed obviously, but also a purged
  // one (its files are gone, re-running is the only way back) and a canceled
  // one the user changed their mind about.
  const canRetry =
    job.status === "failed" ||
    job.status === "canceled" ||
    (job.status === "succeeded" && job.purgedAt !== null);

  async function handleRetry() {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry(job.id);
    } finally {
      setRetrying(false);
    }
  }

  async function handleRemove() {
    if (!onRemove) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setRemoving(true);
    try {
      await onRemove(job.id);
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  async function handleDownloadSection() {
    setZipError(null);
    setZipping({ done: 0, total: job.outputs.length });
    try {
      await downloadJobAsZip(job, setZipping);
    } catch (err) {
      setZipError(err instanceof Error ? err.message : "Tải thất bại");
    } finally {
      setZipping(null);
    }
  }

  return (
    <div className="bg-background/40">
      {/* Section header — the group/template name is the thing that was missing
          from the per-job cards entirely. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90"
            )}
          />
          {kind === "video" ? (
            <Film className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">{targetName}</span>
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", meta.className)}>
            <StatusIcon
              className={cn("h-3 w-3", job.status === "running" && "animate-spin")}
            />
            {meta.label}
          </span>
          {job.attempts > 1 && (
            <span className="shrink-0 text-xs text-amber-500">lần thử {job.attempts}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {hasFiles && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {job.outputs.length} file · {formatBytes(totalBytes)}
            </span>
          )}
          <span
            className={cn(
              "text-sm font-semibold tabular-nums",
              job.status === "failed" && "text-destructive",
              job.status === "succeeded" && "text-green-500"
            )}
          >
            {job.status === "failed" ? "—" : `${percent}%`}
          </span>

          {!live && onRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void handleRemove();
              }}
              onBlur={() => setConfirmRemove(false)}
              disabled={removing}
              title={confirmRemove ? "Bấm lần nữa để xoá mục này" : "Xoá mục này (kèm file)"}
              className={cn(
                "rounded p-1 transition-colors",
                confirmRemove
                  ? "bg-destructive text-destructive-foreground"
                  : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              )}
            >
              {removing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : confirmRemove ? (
                <Trash2 className="h-3.5 w-3.5" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {open && (
        <>
          <div className="space-y-2 px-3 pb-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  job.status === "failed"
                    ? "bg-destructive"
                    : job.status === "succeeded"
                      ? "bg-green-500"
                      : "bg-blue-500"
                )}
                style={{ width: `${Math.max(percent, job.status === "running" ? 3 : 0)}%` }}
              />
            </div>

            {job.progressLabel && (
              <p className="truncate text-xs text-foreground">{job.progressLabel}</p>
            )}

            {/* Phase timings — the part that makes a cold start stop looking
                like a hang. Only while it matters: on a finished section the
                three boxes were pure noise repeated per row. */}
            {(live || job.status === "failed") && (
              <div className="grid grid-cols-3 gap-2 pt-1 text-xs">
                <Timing
                  label="Chờ GPU"
                  value={formatDuration(waitMs)}
                  hint="Đánh thức pod, tải image"
                  active={job.status === "queued"}
                />
                <Timing
                  label="Render"
                  value={job.startedAt ? formatDuration(renderMs) : "—"}
                  hint={
                    perItemMs !== null ? `~${formatDuration(perItemMs)}/ảnh` : "Dựng scene, vẽ WebGL"
                  }
                  active={job.status === "running"}
                />
                <Timing
                  label={job.finishedAt ? "Tổng" : "Còn lại"}
                  value={
                    job.finishedAt
                      ? formatDuration(totalMs)
                      : etaMs !== null
                        ? `~${formatDuration(etaMs)}`
                        : "—"
                  }
                  hint={job.finishedAt ? "Từ lúc bấm render" : "Ước tính"}
                />
              </div>
            )}

            {/* A finished section keeps its total, just not the full grid. */}
            {!live && job.status !== "failed" && job.finishedAt && (
              <p className="text-xs text-muted-foreground">
                Render trong {formatDuration(totalMs)}
                {perItemMs !== null && kind === "image" && ` (~${formatDuration(perItemMs)}/ảnh)`}
                {job.workerProvider && (
                  <span className="ml-2 inline-flex items-center gap-1">
                    <Server className="h-3 w-3" />
                    {job.workerProvider}
                  </span>
                )}
              </p>
            )}

            {job.errorMessage && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="break-words text-xs text-muted-foreground">{job.errorMessage}</p>
              </div>
            )}
          </div>

          {/* Outputs — fill in one by one as the worker uploads them. A
              succeeded job with zero files is shown too: the image path
              swallows per-reference failures, so hiding the grid turned
              "rendered nothing" into a section that looked merely empty. */}
          {(job.outputs.length > 0 ||
            job.status === "running" ||
            (job.status === "succeeded" && !job.purgedAt)) && <OutputGrid job={job} />}

          {(hasFiles || job.purgedAt || canRetry || (live && onCancel)) && (
            <div className="flex items-center justify-between gap-2 px-3 pb-3">
              <RetentionLine job={job} now={now} />

              <div className="flex shrink-0 items-center gap-2">
                {zipError && <span className="text-xs text-destructive">{zipError}</span>}

                {hasFiles && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDownloadSection()}
                    disabled={zipping !== null}
                    className="h-7 gap-1.5 text-xs"
                  >
                    {zipping ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {zipping.done}/{zipping.total}
                      </>
                    ) : (
                      <>
                        <FileArchive className="h-3 w-3" />
                        Tải mục này ({job.outputs.length})
                      </>
                    )}
                  </Button>
                )}

                {canRetry && onRetry && (
                  <Button
                    variant={job.status === "failed" ? "default" : "outline"}
                    size="sm"
                    onClick={() => void handleRetry()}
                    disabled={retrying}
                    className="h-7 gap-1.5 text-xs"
                  >
                    {retrying ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Render lại
                  </Button>
                )}

                {live && onCancel && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => onCancel(job.id)}
                  >
                    Huỷ
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Timing({
  label,
  value,
  hint,
  active,
}: {
  label: string;
  value: string;
  hint: string;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1.5",
        active ? "border-blue-500/40 bg-blue-500/5" : "border-transparent bg-muted/40"
      )}
    >
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums text-foreground">{value}</div>
      <div className="truncate text-[10px] text-muted-foreground">{hint}</div>
    </div>
  );
}

/**
 * The per-file grid.
 *
 * Placeholders for files not produced yet make the "3 of 6" state visible as a
 * shape rather than a number — you can see at a glance which half is done.
 * Once the job is no longer running there is nothing still coming, so the
 * placeholders go away instead of spinning forever on a finished section.
 */
function OutputGrid({ job }: { job: RenderJob }) {
  const isLive = job.status === "queued" || job.status === "running";
  const expected = expectedFiles(job);
  const pending = isLive ? Math.max(0, expected - job.outputs.length) : 0;
  const missing = !isLive ? Math.max(0, expected - job.outputs.length) : 0;

  return (
    <div className="px-3 pb-3">
      {/* A succeeded job that produced fewer files than expected is otherwise
          indistinguishable from a complete one — the count is the only clue. */}
      {missing > 0 && (
        <p className="mb-2 text-xs text-amber-500">
          {job.outputs.length === 0
            ? `Không render được file nào (${expected} ảnh đều lỗi) — thử render lại.`
            : `${job.outputs.length}/${expected} file — ${missing} ảnh không render được.`}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {job.outputs.map((output) => (
          <OutputTile key={output.storagePath} output={output} />
        ))}
        {Array.from({ length: pending }).map((_, i) => (
          <div
            key={`pending-${i}`}
            className="flex aspect-square items-center justify-center rounded-md border border-dashed bg-muted/30"
          >
            <Loader2
              className={cn(
                "h-4 w-4 text-muted-foreground",
                // Only the next one up is actually being worked on.
                i === 0 && job.status === "running" && "animate-spin text-blue-500"
              )}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One finished file.
 *
 * The tile is for *watching*, not downloading: a video gets real controls so it
 * plays in place, and an image opens full size in a new tab. Downloading lives
 * in the small corner button — as a hover-only icon centred over the tile it
 * both hid the result and stole the click from playing it.
 */
function OutputTile({ output }: { output: RenderJobOutput }) {
  const isVideo = output.contentType.startsWith("video/");
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      await downloadOutput(output);
    } catch {
      // The file is one click away in the tile itself, so a failed fetch does
      // not need its own error surface.
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      className="group relative overflow-hidden rounded-md border bg-muted/30"
      title={`${output.name} · ${output.width}x${output.height} · ${formatBytes(output.bytes)}`}
    >
      <div className="relative aspect-square bg-black/20">
        {isVideo ? (
          <video
            src={output.url}
            className="h-full w-full object-contain"
            controls
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <a
            href={output.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block h-full w-full"
          >
            <Image
              src={output.url}
              alt={output.name}
              fill
              sizes="(max-width: 640px) 50vw, 200px"
              className="object-cover"
              unoptimized
            />
          </a>
        )}

        {/* Always visible: on a dark video frame a hover-only control is
            invisible, and on touch there is no hover at all. */}
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={downloading}
          aria-label={`Tải ${output.name}`}
          title={`Tải ${output.name}`}
          className="absolute right-1.5 top-1.5 z-10 rounded-md bg-black/60 p-1.5 text-white backdrop-blur-sm transition hover:bg-black/80 disabled:opacity-60"
        >
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <div className="p-1.5">
        <div className="truncate text-xs font-medium">{output.name}</div>
        <div className="text-[10px] tabular-nums text-muted-foreground">
          {output.width}×{output.height} · {formatBytes(output.bytes)}
        </div>
      </div>
    </div>
  );
}

/** The retention countdown for one section. */
function RetentionLine({ job, now }: { job: RenderJob; now: number }) {
  if (job.purgedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
        <Trash2 className="h-3.5 w-3.5" />
        Kết quả đã bị xoá — cần render lại
      </span>
    );
  }

  if (!job.expiresAt || job.outputs.length === 0) {
    return <span className="text-xs text-muted-foreground">&nbsp;</span>;
  }

  // Counts down to the purge SWEEP, not to expires_at: the hourly cron is what
  // actually deletes, so files outlive their expiry by up to an hour. See
  // lib/render/retention.ts.
  const remaining = msUntilPurge(job.expiresAt, now);
  const urgent = remaining < URGENT_MS;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        urgent ? "text-destructive" : "text-muted-foreground"
      )}
      title={`Đợt dọn: ${formatDeadlineClock(purgeDeadline(job.expiresAt), now)}`}
    >
      <Clock className="h-3.5 w-3.5" />
      {remaining <= 0
        ? "Đang chờ đợt dọn — tải ngay"
        : `Còn ~${formatDuration(remaining)} (dọn lúc ${formatDeadlineClock(purgeDeadline(job.expiresAt), now)})`}
    </span>
  );
}

/**
 * The card-level countdown: the SOONEST sweep among the sections.
 *
 * Sections rendered hours apart expire in different sweeps, so this says
 * "soonest" rather than implying one deadline for the whole product. The exact
 * per-section time stays on each section's own line.
 */
function GroupRetentionLine({
  group,
  now,
}: {
  group: ProductRenderGroup;
  now: number;
}) {
  if (group.allPurged) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
        <Trash2 className="h-3.5 w-3.5" />
        Kết quả đã bị xoá — cần render lại
      </span>
    );
  }

  if (!group.expiresAt) {
    return <span className="text-xs text-muted-foreground">&nbsp;</span>;
  }

  const deadlines = new Set(
    group.sections
      .filter((s) => !s.job.purgedAt && s.job.outputs.length > 0 && s.job.expiresAt)
      .map((s) => purgeDeadline(s.job.expiresAt as string).getTime())
  );
  const several = deadlines.size > 1;

  const remaining = msUntilPurge(group.expiresAt, now);
  const urgent = remaining < URGENT_MS;
  const clock = formatDeadlineClock(purgeDeadline(group.expiresAt), now);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        urgent ? "text-destructive" : "text-muted-foreground"
      )}
      title={
        several
          ? `Mỗi mục có mốc riêng — sớm nhất: ${clock}`
          : `Đợt dọn: ${clock}`
      }
    >
      <Clock className="h-3.5 w-3.5" />
      {remaining <= 0
        ? "Đang chờ đợt dọn — tải ngay"
        : `${several ? "Sớm nhất còn" : "Còn"} ~${formatDuration(remaining)} (dọn lúc ${clock})`}
    </span>
  );
}
