/**
 * Product-code formats, keyed per store.
 *
 * Different stores enforce different product-code shapes:
 *  - Prime-cues (default): `nXX-YY`  (e.g. n01-05) — employee/team code + variant.
 *  - Wow cue:              `W{D}{N}` (e.g. WA1, WA99, WA199) — `W` + designer
 *                          initial + product number.
 *
 * The code is used downstream as the variant SKU base and an auto-created tag,
 * so each store just needs a pattern to validate against + a title parser. The
 * format is referenced by a string key so it can cross the client/server API
 * boundary (a RegExp can't be JSON-serialised); both sides resolve the same key
 * to the same definition here.
 */

export type ProductCodeFormatKey = "primecues" | "wowcue";

export interface ProductCodeFormat {
  key: ProductCodeFormatKey;
  /** Human label shown in UI error messages, e.g. "nXX-YY (vd: n01-05)". */
  label: string;
  /** Anchored pattern the full code must match (case-insensitive). */
  pattern: RegExp;
  /**
   * Pattern used to pull a leading code out of a product title, capturing
   * (1) the code and (2) the trailing theme text. The code may be followed by
   * an optional " - " separator before the theme.
   */
  titlePattern: RegExp;
}

const FORMATS: Record<ProductCodeFormatKey, ProductCodeFormat> = {
  // nXX-YY at the start, then an OPTIONAL separator (spaces and/or a single
  // dash), then the rest as the theme.
  primecues: {
    key: "primecues",
    label: "nXX-YY (vd: n01-05)",
    pattern: /^n\d{2}-\d{2}$/i,
    titlePattern: /^\s*(n\d{2}-\d{2})\s*(?:-\s*)?(.*)$/i,
  },
  // W + a single designer-initial letter + a product number (1+ digits):
  // WA1, WA99, WA199.
  wowcue: {
    key: "wowcue",
    label: "W{tên}{số} (vd: WA1, WA99)",
    pattern: /^w[a-z]\d+$/i,
    titlePattern: /^\s*(w[a-z]\d+)\s*(?:-\s*)?(.*)$/i,
  },
};

export const DEFAULT_PRODUCT_CODE_FORMAT: ProductCodeFormatKey = "primecues";

export function getProductCodeFormat(key: ProductCodeFormatKey | undefined | null): ProductCodeFormat {
  return FORMATS[key ?? DEFAULT_PRODUCT_CODE_FORMAT] ?? FORMATS[DEFAULT_PRODUCT_CODE_FORMAT];
}

/** True if `code` (trimmed) is a valid product code for the given format. */
export function isValidProductCode(code: string | undefined | null, key: ProductCodeFormatKey | undefined | null): boolean {
  return Boolean(code?.trim() && getProductCodeFormat(key).pattern.test(code.trim()));
}
