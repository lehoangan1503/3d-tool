/**
 * The single source of truth for variant pricing.
 *
 * Prices used to be hardcoded twice — a server table in product-builder.ts and
 * a preview table in shopify-deploy-dialog.tsx — which could silently diverge
 * and make the dialog lie about what would be created. Both now compute from
 * here, so the preview is the same arithmetic the deploy performs.
 *
 * A price table comes from the price template picked at deploy time. With no
 * template the built-in defaults below apply — the values that were hardcoded
 * before — so nothing changes by default.
 */

import type {
  DeployPricing,
  DeployTemplate,
  PriceModifiers,
  ResolvedPricing,
  VersionPrice,
} from "@/types/deploy-template";
import type { ShopifyVersionName } from "@/types/product";

/** Tier order used for variant ordering and for UI listings. */
export const VERSION_ORDER: readonly ShopifyVersionName[] = [
  "Standard",
  "Premium",
  "Pro",
  "Lux",
] as const;

/**
 * The historic hardcoded table. Standard is discounted 15%, the rest 20% —
 * these percentages only drive `compare_at_price`.
 */
export const DEFAULT_PRICING: ResolvedPricing = {
  versions: {
    Standard: { price: 154.5, discountPercent: 15 },
    Premium: { price: 229.5, discountPercent: 20 },
    Pro: { price: 299.5, discountPercent: 20 },
    Lux: { price: 399.5, discountPercent: 20 },
  },
  modifiers: {
    laserShaft: 20,
    customImage: 20,
    customTextPaid: 20,
  },
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A price must be a non-negative finite number to be worth overriding with. */
function pickPrice(value: unknown, fallback: number): number {
  return isFiniteNumber(value) && value >= 0 ? value : fallback;
}

/**
 * A discount percent must land in [0, 100). 100 would divide by zero in the
 * compare-at formula, so it is rejected in favour of the fallback.
 */
function pickPercent(value: unknown, fallback: number): number {
  return isFiniteNumber(value) && value >= 0 && value < 100 ? value : fallback;
}

/**
 * Fill a partial table from `base` (defaults to the built-ins), so callers
 * always get every version and every modifier. Unparseable or out-of-range
 * numbers fall back rather than shipping a bad price to Shopify.
 */
export function resolvePricing(
  pricing: DeployPricing | null | undefined,
  base: ResolvedPricing = DEFAULT_PRICING,
): ResolvedPricing {
  const versions = {} as Record<ShopifyVersionName, VersionPrice>;
  for (const version of VERSION_ORDER) {
    const fallback = base.versions[version];
    const raw = pricing?.versions?.[version];
    versions[version] = {
      price: pickPrice(raw?.price, fallback.price),
      discountPercent: pickPercent(raw?.discountPercent, fallback.discountPercent),
    };
  }

  const modifiers: PriceModifiers = {
    laserShaft: pickPrice(pricing?.modifiers?.laserShaft, base.modifiers.laserShaft),
    customImage: pickPrice(pricing?.modifiers?.customImage, base.modifiers.customImage),
    customTextPaid: pickPrice(pricing?.modifiers?.customTextPaid, base.modifiers.customTextPaid),
  };

  return { versions, modifiers };
}

/** The vendor for a template, or null to keep the builder default. */
export function resolveVendor(template: DeployTemplate | null | undefined): string | null {
  return template?.vendor?.trim() || null;
}

/** Round to the nearest .0 / .5 the way the price table is written. */
export function roundPriceNaturally(price: number): number {
  const whole = Math.floor(price);
  const decimal = price - whole;
  if (decimal < 0.25) return whole;
  if (decimal < 0.75) return whole + 0.5;
  return whole + 1;
}

export function calculateCompareAtPrice(finalPrice: number, discountPercent: number): number {
  return roundPriceNaturally(finalPrice / (1 - discountPercent / 100));
}

export interface PricedVariant {
  version: ShopifyVersionName;
  /** "No" | "Yes" when the Shaft Engraving axis is on, else null. */
  laserOption: "No" | "Yes" | null;
  price: number;
  compareAtPrice: number;
}

export interface PriceVariantsInput {
  versions: ShopifyVersionName[];
  laserShaft: boolean;
  customImage: boolean;
  customTextPaid: boolean;
  pricing: ResolvedPricing;
}

/**
 * The variant price list — used verbatim by the server builder and by the
 * dialog's "Biến thể sẽ được tạo" preview, so the two cannot disagree.
 *
 * Custom Image / paid Custom Text are flat surcharges on every variant; Shaft
 * Engraving is a variant axis where only the "Yes" side pays.
 */
export function priceVariants(input: PriceVariantsInput): PricedVariant[] {
  const { versions, laserShaft, customImage, customTextPaid, pricing } = input;
  const flatAdd =
    (customImage ? pricing.modifiers.customImage : 0) +
    (customTextPaid ? pricing.modifiers.customTextPaid : 0);

  const ordered = VERSION_ORDER.filter((v) => versions.includes(v));
  const laserOptions: Array<"No" | "Yes" | null> = laserShaft ? ["No", "Yes"] : [null];

  const out: PricedVariant[] = [];
  for (const version of ordered) {
    const tier = pricing.versions[version];
    for (const laserOption of laserOptions) {
      const price =
        tier.price + flatAdd + (laserOption === "Yes" ? pricing.modifiers.laserShaft : 0);
      out.push({
        version,
        laserOption,
        price,
        compareAtPrice: calculateCompareAtPrice(price, tier.discountPercent),
      });
    }
  }
  return out;
}
