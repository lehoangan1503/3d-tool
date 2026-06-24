/**
 * Product titles usually embed the SKU as `<code> - [theme]` or `<code>-[theme]`
 * (the dash before the theme may or may not have surrounding spaces). Split the
 * code out into the product-code field and push the trailing theme into the AI
 * hint. The accepted code shape is store-specific (nXX-YY for Prime-cues, WA1
 * for Wow cue) — pass the store's format key. If the name doesn't start with a
 * valid code, return nulls so the form is left untouched (treated as a normal/
 * free-form name).
 */

import {
  getProductCodeFormat,
  DEFAULT_PRODUCT_CODE_FORMAT,
  type ProductCodeFormatKey,
} from "./product-code";

export interface ParsedProductTitle {
  /** Normalised lowercase product code, e.g. "n06-02" / "wa1", or null. */
  code: string | null;
  /** Trailing theme text, e.g. "Fourth of July", or null if absent. */
  theme: string | null;
}

export function parseProductTitle(
  name: string,
  formatKey: ProductCodeFormatKey = DEFAULT_PRODUCT_CODE_FORMAT,
): ParsedProductTitle {
  if (!name) return { code: null, theme: null };

  const match = name.match(getProductCodeFormat(formatKey).titlePattern);
  if (!match) return { code: null, theme: null };

  const code = match[1].toLowerCase();
  const theme = match[2]?.trim() || null;
  return { code, theme };
}
