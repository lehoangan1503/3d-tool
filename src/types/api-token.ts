import type { ProductType } from "@/types/product";

/**
 * An API token row as the settings UI sees it.
 *
 * Deliberately has no `token_hash`: nothing outside the authentication path
 * needs it, and a type that omits it cannot leak it into a JSON response by
 * accident.
 */
export interface ApiTokenSummary {
  id: string;
  label: string;
  /** e.g. "cue_live_7f3a" — enough to identify, useless to authenticate. */
  token_prefix: string;
  /** Default prefix for products this token creates; a request may override it. */
  name_prefix: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/**
 * The one and only response that carries a usable secret.
 *
 * Returned by POST /api/api-tokens and never again — the database keeps only a
 * hash. The UI must tell the user to copy it now.
 */
export interface ApiTokenCreated extends ApiTokenSummary {
  /** Plaintext, shown once. */
  token: string;
}

export interface CreateApiTokenInput {
  label: string;
  name_prefix?: string | null;
}

export interface UpdateApiTokenInput {
  label?: string;
  name_prefix?: string | null;
  /** True revokes, false restores. */
  revoked?: boolean;
}

/** What a token authorises, resolved from a verified bearer credential. */
export interface ApiTokenContext {
  tokenId: string;
  userId: string;
  /** Default name prefix, overridable per request. The cue type is not here — see migration 037. */
  namePrefix: string | null;
}

/**
 * Shape of a product created through the API.
 *
 * Mirrors the dashboard's own create + upload result, so a caller sees the same
 * ids and URLs a person would.
 */
export interface ApiCreatedProduct {
  id: string;
  name: string;
  type: ProductType;
  surface_url: string | null;
  created_at: string;
  /** Deep link to the editor, so the caller can hand a human somewhere to look. */
  editor_url: string;
}

/**
 * POST /api/v1/renders — body.
 *
 * Every target field takes NAMES or ids (see render-catalog.ts). That is the
 * difference from the dashboard's own render endpoints, which only take ids:
 * an agent has the operator's words, not a picker.
 *
 * All three target lists are independent and may be combined freely — one
 * request can queue several groups, several video templates and a set of
 * loose references at once, which is what an agent finishing a product
 * actually wants ("render nhóm web, nhóm ebay, và cái video"). The fan-out is
 * (targets x products) jobs, so the whole batch runs in parallel across
 * workers rather than serialising behind one call per target.
 */
export interface ApiRenderRequest {
  /** Product to render. Name or id — resolved against the token owner's products. */
  product: string;
  /** Extra products: every target below is rendered for each of them too. */
  products?: string[];

  /** Image groups. Each becomes its own job rendering the whole group. */
  groups?: string[];
  /**
   * Individual layouts, rendered as ONE job in the order given.
   *
   * Independent of `groups` rather than a subset of it: with several groups in
   * play "a subset" has no single group to be a subset of, and an agent
   * listing both plainly means "these groups, plus these loose ones".
   */
  references?: string[];
  /** Video studio templates. Each becomes its own job recording one clip. */
  video_templates?: string[];

  /** Image jobs only. Defaults to PNG. */
  format?: "png" | "jpeg";
  /** Image jobs only, JPEG quality 0.1-1. */
  quality?: number;

  /** Video jobs only. */
  width?: number;
  height?: number;
  fps?: number;
}

/** One queued job, as an external caller sees it. */
export interface ApiRenderJob {
  id: string;
  kind: "image" | "video";
  status: string;
  product_id: string | null;
  product_name: string | null;
  /** The group / template / reference-set this job renders. */
  target: string;
  /** How many files it will produce when it succeeds. */
  expected_files: number;
  created_at: string;
  /** Poll this for progress and, once succeeded, the output URLs. */
  status_url: string;
}

/** POST /api/v1/renders — response (202). */
export interface ApiRenderQueued {
  jobs: ApiRenderJob[];
  /** Present when the jobs are queued but no GPU worker is configured. */
  warning?: string;
}

/** GET /api/v1/renders/[jobId] — one job's live state. */
export interface ApiRenderStatus {
  id: string;
  kind: "image" | "video";
  status: string;
  /** 0-100, across the job's own work. */
  percent: number;
  product_id: string | null;
  product_name: string | null;
  target: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  /** Empty until the job succeeds; emptied again once the files expire. */
  files: ApiRenderFile[];
  /** When the files are deleted, or null while the job is still running. */
  expires_at: string | null;
  /** True once the output was swept — render again rather than waiting. */
  expired: boolean;
}

export interface ApiRenderFile {
  name: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
}
