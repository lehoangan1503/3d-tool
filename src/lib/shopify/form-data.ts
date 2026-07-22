import type { ShaftConfig, ShopifyFormData, ShopifyVersionName, SurfaceSlotsConfig } from "@/types/product";

// The shared request body for both deploy (create-product) and save-draft.
// Save-draft tolerates partial/incomplete values; deploy validates them.
export interface ShopifyDeployRequest {
  productId: string;
  /** Which Shopify store to deploy to. Omitted → the default store. */
  storeId?: string;
  productCode: string;
  title: string;
  description: string;
  collections: string;
  /** The single collection shown in the storefront breadcrumb (one of `collections`). */
  breadcrumbCollection?: string | null;
  imageUrls: string[];
  imageNames?: string[];
  /** Legacy single video — still accepted from old clients/drafts. */
  videoUrl?: string | null;
  /** Ordered list of videos deployed as gallery media at positions 2,3,... */
  videoUrls?: string[];
  versions: Array<ShopifyVersionName>;
  wrapType: "wrap" | "wrapless" | "";
  laserShaft: boolean;
  customImage?: boolean;
  customText?: { label: string; example: string } | null;
  customTextPaid?: { label: string; example: string } | null;
  aiHint?: string;
  aiModel?: string;
  manualTags?: string[];
  skillIds?: string[];
  /** Current editor surface slot config. Deploy uses this so slot edits do not require a separate product save first. */
  surfaceSlots?: SurfaceSlotsConfig | null;
  /** Current editor surface image URL, paired with surfaceSlots for Shopify metafields. */
  surfaceImageUrl?: string | null;
  /** Per-product laser shaft preview images + text frame positions. */
  shaftConfig?: ShaftConfig | null;
}

// Build the full form snapshot persisted in shopify_deployments.form_data so a
// product can be re-opened, edited and re-deployed (or saved as a draft).
// Shared by the deploy route and the save-draft route to avoid drift.
export function buildFormData(body: ShopifyDeployRequest): ShopifyFormData {
  const {
    productCode,
    title,
    description,
    collections,
    breadcrumbCollection = null,
    imageUrls = [],
    imageNames = [],
    videoUrl = null,
    videoUrls,
    versions = [],
    wrapType,
    laserShaft,
    customImage = false,
    customText = null,
    customTextPaid = null,
    aiHint = "",
    aiModel = "",
    manualTags = [],
    skillIds = [],
    shaftConfig = null,
  } = body;

  const collectionList = (collections ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  // Only keep the breadcrumb pick if it's still one of the picked collections;
  // a value that was removed above falls back to null (not picked).
  const breadcrumbPick = breadcrumbCollection?.trim() || null;
  const breadcrumb = breadcrumbPick && collectionList.some((c) => c === breadcrumbPick)
    ? breadcrumbPick
    : null;

  // Normalize videos to an ordered list. Prefer the new videoUrls[]; fall back to
  // the legacy single videoUrl so old clients/drafts still round-trip.
  const resolvedVideoUrls = (videoUrls && videoUrls.length ? videoUrls : videoUrl ? [videoUrl] : []).filter(Boolean);

  return {
    productCode: (productCode ?? "").trim(),
    title: (title ?? "").trim(),
    description: description ?? "",
    aiHint,
    aiModel,
    versions,
    // Store the chosen wrap verbatim. A draft may not have one yet (""), which
    // is fine — the dialog reads it back as "unset" on reopen. Deploy validates
    // a real value ("wrap"|"wrapless") before going live, so live rows never
    // hold "". Cast is needed because the persisted snapshot can hold "".
    wrapType: wrapType as ShopifyFormData["wrapType"],
    laserShaft: Boolean(laserShaft),
    customImage: Boolean(customImage),
    customText: customText ?? null,
    customTextPaid: customTextPaid ?? null,
    collections: collectionList,
    breadcrumbCollection: breadcrumb,
    imageUrls,
    imageNames,
    // Keep the legacy field populated (first video) for older readers, plus the
    // full ordered list for multi-video deploys.
    videoUrl: resolvedVideoUrls[0] ?? null,
    videoUrls: resolvedVideoUrls,
    manualTags,
    skillIds,
    shaftConfig,
  };
}
