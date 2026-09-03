import { NextResponse } from "next/server";
import { requireWorker } from "@/lib/render/worker-auth";

/**
 * GET /api/render-worker/queue-depth
 *
 * A warm pod asks "is there more work?" before exiting. It must NOT claim to
 * find out: claiming here would flip a job to 'running' with no renderer
 * attached, and the job would only recover when its lease expired.
 *
 * Draining a warm card matters for cost — the cold start (container pull,
 * Chrome launch, model + HDRI download) dwarfs a single mockup, so one pod
 * taking several jobs is much cheaper than one pod per job.
 */
export async function GET(request: Request) {
  try {
    const auth = requireWorker(request);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const kind = searchParams.get("kind");

    let query = auth.ctx.admin
      .from("render_jobs")
      .select<{ id: string }>("id")
      .eq("status", "queued")
      .limit(50);

    if (kind === "image" || kind === "video") {
      query = query.eq("kind", kind);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[render-worker] queue depth failed:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ queued: (data ?? []).length });
  } catch (error) {
    console.error("GET /api/render-worker/queue-depth error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
