import type { Product } from "@/types/product";
import { parseProductTitle } from "@/lib/shopify/parse-title";

/** Tab key used for products whose name has no valid nXX-YY code. */
export const NO_CODE_GROUP = "__nocode__";

export interface ProductGroup {
  /** Group key: the nXX prefix (e.g. "n06"), or NO_CODE_GROUP for uncoded products. */
  prefix: string;
  /** Human label for the tab. */
  label: string;
  products: Product[];
}

/** Full product code (e.g. "n06-02") parsed from the name, or null when absent. */
export function productCode(product: Product): string | null {
  return parseProductTitle(product.name).code;
}

/** The nXX grouping prefix (e.g. "n06") derived from the product code, or null. */
export function productPrefix(product: Product): string | null {
  const code = productCode(product);
  return code ? code.slice(0, 3) : null;
}

/** A product can deploy to Shopify only when it has a valid nXX-YY code. */
export function canDeployProduct(product: Product): boolean {
  return productCode(product) !== null;
}

/**
 * Group products into nXX tabs. Coded products are bucketed by their nXX prefix
 * (sorted ascending); uncoded products fall into a single NO_CODE_GROUP tab that
 * is always sorted last.
 */
export function groupProductsByPrefix(products: Product[]): ProductGroup[] {
  const buckets = new Map<string, Product[]>();

  for (const product of products) {
    const prefix = productPrefix(product) ?? NO_CODE_GROUP;
    const list = buckets.get(prefix);
    if (list) list.push(product);
    else buckets.set(prefix, [product]);
  }

  const coded = [...buckets.keys()]
    .filter((k) => k !== NO_CODE_GROUP)
    .sort((a, b) => a.localeCompare(b));

  const groups: ProductGroup[] = coded.map((prefix) => ({
    prefix,
    label: prefix.toUpperCase(),
    products: buckets.get(prefix)!,
  }));

  if (buckets.has(NO_CODE_GROUP)) {
    groups.push({
      prefix: NO_CODE_GROUP,
      label: "Chưa có mã",
      products: buckets.get(NO_CODE_GROUP)!,
    });
  }

  return groups;
}
