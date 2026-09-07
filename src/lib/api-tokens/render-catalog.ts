/**
 * Resolving render targets by NAME, for the token API.
 *
 * The dashboard picks targets from a list and sends ids. An AI agent has no
 * list — it has whatever the operator wrote in a prompt ("render nhóm
 * NOVERA-D"), so /api/v1 accepts a name where the dashboard takes an id, and
 * this module is the single place that turns one into the other.
 *
 * Two rules keep name-matching from being a guess:
 *
 *   1. An ambiguous name is a 400 that LISTS the candidates and their ids,
 *      never a silent pick of the first row. Two groups called "NOVERA-D"
 *      would otherwise render whichever one Postgres happened to return.
 *   2. Matching is exact (case- and diacritic-insensitive), not fuzzy. A
 *      near-miss must fail loudly with the available names, because a wrong
 *      target that renders successfully costs GPU minutes and produces files
 *      the operator has to notice are wrong.
 *
 * Ids are accepted too, so a caller that already knows one skips all of this.
 */

import type { RenderDbClient } from "@/lib/render/supabase-surface";
import { RenderPayloadError } from "@/lib/render/build-payload";

/**
 * The kinds of thing a name may be resolved to.
 *
 * `product` is not a render target — it is what gets rendered — but it goes
 * through the same name matching, and being in this union is what makes its
 * error messages say "product not found" instead of borrowing another kind's
 * wording.
 */
export type RenderTargetKind = "group" | "reference" | "video-template" | "product";

/** One entry in the catalogue an agent reads before rendering. */
export interface RenderTargetSummary {
  id: string;
  name: string;
  kind: Exclude<RenderTargetKind, "product">;
}

/** An image group, plus how many layouts it renders. */
export interface RenderGroupSummary extends RenderTargetSummary {
  kind: "group";
  /** How many files a render of the whole group produces. */
  referenceCount: number;
  referenceIds: string[];
}

export interface RenderReferenceSummary extends RenderTargetSummary {
  kind: "reference";
  thumbUrl: string | null;
}

export interface RenderVideoTemplateSummary extends RenderTargetSummary {
  kind: "video-template";
  /** The template's own product, when it was saved against one. */
  productId: string | null;
}

/** GET /api/v1/render-targets — everything a caller may name. */
export interface RenderCatalog {
  groups: RenderGroupSummary[];
  references: RenderReferenceSummary[];
  videoTemplates: RenderVideoTemplateSummary[];
}

/**
 * A v4 UUID, which is what every id in this schema is.
 *
 * Used to decide "did the caller send an id or a name?" rather than to
 * validate: a name that happens to look like a UUID is not a case worth
 * handling, and a malformed id falls through to name matching and produces a
 * "not found" listing the real names — which is the more useful error anyway.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeId(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/**
 * The key names are compared on.
 *
 * Diacritics are stripped and case folded so "Gậy Da" matches "gay da": the
 * operator types these into a prompt, and an agent relays them through
 * however many layers of quoting, any of which may mangle the accents.
 * Whitespace runs collapse for the same reason.
 */
function matchKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

interface NamedRow {
  id: string;
  name: string;
}

/** How a target is described in an error message. */
const KIND_LABELS: Record<RenderTargetKind, string> = {
  group: "image group",
  reference: "reference",
  "video-template": "video template",
  product: "product",
};

/**
 * Resolves one name (or id) against a list of candidates.
 *
 * Takes the candidates rather than querying, so a caller resolving five names
 * reads the table once — and so the "available names" in an error come from
 * the same snapshot the match was attempted against.
 */
export function resolveTargetName<T extends NamedRow>(
  kind: RenderTargetKind,
  wanted: string,
  candidates: T[]
): T {
  const trimmed = wanted.trim();
  if (trimmed.length === 0) {
    throw new RenderPayloadError(`Empty ${KIND_LABELS[kind]} name`);
  }

  if (looksLikeId(trimmed)) {
    const byId = candidates.find((row) => row.id === trimmed.toLowerCase());
    if (byId) return byId;
    throw new RenderPayloadError(
      `${KIND_LABELS[kind]} not found: ${trimmed}`,
      404
    );
  }

  const key = matchKey(trimmed);
  const matches = candidates.filter((row) => matchKey(row.name) === key);

  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    // Listing the ids is the whole point: the caller cannot disambiguate by
    // name — that is what made this ambiguous — so the response has to hand
    // over the only thing that can.
    throw new RenderPayloadError(
      `More than one ${KIND_LABELS[kind]} is called "${trimmed}". ` +
        `Send one of these ids instead: ${matches.map((m) => m.id).join(", ")}`
    );
  }

  // The available names, capped: a 404 the caller can act on beats a correct
  // but empty one, and an operator with 200 references does not need all of
  // them echoed back to see they mistyped.
  const available = candidates.slice(0, 25).map((row) => row.name);
  const suffix =
    candidates.length > available.length
      ? kind === "product"
        ? `, … (${candidates.length} total)`
        : `, … (${candidates.length} total — call GET /api/v1/render-targets for the full list)`
      : "";

  throw new RenderPayloadError(
    `${KIND_LABELS[kind]} not found: "${trimmed}". Available: ` +
      (available.length > 0 ? available.join(", ") + suffix : "(none yet)"),
    404
  );
}

/**
 * Loads every nameable render target.
 *
 * Groups, references and video templates are GLOBAL in this app — the
 * dashboard's own list routes return all of them to any signed-in user — so
 * this is not scoped to the token's owner. Products are the opposite and are
 * scoped by the caller (see assertProductsOwnedBy).
 *
 * Read in one pass and cached by the calling request, because resolving three
 * names must not become three round-trips per name.
 */
export async function loadRenderCatalog(
  supabase: RenderDbClient
): Promise<RenderCatalog> {
  const [groupsResult, referencesResult, templatesResult] = await Promise.all([
    supabase
      .from("extractor_reference_groups")
      .select<{ id: string; name: string; reference_ids: string[] | null }>(
        "id, name, reference_ids"
      )
      .order("name", { ascending: true }),
    supabase
      .from("extractor_references")
      .select<{ id: string; name: string; thumb_url: string | null }>(
        "id, name, thumb_url"
      )
      .order("name", { ascending: true }),
    supabase
      .from("video_studio_templates")
      .select<{ id: string; name: string; product_id: string | null }>(
        "id, name, product_id"
      )
      .order("name", { ascending: true }),
  ]);

  if (groupsResult.error) {
    throw new RenderPayloadError(
      `Failed to load image groups: ${groupsResult.error.message}`,
      500
    );
  }
  if (referencesResult.error) {
    throw new RenderPayloadError(
      `Failed to load references: ${referencesResult.error.message}`,
      500
    );
  }
  if (templatesResult.error) {
    throw new RenderPayloadError(
      `Failed to load video templates: ${templatesResult.error.message}`,
      500
    );
  }

  return {
    groups: (groupsResult.data ?? []).map((row) => {
      const referenceIds = (row.reference_ids ?? []).filter(Boolean);
      return {
        kind: "group" as const,
        id: row.id,
        name: row.name,
        referenceCount: referenceIds.length,
        referenceIds,
      };
    }),
    references: (referencesResult.data ?? []).map((row) => ({
      kind: "reference" as const,
      id: row.id,
      name: row.name,
      thumbUrl: row.thumb_url,
    })),
    videoTemplates: (templatesResult.data ?? []).map((row) => ({
      kind: "video-template" as const,
      id: row.id,
      name: row.name,
      productId: row.product_id,
    })),
  };
}
