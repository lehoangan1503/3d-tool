"use client";

/**
 * One render job, with the detail an operator actually needs while waiting.
 *
 * A GPU render is a black box for its first ~20 seconds: the pod is cold, no
 * pixels exist yet, and a bare spinner is indistinguishable from a hang. So
 * this shows WHICH phase the job is in, WHICH reference is on the card right
 * now, how long each phase took, and a per-image grid that fills in as uploads
 * land — the same order the worker produces them.
 *
 * Timings come from the job's own timestamps (createdAt / startedAt /
 * finishedAt) rather than a local stopwatch, so they stay correct across a
 * page reload and across the poll interval.
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
import { downloadJobAsZip, type DownloadProgress } from "@/lib/render/download-outputs";
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

/**
 * The phase breakdown, derived from timestamps.
 *
 * "Chờ GPU" (createdAt → startedAt) is the cold start — usually the single
 * biggest chunk on a small job, and the one that looks like a freeze if it is
 * not named. Separating it from render time is what makes a 53s job legible as
 * "17s waking the pod, 36s drawing".
 */
function usePhases(job: RenderJob, now: number) {
  const created = new Date(job.createdAt).getTime();
  const started = job.startedAt ? new Date(job.startedAt).getTime() : null;
  const finished = job.finishedAt ? new Date(job.finishedAt).getTime() : null;

  const waitMs = (started ?? now) - created;
  const renderMs = started ? (finished ?? now) - started : 0;
  const totalMs = (finished ?? now) - created;

  return { waitMs, renderMs, totalMs, started, finished };
}

interface RenderJobCardProps {
  job: RenderJob;
  onCancel?: (jobId: string) => void;
  /** Re-queues the job from its frozen payload; resolves when the new job exists. */
  onRetry?: (jobId: string) => Promise<void>;
  /** Deletes the row and its Storage files. Only offered on terminal jobs. */
  onRemove?: (jobId: string) => Promise<void>;
  /** Collapsed by default when a batch fills the screen with finished jobs. */
  defaultCollapsed?: boolean;
}

export function RenderJobCard({
  job,
  onCancel,
  onRetry,
  onRemove,
  defaultCollapsed = false,
}: RenderJobCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [zipping, setZipping] = useState<DownloadProgress | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Two-step delete: the first click arms, the second commits. A confirm()
  // dialog for something this small is heavier than the action deserves, but
  // deleting a render on a stray click is not recoverable — the files go too.
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Ticks only while the job is live, so a finished card is not re-rendering
  // once a second forever.
  const live = job.status === "queued" || job.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const { waitMs, renderMs, totalMs } = usePhases(job, now);
  const meta = STATUS_META[job.status];
  const StatusIcon = meta.icon;

  // A failed job must not read as 100%. The worker's last heartbeat can leave
  // progress_done == progress_total (it failed while finishing the final item,
  // or during upload), so the raw ratio says "complete" for a job that produced
  // nothing — the exact confusion in the screenshot that prompted this.
  const rawPercent =
    job.progressTotal > 0 ? Math.round((job.progressDone / job.progressTotal) * 100) : 0;
  const percent =
    job.status === "succeeded"
      ? 100
      : job.status === "failed" || job.status === "canceled"
        ? Math.min(rawPercent, 99)
        : rawPercent;

  // Average per-image time, used for the estimate. Only meaningful once at
  // least one image is done — before that any number would be invented.
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
      // The card usually unmounts here; resetting matters when the delete
      // failed and the card is still on screen.
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  async function handleDownloadAll() {
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
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Header: what is being rendered, and where it stands. Doubles as the
          collapse toggle — a finished batch of 5 products is otherwise metres
          of thumbnails to scroll past. */}
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
        <div className="flex min-w-0 items-start gap-2">
          <ChevronDown
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              collapsed && "-rotate-90"
            )}
          />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {job.kind === "video" ? (
              <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="font-medium truncate">{job.productName ?? job.productId}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className={cn("inline-flex items-center gap-1", meta.className)}>
              <StatusIcon className={cn("h-3.5 w-3.5", job.status === "running" && "animate-spin")} />
              {meta.label}
            </span>
            {job.workerProvider && (
              <span className="inline-flex items-center gap-1">
                <Server className="h-3 w-3" />
                {job.workerProvider}
              </span>
            )}
            {job.attempts > 1 && (
              <span className="text-amber-500">lần thử {job.attempts}</span>
            )}
            {/* Collapsed cards still have to answer "is it done, and how big" */}
            {collapsed && hasFiles && (
              <span className="inline-flex items-center gap-1">
                <ImageIcon className="h-3 w-3" />
                {job.outputs.length} file · {formatBytes(totalBytes)}
              </span>
            )}
          </div>

          {/* A failed card that is folded shut would otherwise hide the one
              thing worth reading. Truncated here, full text once expanded. */}
          {collapsed && job.errorMessage && (
            <p className="mt-1 truncate text-xs text-destructive">{job.errorMessage}</p>
          )}
        </div>
        </div>

        <div className="flex shrink-0 items-start gap-2">
          <div className="text-right">
            <div
              className={cn(
                "text-lg font-semibold tabular-nums",
                job.status === "failed" && "text-destructive",
                job.status === "succeeded" && "text-green-500"
              )}
            >
              {job.status === "failed" ? "—" : `${percent}%`}
            </div>
            <div className="text-xs tabular-nums text-muted-foreground">
              {job.progressDone}/{job.progressTotal || "?"}
            </div>
          </div>

          {/* In the header so it is reachable while collapsed, which is when a
              screen full of finished cards most needs clearing. */}
          {!live && onRemove && (
            <button
              // The header is itself a toggle; without this the click would
              // collapse the card on its way to the delete.
              onClick={(e) => {
                e.stopPropagation();
                void handleRemove();
              }}
              onBlur={() => setConfirmRemove(false)}
              disabled={removing}
              title={confirmRemove ? "Bấm lần nữa để xoá" : "Xoá job và file"}
              className={cn(
                "rounded-md p-1.5 transition-colors",
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

      {!collapsed && (
        <>
      {/* Progress bar + the reference currently on the card */}
      <div className="p-3 space-y-2">
        <div className="h-2 rounded-full bg-muted overflow-hidden">
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
          <p className="text-sm text-foreground truncate">{job.progressLabel}</p>
        )}

        {/* Phase timings — the part that makes a cold start stop looking like a hang */}
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
              perItemMs !== null
                ? `~${formatDuration(perItemMs)}/ảnh`
                : "Dựng scene, vẽ WebGL"
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

        {job.errorMessage && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="text-xs text-muted-foreground break-words">{job.errorMessage}</p>
          </div>
        )}
      </div>

      {/* Outputs — fill in one by one as the worker uploads them */}
      {(job.outputs.length > 0 || job.status === "running") && (
        <OutputGrid job={job} />
      )}
        </>
      )}

      {/* Retention + actions. Rendered only when it has content: a collapsed
          card with no files and nothing to do would otherwise show an empty
          bordered strip under the header. */}
      {(hasFiles || job.purgedAt || canRetry || (live && onCancel)) && (
      <div className="flex items-center justify-between gap-2 border-t p-3">
        <RetentionLine job={job} now={now} />

        <div className="flex shrink-0 items-center gap-2">
          {zipError && <span className="text-xs text-destructive">{zipError}</span>}

          {hasFiles && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleDownloadAll()}
              disabled={zipping !== null}
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
                  Tải tất cả ({job.outputs.length})
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
              className="gap-1.5"
            >
              {retrying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Render lại
            </Button>
          )}

          {live && onCancel && (
            <Button variant="ghost" size="sm" onClick={() => onCancel(job.id)}>
              Huỷ
            </Button>
          )}
        </div>
      </div>
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
      <div className="text-[10px] text-muted-foreground truncate">{hint}</div>
    </div>
  );
}

/**
 * The per-file grid.
 *
 * Placeholders for files not produced yet make the "3 of 6" state visible as a
 * shape rather than a number — you can see at a glance which half is done.
 */
function OutputGrid({ job }: { job: RenderJob }) {
  const pending = Math.max(0, job.progressTotal - job.outputs.length);

  return (
    <div className="border-t p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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

function OutputTile({ output }: { output: RenderJobOutput }) {
  const isVideo = output.contentType.startsWith("video/");

  return (
    <a
      href={output.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block overflow-hidden rounded-md border bg-muted/30"
      title={`${output.name} · ${output.width}x${output.height} · ${formatBytes(output.bytes)}`}
    >
      <div className="relative aspect-square">
        {isVideo ? (
          <video
            src={output.url}
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <Image
            src={output.url}
            alt={output.name}
            fill
            sizes="(max-width: 640px) 50vw, 200px"
            className="object-cover"
            unoptimized
          />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/50 group-hover:opacity-100">
          <Download className="h-5 w-5 text-white" />
        </div>
      </div>
      <div className="p-1.5">
        <div className="truncate text-xs font-medium">{output.name}</div>
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {output.width}×{output.height} · {formatBytes(output.bytes)}
        </div>
      </div>
    </a>
  );
}

/** The retention countdown, per job. */
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
