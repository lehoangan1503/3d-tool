/**
 * Turns an uploaded filename into a product name.
 *
 * The caller does not have to send a name: whatever it called the file becomes
 * the product, prefixed by the token's own prefix. That is the whole naming
 * contract, and it is deliberately the *filename* rather than a required field
 * — a caller generating templates already names its output, and one fewer
 * required field is one fewer thing an AI can omit.
 */

/** products.name is VARCHAR(255); leave room for a prefix and a suffix. */
const MAX_NAME_LENGTH = 200;

/**
 * Strips the directory and extension from an upload's filename.
 *
 * Browsers normally send a bare filename, but a `curl -F file=@a/b/c.jpg` can
 * carry separators, and some clients send a Windows path. Splitting on both
 * separators means a path never becomes part of the name.
 */
function baseName(fileName: string): string {
  const withoutDirs = fileName.split(/[/\\]/).pop() ?? fileName;
  // Only a trailing extension, and only when something precedes the dot, so a
  // dotfile like ".surface" is not stripped to nothing. (slugify then drops
  // the leading dot, giving "surface" — which is the point: a name, not empty.)
  return withoutDirs.replace(/^(.+)\.[^.]+$/, "$1");
}

/**
 * Reduces a name to characters that are safe everywhere it will be shown.
 *
 * A product name travels into Shopify titles, storage paths and filenames, so
 * anything that needs escaping in one of those is more trouble than it is
 * worth. Unicode letters are kept (`\p{L}` covers Vietnamese), which is why
 * this is not a bare `[a-z0-9]` filter.
 */
function slugify(raw: string): string {
  return raw
    .normalize("NFC")
    .toLowerCase()
    // Anything that is not a letter, digit or separator becomes a hyphen.
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    // Collapse runs and trim the hyphens that produced.
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ResolveProductNameInput {
  /** The token's prefix, e.g. "n02". Null or empty means no prefix. */
  namePrefix: string | null;
  /** Uploaded file's name, used when the caller sends no explicit name. */
  fileName: string;
  /** Explicit name from the request, which overrides the filename. */
  requestedName?: string | null;
}

/**
 * Resolves the final product name.
 *
 * Precedence is explicit name, then filename, then a timestamp — the last so
 * that a file named only with punctuation ("___.jpg") still produces something
 * findable instead of a bare prefix or an empty name the database would reject.
 */
export function resolveProductName(input: ResolveProductNameInput): string {
  const requested = input.requestedName?.trim();
  const source = requested && requested.length > 0 ? requested : baseName(input.fileName);

  let body = slugify(source);
  if (body.length === 0) {
    // Second-resolution local time, which is enough: two API calls for the
    // same unnamed file in the same second is not a case worth a counter.
    body = `untitled-${Date.now()}`;
  }
  if (body.length > MAX_NAME_LENGTH) body = body.slice(0, MAX_NAME_LENGTH);

  const prefix = slugify(input.namePrefix ?? "");
  // Already prefixed — re-sending a name the API returned must not produce
  // "n02-n02-dragon". Checked on the slug so "N02_dragon" is caught too.
  if (prefix.length === 0 || body === prefix || body.startsWith(`${prefix}-`)) {
    return body;
  }

  return `${prefix}-${body}`;
}
