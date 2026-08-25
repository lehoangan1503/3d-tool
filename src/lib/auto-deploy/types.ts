import type { ShopifyWrapType } from "@/types/product";
import type { ProductCodeFormatKey } from "@/lib/shopify/product-code";

export type AutoDeployVersion = "Standard" | "Premium" | "Pro" | "Lux";

/** Custom-text label mode: off, free (no extra cost), or paid (+$20). */
export type CustomTextMode = "none" | "free" | "paid";

/**
 * One shared config applied to every product in an auto-deploy run. Combines the render
 * group selection with the Shopify deploy parameters (skill/version/wrap/labels/
 * collection) gathered up front, plus an optional video template.
 */
export interface AutoDeployConfig {
  /** Extractor reference groups to render per product (at least one). */
  groupIds: string[];
  /** Selected AI skill (prompt template) ids. */
  skillIds: string[];
  versions: AutoDeployVersion[];
  wrapType: ShopifyWrapType | "";
  // ── Labels ──
  /** "Shaft Engraving (+$20)". */
  laserShaft: boolean;
  /** "Custom Image (+$20)". */
  customImage: boolean;
  /** Custom Text mode — free or paid (+$20), mutually exclusive. */
  customTextMode: CustomTextMode;
  customTextLabel: string;
  customTextExample: string;
  /** Comma-separated collection list (matches ShopifyDeployRequest.collections). */
  collections: string;
  breadcrumbCollection: string | null;
  aiModel: string;
  manualTags: string[];
  /** When set, render + upload a video per product and attach its URL. */
  videoTemplateId: string | null;
  /** Target Shopify store id (from the store switcher); null → default store. */
  storeId?: string | null;
  /**
   * Price template used for this run. null → the built-in default prices, so a
   * batch cannot silently publish at another brand's prices.
   */
  deployTemplateId?: string | null;
  /** Product-code format of the target store (injected at run time, not persisted). */
  codeFormat?: ProductCodeFormatKey;
}

export function emptyRunConfig(): AutoDeployConfig {
  return {
    groupIds: [],
    skillIds: [],
    versions: ["Standard", "Premium"],
    wrapType: "",
    laserShaft: true,
    customImage: false,
    customTextMode: "none",
    customTextLabel: "",
    customTextExample: "",
    collections: "",
    breadcrumbCollection: null,
    aiModel: "gpt-5.4-mini",
    manualTags: [],
    videoTemplateId: null,
    deployTemplateId: null,
  };
}

/**
 * A run config is ready to deploy when a group, a version, and a wrap type are
 * chosen — and, if a custom-text mode is on, both its label and example are filled
 * (mirrors the deploy dialog's validation).
 */
export function isRunConfigValid(config: AutoDeployConfig): boolean {
  if (config.groupIds.length === 0 || config.versions.length === 0 || config.wrapType === "") return false;
  if (config.customTextMode !== "none" && (!config.customTextLabel.trim() || !config.customTextExample.trim())) {
    return false;
  }
  return true;
}
