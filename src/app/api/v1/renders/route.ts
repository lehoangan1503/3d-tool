import { NextResponse } from "next/server";
import {
  loadRenderCatalog,
  looksLikeId,
  resolveTargetName,
  type RenderCatalog,
} from "@/lib/api-tokens/render-catalog";
import { requireApiToken } from "@/lib/api-tokens/auth";
import {
  buildImagePayload,
  buildVideoPayload,
  loadGroupReferences,
  loadReferencesByIds,
  loadRenderProducts,
  loadVideoTemplate,
  RenderPayloadError,
} from "@/lib/render/build-payload";
import {
  apiTokenContext,
  assertProductsOwnedBy,
  errorResponse,
  insertAndDispatch,
  type EnqueueContext,
  type JobSeed,
} from "@/lib/render/enqueue";
import type { ApiRenderJob, ApiRenderQueued, ApiRenderRequest } from "@/types/api-token";
import type { RenderJob } from "@/types/render-job";

/**
 * POST /api/v1/renders — queue renders from outside the app.
 *
 * The counterpart to POST /api/v1/products: an agent creates a product from a
 * template, then renders it, without a human opening the dashboard in between.
 *
 *   curl -X POST https://app/api/v1/renders \
 *        -H "Authorization: Bearer cue_live_..." \
 *        -H "Content-Type: application/json" \
 *        -d '{"product":"n02-dragon-gold",
 *             "groups":["NOVERA-D","Ebay 1"],
 *             "references":["BAN1"],
 *             "video_templates":["Studio quay tròn"]}'
 *
 * Two things make this different from the dashboard's render endpoints:
 *
 *   1. Targets are NAMES. The operator says "render nhóm NOVERA-D" and the
 *      agent passes that through verbatim; ids work too. See
 *      render-catalog.ts for how a name is matched and why an ambiguous one
 *      is an error rather than a pick.
 *   2. Targets are MIXED. One call can carry groups, loose references and
 *      video templates together, because that is how the work actually
 *      arrives — an agent that has just built a product wants all of its
 *      renders started, not three round-trips it has to sequence itself.
 *
 * The fan-out is (targets x products) jobs, each its own row on the shared
 * queue. That is deliberate: one job per (product, target) is what lets
 * several GPU workers run the batch at once and lets one target fail without
 * taking the rest with it.
 *
 * Work runs on the same queue and the same GPU worker as the dashboard's
 * renders — this route only builds payloads and inserts rows. Nothing here
 * knows which provider claims them, which is what makes the planned local-GPU
 * worker a drop-in.
 */

/** Recording resolutions the worker's headless Chrome is sized for. */
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 2560;

/**
 * Ceiling on one request's fan-out, counted in JOBS rather than products.
 *
 * The per-endpoint product caps (20 images / 10 videos) were the right limit
 * when a call meant one target. Mixed targets multiply: 5 groups x 10 products
 * is 50 jobs from a body that looks small, so the cap has to sit on the
 * product of the two. Generous enough for real batches, low enough that a
 * malformed agent loop cannot fill the queue in one call.
 */
const MAX_JOBS_PER_REQUEST = 60;

/** Per-kind product ceilings, kept from the dashboard's own endpoints. */
const MAX_IMAGE_PRODUCTS = 20;
const MAX_VIDEO_PRODUCTS = 10;

/**
 * Resolves the products to render, by name or id.
 *
 * Scoped to the token's owner by hand — twice, deliberately. The name lookup
 * filters on user_id so a name can only ever match the caller's own product,
 * and assertProductsOwnedBy re-checks the final list so an id that arrived
 * directly gets the same treatment. This route runs on the service key, so
 * these two filters are the only thing standing where RLS normally does.
 */
async function resolveProductIdsByName(
  ctx: EnqueueContext,
  wanted: string[]
): Promise<string[]> {
  const trimmed = wanted.map((value) => value?.trim()).filter(Boolean) as string[];
  if (trimmed.length === 0) {
    throw new RenderPayloadError("`product` is required");
  }

  const names = trimmed.filter((value) => !looksLikeId(value));
  const resolved = new Map<string, string>();

  if (names.length > 0) {
    const { data, error } = await ctx.supabase
      .from("products")
      .select<{ id: string; name: string }>("id, name")
      .eq("user_id", ctx.userId);

    if (error) {
      throw new RenderPayloadError(`Failed to load products: ${error.message}`, 500);
    }

    const candidates = data ?? [];
    for (const name of names) {
      resolved.set(name, resolveTargetName("product", name, candidates).id);
    }
  }

  // De-duplicated with order preserved, so job order matches the request.
  const ids = trimmed.map((value) =>
    looksLikeId(value) ? value.toLowerCase() : resolved.get(value)!
  );
  return [...new Set(ids)];
}

/** A target, resolved to what a job needs, before products are fanned across it. */
type ResolvedTarget =
  | {
      kind: "image";
      /** Null for the loose-reference job: there is no group behind it. */
      groupId: string | null;
      groupName: string | null;
      references: Awaited<ReturnType<typeof loadReferencesByIds>>;
      label: string;
    }
  | {
      kind: "video";
      templateId: string;
      templateName: string;
      config: Awaited<ReturnType<typeof loadVideoTemplate>>["config"];
    };

/** Names/ids given for a field, trimmed and de-duplicated, order preserved. */
function normalizeNames(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value.length === 0) continue;
    // De-duplicated case-insensitively: "NOVERA-D" and "novera-d" resolve to
    // the same group, and queueing it twice would just bill twice.
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Turns the request's three name lists into resolved targets.
 *
 * Order is groups, then the loose-reference job, then video templates — the
 * order the fields are documented in, so the returned job list reads the way
 * the body was written.
 */
async function resolveTargets(
  ctx: EnqueueContext,
  catalog: RenderCatalog,
  body: ApiRenderRequest
): Promise<ResolvedTarget[]> {
  const groupNames = normalizeNames(body.groups);
  const referenceNames = normalizeNames(body.references);
  const templateNames = normalizeNames(body.video_templates);

  if (groupNames.length === 0 && referenceNames.length === 0 && templateNames.length === 0) {
    throw new RenderPayloadError(
      "Nothing to render. Send `groups`, `references` and/or `video_templates` " +
        "— call GET /api/v1/render-targets for the available names."
    );
  }

  const targets: ResolvedTarget[] = [];

  for (const name of groupNames) {
    const group = resolveTargetName("group", name, catalog.groups);
    const loaded = await loadGroupReferences(ctx.supabase, group.id);
    targets.push({
      kind: "image",
      groupId: group.id,
      groupName: loaded.groupName,
      references: loaded.references,
      label: loaded.groupName,
    });
  }

  if (referenceNames.length > 0) {
    // ONE job for the whole loose set, not one per reference: they render in
    // the same browser on the same loaded scene, exactly as a group does, so
    // splitting them would pay the scene-setup cost once per image.
    const referenceIds = referenceNames.map(
      (name) => resolveTargetName("reference", name, catalog.references).id
    );
    const references = await loadReferencesByIds(ctx.supabase, referenceIds);
    targets.push({
      kind: "image",
      groupId: null,
      groupName: null,
      references,
      label: references.map((reference) => reference.name).join(", "),
    });
  }

  for (const name of templateNames) {
    const template = resolveTargetName("video-template", name, catalog.videoTemplates);
    const loaded = await loadVideoTemplate(ctx.supabase, template.id);
    targets.push({
      kind: "video",
      templateId: template.id,
      templateName: loaded.templateName,
      config: loaded.config,
    });
  }

  return targets;
}

/** The external view of a queued job. */
function toApiJob(request: Request, job: RenderJob, target: string): ApiRenderJob {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    product_id: job.productId,
    product_name: job.productName,
    target,
    // A video's progress_total is a percentage, so it cannot double as a file
    // count here — a clip is always one file (see expectedFiles).
    expected_files: job.kind === "video" ? 1 : job.progressTotal,
    created_at: job.createdAt,
    status_url: new URL(`/api/v1/renders/${job.id}`, request.url).toString(),
  };
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;

    let body: ApiRenderRequest;
    try {
      body = (await request.json()) as ApiRenderRequest;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const ctx = apiTokenContext(auth.ctx.userId);

    const productIds = await resolveProductIdsByName(ctx, [
      body.product,
      ...(body.products ?? []),
    ]);

    // Ownership before targets: a token probing product ids gets its 404
    // having cost nothing but one indexed lookup.
    await assertProductsOwnedBy(ctx, productIds);

    const catalog = await loadRenderCatalog(ctx.supabase);
    const targets = await resolveTargets(ctx, catalog, body);

    const imageTargets = targets.filter((t) => t.kind === "image");
    const videoTargets = targets.filter((t) => t.kind === "video");

    // Per-kind product caps first, so the message names the actual limit the
    // caller hit rather than the aggregate one.
    if (imageTargets.length > 0 && productIds.length > MAX_IMAGE_PRODUCTS) {
      return NextResponse.json(
        { error: `Too many products for an image render (max ${MAX_IMAGE_PRODUCTS}).` },
        { status: 400 }
      );
    }
    if (videoTargets.length > 0 && productIds.length > MAX_VIDEO_PRODUCTS) {
      return NextResponse.json(
        { error: `Too many products for a video render (max ${MAX_VIDEO_PRODUCTS}).` },
        { status: 400 }
      );
    }

    const jobCount = targets.length * productIds.length;
    if (jobCount > MAX_JOBS_PER_REQUEST) {
      return NextResponse.json(
        {
          error:
            `That would queue ${jobCount} jobs (${targets.length} targets x ` +
            `${productIds.length} products); the limit is ${MAX_JOBS_PER_REQUEST}. ` +
            "Split it into several requests.",
        },
        { status: 400 }
      );
    }

    const products = await loadRenderProducts(ctx.supabase, productIds);

    const format = body.format === "jpeg" ? "jpeg" : "png";
    const quality =
      typeof body.quality === "number"
        ? Math.min(Math.max(body.quality, 0.1), 1)
        : 0.95;
    const width = Math.min(Math.max(body.width ?? 1920, 320), MAX_WIDTH);
    const height = Math.min(Math.max(body.height ?? 1080, 320), MAX_HEIGHT);
    const fps = Math.min(Math.max(body.fps ?? 60, 24), 120);

    // Seeds carry their own label so the response can name each job's target
    // after the rows come back — insertAndDispatch returns jobs in seed order,
    // but only per call, and image and video are two calls.
    const imageSeeds: { seed: JobSeed; label: string }[] = [];
    const videoSeeds: { seed: JobSeed; label: string }[] = [];

    // Targets outer, products inner: a mixed batch then reads
    // "NOVERA-D for both cues, then the video for both", which is the order the
    // body was written in.
    for (const target of targets) {
      for (const product of products) {
        if (target.kind === "image") {
          imageSeeds.push({
            label: target.label,
            seed: {
              productId: product.id,
              groupId: target.groupId,
              templateId: null,
              payload: buildImagePayload(
                product,
                target.groupId,
                target.groupName,
                target.references,
                format,
                quality
              ),
              progressTotal: target.references.length,
            },
          });
        } else {
          videoSeeds.push({
            label: target.templateName,
            seed: {
              productId: product.id,
              groupId: null,
              templateId: target.templateId,
              payload: buildVideoPayload(
                product,
                target.templateId,
                target.templateName,
                target.config,
                width,
                height,
                fps
              ),
              // Video progress is a percentage, not a frame count.
              progressTotal: 100,
            },
          });
        }
      }
    }

    // Two inserts, because a render_jobs row's `kind` is per-row and
    // insertAndDispatch dispatches a whole batch as one kind. Sequential
    // rather than parallel: both write the same table and the second is
    // usually the small one, so there is nothing to win by overlapping them,
    // and a failure part-way leaves the first batch queued and runnable.
    const jobs: ApiRenderJob[] = [];
    const warnings: string[] = [];

    if (imageSeeds.length > 0) {
      const result = await insertAndDispatch(
        ctx,
        request,
        "image",
        imageSeeds.map((entry) => entry.seed)
      );
      result.jobs.forEach((job, index) => {
        jobs.push(toApiJob(request, job, imageSeeds[index].label));
      });
      if (result.warning) warnings.push(result.warning);
    }

    if (videoSeeds.length > 0) {
      const result = await insertAndDispatch(
        ctx,
        request,
        "video",
        videoSeeds.map((entry) => entry.seed)
      );
      result.jobs.forEach((job, index) => {
        jobs.push(toApiJob(request, job, videoSeeds[index].label));
      });
      if (result.warning) warnings.push(result.warning);
    }

    const response: ApiRenderQueued = {
      jobs,
      // Both batches raise the same "no GPU configured" warning, so it is
      // de-duplicated rather than repeated.
      ...(warnings.length > 0 ? { warning: [...new Set(warnings)].join(" ") } : {}),
    };
    return NextResponse.json(response, { status: 202 });
  } catch (error) {
    return errorResponse(error, "POST /api/v1/renders");
  }
}
