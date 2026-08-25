/**
 * Price templates — a named price table picked at deploy time.
 *
 * "Global" holds the prices that used to be hardcoded; the user adds more
 * (Uni, Novera, ...) and edits their numbers. Picking one at deploy prices that
 * product, which is what lets a single store carry several brands at several
 * prices.
 */

import type { ShopifyVersionName } from "./product";

/** Absolute price for one version, plus the % used to derive compare_at_price. */
export interface VersionPrice {
  /** The variant's actual selling price, e.g. 229.5. */
  price: number;
  /**
   * Percentage used to derive compare_at_price (the struck-through price):
   * compare_at = price / (1 - pct/100). It does NOT reduce `price`.
   */
  discountPercent: number;
}

/** Surcharges for the three paid labels. */
export interface PriceModifiers {
  /** "Shaft Engraving" — a variant axis; only the "Yes" variant pays this. */
  laserShaft: number;
  /** "Custom Image" — flat surcharge on every variant. */
  customImage: number;
  /** Paid "Custom Text" — flat surcharge on every variant. */
  customTextPaid: number;
}

/**
 * A price table. Every field is optional so a partial table is valid: missing
 * versions and modifiers fall back to the built-in defaults (DEFAULT_PRICING in
 * lib/shopify/pricing.ts).
 */
export interface DeployPricing {
  versions?: Partial<Record<ShopifyVersionName, Partial<VersionPrice>>>;
  modifiers?: Partial<PriceModifiers>;
}

/** A fully resolved table — no optional fields, safe to price variants from. */
export interface ResolvedPricing {
  versions: Record<ShopifyVersionName, VersionPrice>;
  modifiers: PriceModifiers;
}

/** One named price table. */
export interface DeployTemplate {
  id: string;
  name: string;
  /** Shopify product vendor. null = keep the builder's default. */
  vendor: string | null;
  pricing: DeployPricing;
  createdAt?: string;
  updatedAt?: string;
}

/** Payload for creating/updating a template. */
export interface DeployTemplateInput {
  name: string;
  vendor?: string | null;
  pricing?: DeployPricing;
}
