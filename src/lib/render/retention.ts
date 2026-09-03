/**
 * When render output ACTUALLY disappears, as opposed to when it becomes
 * eligible to.
 *
 * `expires_at` is the moment a job's files qualify for deletion — but nothing
 * watches the clock. The collector is an hourly cron
 * (`scripts/purge-renders.sh`, minute :17), so a job that expires at 22:59 is
 * still downloadable until the 23:17 sweep. Counting down to `expires_at`
 * therefore UNDER-promises by up to a full hour: the banner would hit zero
 * while the files sit there, which teaches the operator to distrust the number
 * exactly when it starts mattering.
 *
 * Two consequences worth keeping in mind:
 *   - The honest deadline is the first cron tick at or after `expires_at`.
 *   - Jobs finished minutes apart usually die in the SAME sweep, so their real
 *     deadlines are identical even though their `expires_at` differ. Showing
 *     two different countdowns for them would be precision that isn't real.
 *
 * The background purge in the app (`maybePurgeInBackground`) can delete
 * earlier than the cron when someone queues a render. That only ever makes
 * files vanish sooner than promised, which is why the banner says "khoảng" —
 * this is a best-effort upper bound, not a guarantee.
 */

/**
 * Minute of the hour the purge cron fires. Must match the crontab installed on
 * the VPS (see the header of scripts/purge-renders.sh).
 */
export const PURGE_CRON_MINUTE = Number(
  process.env.NEXT_PUBLIC_PURGE_CRON_MINUTE ?? 17
);

/**
 * The first cron tick at or after `expiresAt` — i.e. when the files really go.
 *
 * Works in the viewer's local timezone, which is correct: cron runs on the
 * VPS's clock, and both are anchored to the same absolute instant here.
 */
export function purgeDeadline(expiresAt: string | Date): Date {
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return new Date(NaN);

  const deadline = new Date(expiry);
  deadline.setMinutes(PURGE_CRON_MINUTE, 0, 0);

  // Rolling the minute back can land BEFORE expiry (expires :59, cron :17), in
  // which case the sweep that collects it is the next hour's.
  if (deadline.getTime() < expiry.getTime()) {
    deadline.setTime(deadline.getTime() + 3600_000);
  }

  return deadline;
}

/** Milliseconds until the files are actually swept, from `now`. */
export function msUntilPurge(expiresAt: string | Date, now: number = Date.now()): number {
  return purgeDeadline(expiresAt).getTime() - now;
}

/** Formats a remaining duration the way a deadline reads. */
export function formatRemaining(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours >= 1) return `${hours} giờ ${minutes} phút`;
  if (totalMinutes >= 1) return `${totalMinutes} phút`;
  return "dưới 1 phút";
}

/** "23:17 hôm nay" / "23:17 ngày 05/09" — the concrete clock time to trust. */
export function formatDeadlineClock(deadline: Date, now: number = Date.now()): string {
  const hh = String(deadline.getHours()).padStart(2, "0");
  const mm = String(deadline.getMinutes()).padStart(2, "0");

  const today = new Date(now);
  const sameDay =
    deadline.getDate() === today.getDate() &&
    deadline.getMonth() === today.getMonth() &&
    deadline.getFullYear() === today.getFullYear();

  if (sameDay) return `${hh}:${mm} hôm nay`;

  const tomorrow = new Date(now + 86_400_000);
  const isTomorrow =
    deadline.getDate() === tomorrow.getDate() &&
    deadline.getMonth() === tomorrow.getMonth() &&
    deadline.getFullYear() === tomorrow.getFullYear();

  if (isTomorrow) return `${hh}:${mm} ngày mai`;

  const dd = String(deadline.getDate()).padStart(2, "0");
  const mo = String(deadline.getMonth() + 1).padStart(2, "0");
  return `${hh}:${mm} ngày ${dd}/${mo}`;
}
