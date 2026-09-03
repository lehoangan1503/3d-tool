import { NextResponse } from "next/server";
import { requireWorker } from "@/lib/render/worker-auth";
import { renderExpiryFrom } from "@/lib/render/purge";
import type { RenderCompleteRequest, RenderJobOutput } from "@/types/render-job";

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

/**
 * POST /api/render-worker/[jobId]/complete
 *
 * Final transition. Outputs were already appended one-by-one by the upload
 * route, so `outputs` here is optional — send it only to override the order
 * (the worker sorts mockups into gallery order: Mockup-Web-1, -2, ...).
 *
 * A canceled job is left canceled: the user's decision wins over a worker that
 * finished a moment too late.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const auth = requireWorker(request);
    if (!auth.ok) return auth.response;

    const body = (await request.json()) as RenderCompleteRequest;
    const status = body.status === "failed" ? "failed" : "succeeded";

    // The retention clock starts HERE, not at enqueue: a job that waited hours
    // in the queue still owes its owner a full window to download.
    const finishedAt = new Date();

    const update: Record<string, unknown> = {
      status,
      finished_at: finishedAt.toISOString(),
      expires_at: renderExpiryFrom(finishedAt),
      lease_until: null,
      error_message: status === "failed" ? (body.errorMessage ?? "Render failed").slice(0, 2000) : null,
    };

    if (Array.isArray(body.outputs)) {
      update.outputs = body.outputs satisfies RenderJobOutput[];
      if (status === "succeeded") {
        update.progress_done = body.outputs.length;
        update.progress_total = body.outputs.length;
      }
    }

    const { data, error } = await auth.ctx.admin
      .from("render_jobs")
      .update(update)
      .eq("id", jobId)
      .eq("status", "running")
      .select<{ id: string; status: string; outputs: RenderJobOutput[] | null }>(
        "id, status, outputs"
      )
      .maybeSingle();

    if (error) {
      console.error("[render-worker] complete failed:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      const { data: current } = await auth.ctx.admin
        .from("render_jobs")
        .select<{ status: string }>("status")
        .eq("id", jobId)
        .maybeSingle();
      const currentStatus = current?.status ?? "missing";
      return NextResponse.json(
        { ok: false, reason: `Job is "${currentStatus}", not "running"` },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, status: data.status });
  } catch (error) {
    console.error("POST /api/render-worker/[jobId]/complete error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
