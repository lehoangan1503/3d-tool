import { NextResponse } from "next/server";
import { requireWorker } from "@/lib/render/worker-auth";
import { purgeExpiredRenders, RENDER_TTL_HOURS } from "@/lib/render/purge";

/**
 * POST /api/render-worker/purge — the retention collector.
 *
 * Called by a cron on the VPS (see scripts/purge-renders.sh). It sits under
 * /api/render-worker because it needs exactly the same thing those routes do:
 * the service key, and a caller with no user session. Reusing
 * RENDER_WORKER_SECRET keeps this from being a second secret to rotate.
 *
 * Deliberately POST, not GET: it destroys data, so it must not be reachable by
 * a link preview, a crawler, or a browser prefetch.
 *
 * `?limit=` bounds one run. The response's `more` flag says whether the backlog
 * outlived this call — a cron catching up after downtime can loop until it is
 * false instead of waiting an hour per batch.
 */
export async function POST(request: Request) {
  try {
    const auth = requireWorker(request);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const parsed = parseInt(searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1000) : undefined;

    const result = await purgeExpiredRenders({ limit });

    console.log(
      `[render-purge] cron sweep: ${result.jobsPurged} job(s), ` +
        `${result.filesDeleted} file(s), ${result.jobsFailed} failed` +
        (result.more ? " (more remaining)" : "")
    );

    // 200 even with per-job failures: the sweep itself ran, and those jobs stay
    // due for the next one. A non-2xx here would make cron alerting fire on a
    // condition that self-heals.
    return NextResponse.json({ ...result, ttlHours: RENDER_TTL_HOURS });
  } catch (error) {
    console.error("POST /api/render-worker/purge error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
