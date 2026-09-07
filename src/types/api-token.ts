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
  product_type: ProductType;
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
  product_type: ProductType;
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
  productType: ProductType;
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
