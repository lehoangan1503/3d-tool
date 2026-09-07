import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-tokens/auth";
import { apiTokenContext, errorResponse } from "@/lib/render/enqueue";
import {
  mapRenderJob,
  RENDER_JOB_COLUMNS,
  type RenderJobRow,
} from "@/lib/render/job-mapper";
import { jobPercent } from "@/lib/render/group-jobs";
import { RenderPayloadError } from "@/lib/render/build-payload";
import { isImagePayload, isVideoPayload } from "@/types/render-job";
import type { RenderJobPayload } from "@/types/render-job";
import type { ApiRenderStatus } from "@/types/api-token";

/**
 * GET /api/v1/renders/[jobId] — poll one render.
 *
 * The other half of the agent loop: POST /api/v1/renders answers 202 with a
 * `status_url`, and this is it. Returns percent while running and the file
 * URLs once succeeded, so a caller never has to know about render_jobs, the
 * queue, or which GPU ran it.
 *
 * Poll politely — a render is tens of seconds to minutes, so every 5-10s is
 * plenty; the row only changes when the worker heartbeats.
 */

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

/**
 * What this job renders, read back from the frozen payload.
 *
 * The payload is the only place that still knows: `group_id` is null for an
 * ad-hoc reference set, and a group renamed since the render would otherwise
 * report a name that was never used for these files.
 */
function targetLabel(payload: RenderJobPayload | Record<string, never>): string {
  const typed = payload as RenderJobPayload;
  if (!typed?.kind) return "";
  if (isVideoPayload(typed)) return typed.templateName;
  if (isImagePayload(typed)) {
    return typed.groupName ?? typed.references.map((r) => r.name).join(", ");
  }
  return "";
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;

    // Deliberately NOT passing the admin flag: reading a job is scoped to the
    // token's owner even for an admin. A render queued through this API always
    // belongs to the token's owner, so there is no case where a token needs
    // someone else's job — and returning one would hand over its file URLs.
    const ctx = apiTokenContext(auth.ctx.userId);

    // Scoped to the token's owner by hand: this runs on the service key, so
    // without the user_id filter any token could read any job. A job belonging
    // to someone else answers 404, not 403 — a token must not be able to
    // confirm that an id exists.
    const { data, error } = await ctx.supabase
      .from("render_jobs")
      .select<RenderJobRow>(`${RENDER_JOB_COLUMNS}, payload`)
      .eq("id", jobId)
      .eq("user_id", ctx.userId)
      .maybeSingle();

    if (error) {
      throw new RenderPayloadError(`Failed to load render job: ${error.message}`, 500);
    }
    if (!data) {
      return NextResponse.json({ error: "Render job not found" }, { status: 404 });
    }

    // One extra read for the name, rather than attachProductNames: this is a
    // single row, and a polling caller reading "n02-dragon-gold" instead of a
    // uuid is worth one lookup.
    let productName: string | null = null;
    if (data.product_id) {
      const { data: product } = await ctx.supabase
        .from("products")
        .select<{ name: string }>("name")
        .eq("id", data.product_id)
        .maybeSingle();
      productName = product?.name ?? null;
    }

    const job = mapRenderJob(data, productName);

    const response: ApiRenderStatus = {
      id: job.id,
      kind: job.kind,
      status: job.status,
      percent: jobPercent(job),
      product_id: job.productId,
      product_name: job.productName,
      target: targetLabel(data.payload),
      error: job.errorMessage,
      created_at: job.createdAt,
      finished_at: job.finishedAt,
      // A purged job keeps its `outputs` empty by design, so this is naturally
      // [] once the files are swept — `expired` is what tells the two apart
      // from "this job produced nothing".
      files: job.outputs
        .filter((output) => Boolean(output.url))
        .map((output) => ({
          name: output.name,
          url: output.url,
          width: output.width,
          height: output.height,
          bytes: output.bytes,
        })),
      expires_at: job.expiresAt,
      expired: job.purgedAt !== null,
    };

    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error, "GET /api/v1/renders/[jobId]");
  }
}
