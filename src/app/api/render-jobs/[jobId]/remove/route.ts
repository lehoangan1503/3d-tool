import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/render/enqueue";
import { RenderPayloadError } from "@/lib/render/build-payload";
import { asRenderStorageClient } from "@/lib/render/supabase-surface";
import { createAdminServiceClient } from "@/lib/supabase/server";
import type { RenderJobOutput } from "@/types/render-job";

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

const BUCKET = process.env.RENDER_OUTPUT_BUCKET ?? "product-assets";

/** The columns the delete path needs. */
interface JobRow {
  id: string;
  status: string;
  outputs: RenderJobOutput[] | null;
}

/**
 * POST /api/render-jobs/[jobId]/remove — delete a job row for good.
 *
 * Distinct from DELETE on the parent route, which CANCELS (flips status and
 * leaves the row for the record). This is the "clear it off my screen" action,
 * so the row actually goes.
 *
 * Storage files are deleted FIRST, and this is the reason the endpoint exists
 * rather than letting the client delete the row directly: `outputs` is the only
 * record of which objects belong to this job, so dropping the row first would
 * orphan every file it points at — invisible to the retention purge, which
 * finds work by scanning rows, and therefore paid for forever.
 *
 * Only terminal jobs may be removed. A queued or running job has a pod on the
 * way that would keep uploading to a row that no longer exists.
 */
export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const auth = await requireUser();
    if (!auth.ok) return auth.response;

    // Read through the user's own client so RLS decides what they may touch.
    const { data: job, error } = await auth.ctx.supabase
      .from("render_jobs")
      .select<JobRow>("id, status, outputs")
      .eq("id", jobId)
      .maybeSingle();

    if (error) {
      throw new RenderPayloadError(`Failed to load job: ${error.message}`, 500);
    }
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (!["succeeded", "failed", "canceled"].includes(job.status)) {
      return NextResponse.json(
        { error: `Job đang ${job.status} — huỷ trước khi xoá` },
        { status: 409 }
      );
    }

    // Storage writes need the service key (the same one the upload route uses);
    // a user session cannot remove objects from the bucket.
    const admin = asRenderStorageClient(createAdminServiceClient());

    const paths = (job.outputs ?? [])
      .map((output) => output.storagePath)
      .filter((path): path is string => Boolean(path));

    let filesDeleted = 0;

    if (paths.length > 0) {
      const { data: removed, error: removeError } = await admin.storage
        .from(BUCKET)
        .remove(paths);

      if (removeError) {
        // Stop rather than delete the row: losing the row now would strand
        // these files permanently. The user can retry the delete.
        console.error("[render-jobs] remove storage failed:", removeError);
        return NextResponse.json(
          { error: `Không xoá được file: ${removeError.message}` },
          { status: 500 }
        );
      }
      filesDeleted = (removed ?? []).length;
    }

    const { error: deleteError } = await auth.ctx.supabase
      .from("render_jobs")
      .delete()
      .eq("id", jobId);

    if (deleteError) {
      throw new RenderPayloadError(`Failed to delete job: ${deleteError.message}`, 500);
    }

    return NextResponse.json({ ok: true, filesDeleted });
  } catch (error) {
    return errorResponse(error, "POST /api/render-jobs/[jobId]/remove");
  }
}
