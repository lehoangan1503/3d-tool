import type { Product } from "@/types/product";
import { parseProductTitle } from "@/lib/shopify/parse-title";
import { DEFAULT_PRODUCT_CODE_FORMAT, type ProductCodeFormatKey } from "@/lib/shopify/product-code";

/** Tab key used for products whose name has no valid product code. */
export const NO_CODE_GROUP = "__nocode__";

export interface ProductGroup {
  /** Group key: the code prefix (e.g. "n06" / "wa"), or NO_CODE_GROUP. */
  prefix: string;
  /** Human label for the tab. */
  label: string;
  products: Product[];
}

/** Full product code (e.g. "n06-02" / "wa1") parsed from the name, or null. */
export function productCode(product: Product, formatKey: ProductCodeFormatKey = DEFAULT_PRODUCT_CODE_FORMAT): string | null {
  return parseProductTitle(product.name, formatKey).code;
}

/**
 * The grouping prefix derived from the product code, or null. For nXX-YY this
 * is the nXX part (e.g. "n06"); for the Wow cue W{initial}{number} codes it is
 * the leading letters (e.g. "wa" from "wa12").
 */
export function productPrefix(product: Product, formatKey: ProductCodeFormatKey = DEFAULT_PRODUCT_CODE_FORMAT): string | null {
  const code = productCode(product, formatKey);
  if (!code) return null;
  const letters = code.match(/^[a-z]+/i)?.[0] ?? code;
  // nXX-YY → "n06" (letter + first digit group); W-codes → just the letters.
  const digits = code.slice(letters.length).match(/^\d+/)?.[0] ?? "";
  return formatKey === "primecues" ? `${letters}${digits}` : letters;
}

/** A product can deploy to Shopify only when it has a valid code for the store. */
export function canDeployProduct(product: Product, formatKey: ProductCodeFormatKey = DEFAULT_PRODUCT_CODE_FORMAT): boolean {
  return productCode(product, formatKey) !== null;
}

/**
 * Group products into code-prefix tabs. Coded products are bucketed by their
 * prefix (sorted ascending); uncoded products fall into a single NO_CODE_GROUP
 * tab that is always sorted last.
 */
export function groupProductsByPrefix(products: Product[], formatKey: ProductCodeFormatKey = DEFAULT_PRODUCT_CODE_FORMAT): ProductGroup[] {
  const buckets = new Map<string, Product[]>();

  for (const product of products) {
    const prefix = productPrefix(product, formatKey) ?? NO_CODE_GROUP;
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
