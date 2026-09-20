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
  /**
   * True when the owner is a tool admin or superadmin, and so may render
   * products belonging to other users — the same reach they have in the
   * dashboard (canEditAnyProduct). Resolved at authentication time.
   *
   * What it does NOT change: the job still belongs to the token's owner, and
   * the rendered files land in their account.
   */
  canActOnAnyProduct: boolean;
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

// ── Shopify media audit / repair ──────────────────────────────────────────────

/**
 * POST /api/v1/shopify/media-audit — body.
 *
 * Every field is optional, and that shapes the two ways it gets called: with a
 * `product` it answers "what is this one missing?", with nothing at all it
 * sweeps the store. An agent handed a screenshot and "sản phẩm này thiếu ảnh"
 * sends the first; an agent asked to review the catalogue sends the second.
 */
export interface ApiMediaAuditRequest {
  /**
   * One product. Omit to sweep the store.
   *
   * Accepts any identifier a person can actually copy: the internal name
   * (`n05-26-Skull`), the product id, the Shopify TITLE as shown on the
   * storefront, the handle, the numeric `shopify_product_id`, or a pasted
   * product URL. Matching ignores case and accents. A value that matches more
   * than one product is refused with the candidates listed — never guessed.
   */
  product?: string;
  /** Extra products audited alongside `product`. */
  products?: string[];
  /** Store id (`main`, `store2`…). Defaults to the default store. */
  store?: string;
  /** Restrict a sweep to one mockup group, by id. */
  image_group?: string;
  /** Sweep size. Defaults to 50, capped at 1000. */
  limit?: number;
  /**
   * `false` returns every audited product, including the complete ones.
   * Default (`true`) returns only products with findings — the shape an agent
   * wants, since a clean product needs no action.
   */
  only_issues?: boolean;
}

/** One missing (or broken) media slot. */
export interface ApiMissingMedia {
  /** `custom.package_box`, or `Mockup-Web-4` for a gallery slot. */
  key: string;
  kind: "metafield" | "gallery";
  /** `absent` = nothing set. `broken` = set, but the file it points at is gone. */
  reason: "absent" | "broken";
  /** The render reference that produces this slot — feed straight to POST /api/v1/renders. */
  reference_name: string | null;
  /**
   * How the expectation was established. See media-audit.ts.
   *
   * `version-rule` is the one to act on without asking: it means the storefront
   * cannot render this slot for the versions the product sells today — e.g. a
   * Premium cue carrying only `package_product_pro`, where the before/after
   * block emits `src=""` and the showcase half comes out blank.
   */
  source: "version-rule" | "deploy" | "group" | "cohort";
  /** 1 for version-rule/deploy/group; the peer ratio for cohort findings. */
  confidence: number;
}

export interface ApiMediaAuditResult {
  product_id: string;
  product_name: string | null;
  shopify_product_id: number;
  title: string | null;
  admin_url: string | null;
  store: string;
  image_group_id: string | null;
  image_group_name: string | null;
  versions: string[];
  /** How many media slots this product was expected to have. */
  expected_count: number;
  missing: ApiMissingMedia[];
}

export interface ApiMediaAuditResponse {
  store: string;
  audited: number;
  products_with_issues: number;
  results: ApiMediaAuditResult[];
  note?: string;
  usage?: {
    next_steps: string[];
    note: string;
  };
}

/** One image to write back onto a live product. */
export interface ApiMediaRepairItem {
  /** Target metafield, e.g. `custom.package_box`. */
  key: string;
  /** Public http(s) URL Shopify can fetch — typically a render output. */
  url: string;
}

export interface ApiMediaRepairRequest {
  /**
   * Product name, id, Shopify title, handle, shopify_product_id, or a pasted
   * product URL — same matching as media-audit. Ambiguous input is refused.
   */
  product?: string;
  store?: string;
  media?: ApiMediaRepairItem[];
  /**
   * Replace a slot that already has a working image. Off by default: repair
   * fills gaps, and a live product's good image is not ours to overwrite
   * without being told.
   */
  overwrite?: boolean;
}

export interface ApiMediaRepairResult {
  key: string;
  /**
   * `filled`   — the slot was empty and now has the image.
   * `replaced` — the slot pointed at a dead file, or overwrite was requested.
   * `skipped`  — already had a working image; nothing written.
   * `failed`   — see `detail`.
   */
  status: "filled" | "replaced" | "skipped" | "failed";
  detail?: string | null;
  file_gid?: string;
  reference_name?: string | null;
}

export interface ApiMediaRepairResponse {
  product_id: string;
  shopify_product_id: number;
  store: string;
  admin_url: string | null;
  filled: number;
  replaced: number;
  skipped: number;
  failed: number;
  results: ApiMediaRepairResult[];
  note: string;
}

/** GET /api/v1/shopify/products — one deployed product in the listing. */
export interface ApiDeployedProduct {
  product_id: string;
  product_name: string | null;
  shopify_product_id: number;
  title: string | null;
  /** Shopify handle — the last path segment of the storefront URL. */
  handle: string | null;
  store: string;
  admin_url: string | null;
  storefront_url: string | null;
  image_group_id: string | null;
  image_group_name: string | null;
  deployed_at: string | null;
}

export interface ApiDeployedProductsResponse {
  store: string;
  count: number;
  products: ApiDeployedProduct[];
  usage: {
    note: string;
  };
}
