import type { ShopifyFormData } from "@/types/product";

// The shared request body for both deploy (create-product) and save-draft.
// Save-draft tolerates partial/incomplete values; deploy validates them.
export interface ShopifyDeployRequest {
  productId: string;
  productCode: string;
  title: string;
  description: string;
  collections: string;
  imageUrls: string[];
  imageNames?: string[];
  videoUrl?: string | null;
  versions: Array<"Standard" | "Premium" | "Pro">;
  wrapType: "wrap" | "wrapless" | "";
  laserShaft: boolean;
  customImage?: boolean;
  customText?: { label: string; example: string } | null;
  customTextPaid?: { label: string; example: string } | null;
  aiHint?: string;
  aiModel?: string;
  manualTags?: string[];
  skillIds?: string[];
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
    imageUrls = [],
    imageNames = [],
    videoUrl = null,
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
  } = body;

  const collectionList = (collections ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

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
    imageUrls,
    imageNames,
    videoUrl: videoUrl ?? null,
    manualTags,
    skillIds,
  };
}
