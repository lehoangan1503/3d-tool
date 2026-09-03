import { NextResponse } from "next/server";
import { requireWorker } from "@/lib/render/worker-auth";
import type { RenderProgressUpdate } from "@/types/render-job";

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

/**
 * PATCH /api/render-worker/[jobId]/progress
 *
 * The worker's heartbeat: reports "3/6 ảnh" and extends the lease so the job
 * is not reclaimed mid-render.
 *
 * The response carries `canceled`. The worker checks it on every beat and
 * aborts when true — that is what makes the user's Cancel button actually stop
 * the GPU meter instead of paying for a render nobody will collect.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const auth = requireWorker(request);
    if (!auth.ok) return auth.response;

    const body = (await request.json()) as RenderProgressUpdate & { leaseSeconds?: number };
    const done = Math.max(0, Math.floor(body.done ?? 0));
    const total = Math.max(0, Math.floor(body.total ?? 0));
    const leaseSeconds = Math.min(Math.max(body.leaseSeconds ?? 900, 60), 3600);

    const { data, error } = await auth.ctx.admin
      .from("render_jobs")
      .update({
        progress_done: done,
        progress_total: total,
        progress_label: body.label ?? null,
        lease_until: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
      })
      .eq("id", jobId)
      // A canceled job must not be dragged back into 'running' by a late beat.
      .in("status", ["running", "queued"])
      .select<{ id: string; status: string }>("id, status")
      .maybeSingle();

    if (error) {
      console.error("[render-worker] progress failed:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      // Either the job is gone or it left the running set — the worker reads
      // this as "stop now".
      const { data: current } = await auth.ctx.admin
        .from("render_jobs")
        .select<{ status: string }>("status")
        .eq("id", jobId)
        .maybeSingle();

      return NextResponse.json({
        ok: false,
        canceled: true,
        status: current?.status ?? "missing",
      });
    }

    return NextResponse.json({ ok: true, canceled: false, status: data.status });
  } catch (error) {
    console.error("PATCH /api/render-worker/[jobId]/progress error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
