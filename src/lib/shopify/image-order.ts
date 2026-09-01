/**
 * Name-based gallery ordering for Shopify deploys.
 *
 * The image group's reference order is arbitrary (whatever order the refs were
 * added in), so a render used to hand the gallery Mockup-Web-3 → 5-Standard → 4.
 * This module sorts a rendered set by NAME into the fixed gallery order the
 * storefront expects, and drops the images that belong in metafields instead.
 *
 * Kept separate from product-builder.ts so the deploy dialog can apply the same
 * rule client-side (the badges must show what the server will actually do).
 *
 * Rules (see sortGalleryByName):
 *  1. Only Mockup-Web-* reaches the gallery. Details-* / Package-* are metafield
 *     images — routed by name on the server, never shown as gallery tiles.
 *  2. Sort by N ascending; within one N the base (no suffix) comes first, then
 *     the version images the product actually offers.
 *  3. Slots 2 and 5 take a SINGLE version image, Pro > Premium > Standard, so
 *     the same framing never appears twice in a row.
 *  4. Unrecognised names keep their relative order and go last (user uploads).
 */

/** Strip a file extension from an image name → its stem ("Mockup-Web-1.png" → "Mockup-Web-1"). */
export function imageStem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** Slots that show exactly one version image instead of one per version. */
const SINGLE_VERSION_SLOTS = new Set([2, 5]);

/** Version suffixes that exist as rendered mockups. Premium reuses Standard art. */
type MockupVersion = "Standard" | "Pro";

/** A parsed image name. `kind` decides gallery vs metafield vs passthrough. */
export interface ParsedImageName {
  kind: "mockup" | "metafield" | "other";
  /** Slot number N for Mockup-Web-N (undefined for other kinds). */
  slot?: number;
  /** Version suffix, normalised to Capitalised form. Undefined = base image. */
  version?: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Classify one image name without needing the whole set. */
export function parseImageName(name: string): ParsedImageName {
  const stem = imageStem(name);

  const mockup = stem.match(/^Mockup-Web-(\d+)(?:-(.+))?$/i);
  if (mockup) {
    return {
      kind: "mockup",
      slot: Number(mockup[1]),
      version: mockup[2] ? cap(mockup[2].trim()) : undefined,
    };
  }

  if (/^(?:Details|Package)-\d+(?:-.+)?$/i.test(stem)) {
    return { kind: "metafield" };
  }

  return { kind: "other" };
}

/** True when this image goes to a metafield rather than the product gallery. */
export function isMetafieldImageName(name: string): boolean {
  return parseImageName(name).kind === "metafield";
}

/**
 * Sort a rendered image set into final gallery order by name.
 *
 * `versions` is the product's Version option (Standard / Premium / Pro). It
 * decides which version mockups survive: a Standard-only product never shows a
 * Pro shaft, and Premium reuses the Standard render.
 *
 * Metafield images (Details-*, Package-*) are returned separately — they still
 * have to be uploaded so Shopify mints a Media GID, but they must not occupy a
 * gallery slot or a deploy-order badge.
 *
 * @param items    the rendered images, each carrying its reference name
 * @param nameOf   how to read the reference name off an item
 * @param versions the product's Version option values
 */
export function sortGalleryByName<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  versions: readonly string[],
): { gallery: T[]; metafield: T[] } {
  const hasPro = versions.includes("Pro");
  const hasPremium = versions.includes("Premium");
  const hasStandard = versions.includes("Standard");
  // Premium has no art of its own — it shows the Standard render.
  const wantsStandardArt = hasStandard || hasPremium;

  const metafield: T[] = [];
  const other: T[] = [];
  // slot → { base, Standard, Pro }; first occurrence of each wins.
  const slots = new Map<number, Partial<Record<"base" | MockupVersion, T>>>();

  for (const item of items) {
    const parsed = parseImageName(nameOf(item));

    if (parsed.kind === "metafield") {
      metafield.push(item);
      continue;
    }
    if (parsed.kind !== "mockup" || parsed.slot === undefined) {
      other.push(item);
      continue;
    }

    const entry = slots.get(parsed.slot) ?? {};
    if (!parsed.version) {
      if (!entry.base) entry.base = item;
    } else if (parsed.version === "Standard" || parsed.version === "Pro") {
      if (!entry[parsed.version]) entry[parsed.version] = item;
    } else {
      // A version suffix with no matching render (e.g. -Premium): treat the
      // image as unrecognised rather than silently dropping it.
      other.push(item);
    }
    slots.set(parsed.slot, entry);
  }

  const gallery: T[] = [];
  for (const slot of [...slots.keys()].sort((a, b) => a - b)) {
    const entry = slots.get(slot)!;
    if (entry.base) gallery.push(entry.base);

    if (SINGLE_VERSION_SLOTS.has(slot)) {
      // One version image only, by priority. The trailing fallbacks cover a
      // product whose Version option doesn't match the rendered suffixes.
      const selected =
        (hasPro && entry.Pro) ||
        (hasPremium && entry.Standard) ||
        (hasStandard && entry.Standard) ||
        entry.Pro ||
        entry.Standard;
      if (selected) gallery.push(selected);
      continue;
    }

    if (wantsStandardArt && entry.Standard) gallery.push(entry.Standard);
    if (hasPro && entry.Pro) gallery.push(entry.Pro);
  }

  // User uploads and anything off-convention keep their order, after the mockups.
  gallery.push(...other);

  return { gallery, metafield };
}
