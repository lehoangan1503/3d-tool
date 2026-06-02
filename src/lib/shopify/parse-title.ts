/**
 * Product titles usually embed the SKU as `nXX-XX - [theme]` or `nXX-XX-[theme]`
 * (the dash before the theme may or may not have surrounding spaces). Split the
 * SKU out into the product-code field and push the trailing theme into the AI
 * hint. If the name doesn't start with a valid code, return nulls so the form
 * is left untouched (treated as a normal/free-form name).
 */

export interface ParsedProductTitle {
  /** Normalised lowercase product code, e.g. "n06-02", or null if not present. */
  code: string | null;
  /** Trailing theme text, e.g. "Fourth of July", or null if absent. */
  theme: string | null;
}

// nXX-XX at the start, then an OPTIONAL separator (spaces and/or a single dash),
// then the rest as the theme.
const TITLE_PATTERN = /^\s*(n\d{2}-\d{2})\s*(?:-\s*)?(.*)$/i;

export function parseProductTitle(name: string): ParsedProductTitle {
  if (!name) return { code: null, theme: null };

  const match = name.match(TITLE_PATTERN);
  if (!match) return { code: null, theme: null };

  const code = match[1].toLowerCase();
  const theme = match[2]?.trim() || null;
  return { code, theme };
}
