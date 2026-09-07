import { NextResponse } from "next/server";
import { createAdminServiceClient } from "@/lib/supabase/server";
import { asRenderDbClient } from "@/lib/render/supabase-surface";
import { requireApiToken } from "@/lib/api-tokens/auth";
import { loadRenderCatalog } from "@/lib/api-tokens/render-catalog";
import { errorResponse } from "@/lib/render/enqueue";

/**
 * GET /api/v1/render-targets — everything POST /api/v1/renders can be pointed at.
 *
 * The discovery half of the render API. An agent that has just created a
 * product knows the product but not what to render it against, so it reads
 * this once, matches the operator's words ("nhóm NOVERA-D") against the names,
 * and then names that target in the render call — no ids ever have to survive
 * a prompt.
 *
 *   curl -H "Authorization: Bearer cue_live_..." https://app/api/v1/render-targets
 *
 * Three lists, because they are three different renders:
 *   groups          — a saved set of 2D layouts; one job, N files
 *   references      — individual 2D layouts, nameable on their own
 *   video_templates — a 3D studio template; one job, one clip
 *
 * Not scoped to the token's owner, and that matches the dashboard: these three
 * tables are global here (GET /api/extractor-references returns every row to
 * any signed-in user), so a token sees exactly what its owner sees. Products,
 * which are per-user, are NOT listed by this route — the caller already has
 * the product it just created, and listing someone's catalogue of designs to a
 * leaked token would be a real disclosure.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireApiToken(request);
    if (!auth.ok) return auth.response;

    // Service client: a bearer request has no session for RLS to evaluate.
    // Safe without a per-user filter precisely because these three tables are
    // global — see the note above.
    const db = asRenderDbClient(createAdminServiceClient());
    const catalog = await loadRenderCatalog(db);

    return NextResponse.json({
      // Snake_case here, camelCase inside the app: this is the external
      // contract, and it matches the request bodies an agent writes.
      groups: catalog.groups.map((group) => ({
        id: group.id,
        name: group.name,
        reference_count: group.referenceCount,
      })),
      references: catalog.references.map((reference) => ({
        id: reference.id,
        name: reference.name,
        thumb_url: reference.thumbUrl,
      })),
      video_templates: catalog.videoTemplates.map((template) => ({
        id: template.id,
        name: template.name,
      })),
      /**
       * Inlined usage, so an agent that reads this response needs nothing
       * else to make the next call. Cheap to send and it removes the most
       * common failure — a model inventing a body shape.
       */
      usage: {
        render_endpoint: "POST /api/v1/renders",
        note:
          "Send names from the lists above (case- and accent-insensitive) or their ids. " +
          "groups / references / video_templates may be combined in ONE request — each " +
          "group and each video template becomes its own job, and all loose references " +
          "become one job together.",
        examples: [
          { product: "<product id or name>", groups: ["<group name>"] },
          { product: "<product id or name>", references: ["<reference name>"] },
          { product: "<product id or name>", video_templates: ["<template name>"] },
          {
            product: "<product id or name>",
            groups: ["<group name>", "<another group>"],
            references: ["<loose reference>"],
            video_templates: ["<template name>"],
          },
        ],
      },
    });
  } catch (error) {
    return errorResponse(error, "GET /api/v1/render-targets");
  }
}
