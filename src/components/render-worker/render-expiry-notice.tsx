"use client";

/**
 * The "download it now" banner for server-rendered results.
 *
 * Render output lives in Storage for 24h and is then deleted — a 1920x1080
 * clip is tens of MB and a batch produces one per product, so keeping them is
 * not free. The user has no way to know that from looking at a gallery of
 * finished images, so the deadline has to be on screen next to them.
 *
 * It shows a real countdown rather than the words "24 hours", because by the
 * time somebody reopens the page the honest answer is usually "3 hours left",
 * and "24 hours" would then be a lie that costs them the files.
 *
 * The countdown targets the PURGE SWEEP, not `expires_at` — see
 * lib/render/retention.ts. Files outlive their expiry until the hourly cron
 * collects them, so counting to `expires_at` would hit zero with the files
 * still sitting there.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Clock, Download, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatDeadlineClock,
  formatRemaining,
  msUntilPurge,
  purgeDeadline,
} from "@/lib/render/retention";
import type { RenderJob } from "@/types/render-job";

/** Under this much time left, the banner switches to the urgent styling. */
const URGENT_MS = 2 * 3600_000;

interface RenderExpiryNoticeProps {
  /** The jobs whose results are on screen. The soonest sweep wins. */
  jobs: RenderJob[];
  className?: string;
}

export function RenderExpiryNotice({ jobs, className }: RenderExpiryNoticeProps) {
  // Recomputed on a timer, not just on render: the user leaves this page open.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const purged = jobs.filter((job) => job.purgedAt !== null);

  // Only jobs that still HAVE files get a countdown. A purged job keeps its
  // expires_at, so filtering on that alone would count down for files that are
  // already gone.
  // Deadlines are SWEEP times, so jobs finished minutes apart collapse onto the
  // same value — which is the truth: one cron run takes them both.
  const deadlines = jobs
    .filter((job) => job.purgedAt === null && job.outputs.length > 0 && job.expiresAt)
    .map((job) => purgeDeadline(job.expiresAt as string).getTime())
    .filter((t) => Number.isFinite(t));

  if (deadlines.length === 0 && purged.length === 0) return null;

  // Purged results are the more urgent message: the files are already gone, so
  // a countdown about the remaining ones would bury it.
  if (purged.length > 0 && deadlines.length === 0) {
    return (
      <div
        className={cn(
          "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2",
          className
        )}
      >
        <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <p className="text-sm text-muted-foreground">
          Kết quả của {purged.length === jobs.length ? "lần render này" : `${purged.length} job`} đã
          bị xoá sau thời gian lưu trữ.{" "}
          <span className="text-foreground">Bấm render lại để tạo file mới.</span>
        </p>
      </div>
    );
  }

  const soonest = Math.min(...deadlines);
  const remaining = soonest - now;
  // More than one distinct sweep on screen: the banner speaks for the earliest
  // and says so, instead of quietly applying that number to newer jobs too.
  // Per-job times stay exact on each card.
  const multipleSweeps = new Set(deadlines).size > 1;
  const expired = remaining <= 0;
  const urgent = expired || remaining < URGENT_MS;

  const Icon = expired ? AlertTriangle : urgent ? AlertTriangle : Clock;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2",
        urgent
          ? "border-destructive/40 bg-destructive/10"
          : "border-amber-500/40 bg-amber-500/10",
        className
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          urgent ? "text-destructive" : "text-amber-500"
        )}
      />
      <div className="text-sm text-muted-foreground">
        {expired ? (
          <>
            <span className="font-medium text-foreground">
              Đợt dọn tiếp theo sẽ xoá kết quả bất cứ lúc nào.
            </span>{" "}
            Tải về ngay nếu còn cần.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">
              {multipleSweeps ? "Sớm nhất: xoá" : "Tải về ngay — kết quả sẽ bị xoá"} sau khoảng{" "}
              {formatRemaining(remaining)}
              {" "}({formatDeadlineClock(new Date(soonest), now)}).
            </span>{" "}
            {multipleSweeps
              ? "Job mới hơn giữ lâu hơn — xem thời gian riêng trên từng job."
              : "Ảnh và video render nằm trên server tạm thời, không lưu vĩnh viễn."}
          </>
        )}
        {purged.length > 0 && (
          <span className="block text-destructive">
            {purged.length} job cũ đã bị xoá kết quả — cần render lại.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The same deadline as a compact inline label, for a card or a table row where
 * the full banner would not fit.
 */
export function RenderExpiryBadge({ job }: { job: RenderJob }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (job.purgedAt) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive">
        <Trash2 className="h-3 w-3" /> Đã xoá
      </span>
    );
  }

  if (!job.expiresAt || job.outputs.length === 0) return null;

  // Same sweep-based deadline as the banner, so the two never disagree.
  const remaining = msUntilPurge(job.expiresAt, now);
  if (!Number.isFinite(remaining)) return null;

  const urgent = remaining < URGENT_MS;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        urgent ? "text-destructive" : "text-muted-foreground"
      )}
    >
      <Download className="h-3 w-3" />
      {remaining <= 0 ? "Đang chờ xoá" : `Còn ${formatRemaining(remaining)}`}
    </span>
  );
}
