import { NextResponse } from "next/server";
import { requireWorker } from "@/lib/render/worker-auth";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";
import type { RenderJobOutput } from "@/types/render-job";

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

/** The job fields the upload path needs. */
interface JobRow {
  id: string;
  user_id: string;
  product_id: string | null;
  kind: string;
  status: string;
  outputs: RenderJobOutput[] | null;
}

/** Bucket for render output. Separate from product-assets so renders can have
 *  their own lifecycle rule (they are regenerable and pile up fast). */
const BUCKET = process.env.RENDER_OUTPUT_BUCKET ?? "product-assets";

const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/webm",
  "video/mp4",
]);

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/webm": "webm",
  "video/mp4": "mp4",
};

/** Storage keys must be ASCII-safe; reference names contain spaces/diacritics. */
function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "render"
  );
}

/**
 * POST /api/render-worker/[jobId]/upload  (multipart/form-data)
 *
 * The worker streams each finished file here as soon as it is produced, so a
 * 6-image job shows results progressively instead of only at the end, and a
 * crash on image 5 does not lose images 1-4.
 *
 * Fields: file, name (reference/template name), width, height
 *
 * The worker uploads through this route rather than straight to Storage so the
 * service key never has to live inside the GPU container.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const auth = requireWorker(request);
    if (!auth.ok) return auth.response;

    // The job tells us who owns the output, so it lands in that user's folder.
    const { data: job, error: jobError } = await auth.ctx.admin
      .from("render_jobs")
      .select<JobRow>("id, user_id, product_id, kind, status, outputs")
      .eq("id", jobId)
      .maybeSingle();

    if (jobError) {
      return NextResponse.json({ error: jobError.message }, { status: 500 });
    }
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (job.status === "canceled") {
      // Don't bill Storage for a render the user already abandoned.
      return NextResponse.json({ error: "Job was canceled" }, { status: 409 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const contentType = file.type || "application/octet-stream";
    if (!ALLOWED.has(contentType)) {
      return NextResponse.json(
        { error: `Unsupported content type: ${contentType}` },
        { status: 400 }
      );
    }

    const rawName = (formData.get("name") as string | null) ?? "render";
    const width = parseInt((formData.get("width") as string | null) ?? "0", 10) || 0;
    const height = parseInt((formData.get("height") as string | null) ?? "0", 10) || 0;

    // jobId in the path keeps re-renders of the same group from overwriting an
    // earlier set the user may still be using.
    const ext = EXT[contentType] ?? "bin";
    const storagePath =
      `${job.user_id}/renders/${job.product_id ?? "no-product"}/${jobId}/` +
      `${slugify(rawName)}.${ext}`;

    const buffer = new Uint8Array(await file.arrayBuffer());

    const { error: uploadError } = await auth.ctx.admin.storage
      .from(BUCKET)
      .upload(storagePath, buffer, { contentType, upsert: true });

    if (uploadError) {
      console.error("[render-worker] upload failed:", uploadError);
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: urlData } = auth.ctx.admin.storage.from(BUCKET).getPublicUrl(storagePath);
    const publicUrl = resolveStorageUrl(urlData.publicUrl) ?? urlData.publicUrl;

    const output: RenderJobOutput = {
      name: rawName,
      url: publicUrl,
      storagePath,
      contentType,
      width,
      height,
      bytes: buffer.byteLength,
    };

    // Append so the UI can show each file the moment it lands. Re-uploads of
    // the same name replace the earlier entry (a retried reference).
    const existing = (job.outputs ?? []).filter((o) => o.storagePath !== storagePath);

    const { error: appendError } = await auth.ctx.admin
      .from("render_jobs")
      .update({ outputs: [...existing, output] })
      .eq("id", jobId);

    if (appendError) {
      console.error("[render-worker] output append failed:", appendError);
      return NextResponse.json({ error: appendError.message }, { status: 500 });
    }

    return NextResponse.json(output, { status: 201 });
  } catch (error) {
    console.error("POST /api/render-worker/[jobId]/upload error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
