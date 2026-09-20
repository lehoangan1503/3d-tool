/**
 * Which media a deployed product SHOULD have, and which it actually has.
 *
 * The problem this exists for: a product goes live missing an image nobody
 * notices — a Package view deleted during an edit, a Details metafield that
 * never got written because a fileCreate failed and post-create only
 * `console.warn`ed. Nothing in the deploy path has ever checked, because until
 * now nothing knew what "complete" meant.
 *
 * There is no fixed answer to that, and inventing one would be wrong: Novera,
 * WowCue and Uni all ship different media sets, and a hardcoded list would be
 * stale the first time someone adds a template. So the expectation is INFERRED
 * — from what the product's own render group produces, and from what its peers
 * on the same group actually carry.
 *
 * Two independent sources, because each catches what the other misses:
 *
 *   1. GROUP (authoritative when present). `shopify_deployments.image_group_id`
 *      records the mockup group a deploy rendered from, and a group is an
 *      ordered list of named references — `Details-3`, `Package-2`. Run those
 *      names through the SAME classifier the deploy used and you have the exact
 *      set of gallery slots and metafield keys that deploy was supposed to
 *      produce. This is a direct comparison, not a guess.
 *
 *   2. PEERS (the fallback, and the part that scales to "rà 200 sản phẩm").
 *      Products deployed from the same group form a cohort. When 9 of 10 carry
 *      `custom.package_box` and one does not, the odd one out is missing it —
 *      no declaration needed, the cohort IS the declaration. A threshold keeps
 *      a genuinely optional image from being reported: a key has to be near
 *      universal in its cohort before its absence counts.
 *
 * Peer inference is deliberately conservative. A false "missing" sends an agent
 * off to render and upload an image the product was never meant to have, which
 * is worse than staying quiet — so a small cohort is not used for inference at
 * all, and the confidence is reported so the caller can decide.
 */

import { classifyImages, type NamedImage } from "./product-builder";
import type { ProductMetafieldRecord } from "./client";

/**
 * How many peers a cohort needs before "everyone else has it" means anything.
 *
 * Below this, one unusual product would set the standard for the rest. Three is
 * the smallest number where a majority is not just a single opinion.
 */
export const MIN_COHORT_FOR_INFERENCE = 3;

/**
 * Share of a cohort that must carry a key before its absence is a finding.
 *
 * Not 1.0: with 20 peers a single earlier casualty of this very bug would
 * otherwise mask the key for everyone. Not lower than this either — at 0.5 a
 * genuinely version-specific image (only Pro cues have it) reads as missing on
 * every Standard cue.
 */
export const COHORT_PRESENCE_THRESHOLD = 0.8;

/**
 * Where an expectation came from — reported so a caller can weigh it.
 *
 * `deploy` is the strongest: `form_data.imageNames` is the literal list of
 * image names that deploy sent, so a key expected from it was definitely meant
 * to be there. `group` re-derives the same thing from the group as it stands
 * today, which is right until someone edits the group. `cohort` is inference.
 */
export type ExpectationSource = "deploy" | "group" | "cohort" | "version-rule";

/** A media slot a product is expected to have. */
export interface ExpectedMedia {
  /** `custom.details_3` for a metafield, `Mockup-Web-4` for a gallery image. */
  key: string;
  kind: "metafield" | "gallery";
  /**
   * The reference name that renders this slot (`Details-3`), when known.
   * This is what POST /api/v1/renders takes, so it is the whole point of the
   * report: an agent reads it and can render the fix without a lookup.
   */
  referenceName: string | null;
  source: ExpectationSource;
  /** For a cohort expectation: the fraction of peers that carry it. */
  confidence: number;
}

/** A media slot that is expected but absent (or present-but-broken). */
export interface MissingMedia extends ExpectedMedia {
  /**
   * `absent` — no metafield row / no gallery image at all.
   * `broken` — the metafield exists but its file reference resolves to nothing,
   *            which looks identical to the shopper and is invisible in admin.
   */
  reason: "absent" | "broken";
}

/**
 * Turn a group's reference names into the media a deploy from it should yield.
 *
 * Runs the real classifier rather than re-deriving the naming rules, so this
 * cannot drift from what a deploy actually does — the rules live in exactly one
 * place (product-builder.ts) and both callers read them from there.
 *
 * `versions` matters: `Details-4-Pro` only becomes `custom.details_4_pro` when
 * the product actually has a Pro variant, and `Mockup-Web-2`'s versioned
 * sibling collapses to a single gallery slot by the Pro > Premium > Standard
 * rule. Passing the product's own versions is what keeps the expectation
 * matched to the product rather than to the group in the abstract.
 */
export function expectedMediaFromReferenceNames(
  referenceNames: string[],
  versions: string[],
  source: Extract<ExpectationSource, "deploy" | "group"> = "group"
): ExpectedMedia[] {
  // The classifier takes NamedImage; only `name` is read for classification,
  // so a placeholder url keeps us from inventing data we do not have.
  const named: NamedImage[] = referenceNames.map((name) => ({ name, url: "" }));
  const { galleryImages, metafieldImages } = classifyImages(named, versions);

  const expected: ExpectedMedia[] = [];

  for (const image of galleryImages) {
    if (!appliesToVersions(stripExtension(image.name), versions)) continue;
    expected.push({
      key: stripExtension(image.name),
      kind: "gallery",
      referenceName: stripExtension(image.name),
      source,
      confidence: 1,
    });
  }

  // classifyImages rewrites `name` to the metafield KEY (details_3), so the
  // original reference name is no longer on the object — it is recovered by
  // matching the key back to the input list, which is what an agent needs to
  // re-render the slot.
  for (const image of metafieldImages) {
    if (!metafieldAppliesToVersions(image.name, versions)) continue;
    expected.push({
      key: `custom.${image.name}`,
      kind: "metafield",
      referenceName: findReferenceNameForKey(referenceNames, image.name, versions),
      source,
      confidence: 1,
    });
  }

  return expected;
}

/**
 * Whether a versioned slot applies to a product that ships these versions.
 *
 * `classifyImages` filters `Details-*` by version but deliberately does not do
 * the same for `Package-1-*` or the `Mockup-Web-*-Pro` gallery siblings — on the
 * deploy path that is harmless, because an image only reaches the classifier if
 * it was actually rendered, so an absent Pro image simply never appears.
 *
 * An audit inverts that. It feeds the classifier the group's FULL reference
 * list, including slots that were never meant for this product, so without this
 * filter a Standard-only cue is reported as missing `custom.package_product_pro`
 * — a false finding that would send an agent off to render a Pro package shot
 * for a cue that has no Pro variant. Filtering here rather than in
 * product-builder keeps the deploy path's behaviour untouched.
 *
 * An unversioned name (`Package-2`, `Mockup-Web-3`) applies to every product.
 */
function appliesToVersions(stem: string, versions: string[]): boolean {
  const match = stem.match(/-(Standard|Premium|Pro)$/i);
  if (!match) return true;
  const version = capitalize(match[1]);

  // Premium cues are shot with the Standard assets — the same rule the gallery
  // selection in classifyImages follows (Pro > Premium → Standard > Standard).
  if (version === "Standard") {
    return versions.includes("Standard") || versions.includes("Premium");
  }
  return versions.includes(version);
}

/** The same rule, applied to a metafield KEY (`package_product_pro`). */
function metafieldAppliesToVersions(metafieldKey: string, versions: string[]): boolean {
  const match = metafieldKey.match(/_(standard|premium|pro)$/i);
  if (!match) return true;
  const version = capitalize(match[1]);
  if (version === "Standard") {
    return versions.includes("Standard") || versions.includes("Premium");
  }
  return versions.includes(version);
}

/**
 * Recover which reference name produced a metafield key.
 *
 * Done by re-running the classifier on one name at a time: the mapping is
 * many-to-one and version-dependent, so inverting it by hand would be a second
 * copy of the rules — the exact duplication this module avoids everywhere else.
 */
function findReferenceNameForKey(
  referenceNames: string[],
  metafieldKey: string,
  versions: string[]
): string | null {
  for (const name of referenceNames) {
    const { metafieldImages } = classifyImages([{ name, url: "" }], versions);
    if (metafieldImages.some((image) => image.name === metafieldKey)) {
      return stripExtension(name);
    }
  }
  return null;
}

/** Same rule as product-builder's imageStem: only a real image extension. */
function stripExtension(name: string): string {
  return name.replace(/\.(png|jpe?g|webp|gif|avif|tiff?|bmp)$/i, "");
}

/** What one deployed product carries on Shopify, as the audit reads it. */
export interface ProductMediaState {
  /** Metafields as returned by getProductMetafields (file refs resolved). */
  metafields: ProductMetafieldRecord[];
  /** Gallery image alt texts / names, used to spot missing Mockup-Web slots. */
  galleryImageAlts: string[];
}

/**
 * Compare one product against its expectations.
 *
 * Gallery slots are checked only when the alt text carries the reference name.
 * Shopify's REST image has no "name", and the deploy path sets alt from the
 * product title rather than the slot, so for most products gallery names are
 * simply unknowable — reporting them as missing would be a lie. Metafields,
 * which are keyed, are always checkable. That asymmetry is honest rather than
 * convenient: a wrong "missing" is the expensive error here.
 */
export function findMissingMedia(
  expected: ExpectedMedia[],
  state: ProductMediaState
): MissingMedia[] {
  const byKey = new Map(state.metafields.map((record) => [record.qualifiedKey, record]));
  const altSet = new Set(state.galleryImageAlts.map((alt) => stripExtension(alt).toLowerCase()));
  const galleryNamesKnown = expected.some(
    (item) => item.kind === "gallery" && altSet.has(item.key.toLowerCase())
  );

  const missing: MissingMedia[] = [];

  for (const item of expected) {
    if (item.kind === "metafield") {
      const record = byKey.get(item.key);
      if (!record || !record.value) {
        missing.push({ ...item, reason: "absent" });
        continue;
      }
      // A file_reference whose target no longer resolves — set, but dead.
      if (record.type === "file_reference" && !record.url) {
        missing.push({ ...item, reason: "broken" });
      }
      continue;
    }

    // Gallery: only meaningful when this product's alts actually carry slot
    // names (see the note above).
    if (galleryNamesKnown && !altSet.has(item.key.toLowerCase())) {
      missing.push({ ...item, reason: "absent" });
    }
  }

  return missing;
}

/**
 * Media the STOREFRONT requires for the versions a product actually sells.
 *
 * The other three sources ask "what was this product supposed to get?". This
 * one asks a different and harder question: "given the variants it sells today,
 * what must exist for the theme to render?" — and it is the only source that
 * catches a product whose version changed after it was deployed.
 *
 * That case is real and was invisible to every other source. `n05-26-Skull`
 * went live as a Pro cue (so the deploy wrote `package_product_pro`), was later
 * edited down to Premium, and re-deployed. A metafield is never deleted by a
 * re-deploy — only overwritten when the new deploy has an image for that key —
 * so the Pro package image stayed and the Standard one was never written. The
 * theme's before/after block renders
 * `<img src="{{ custom.package_product_standard }}">` for a Standard/Premium
 * cue and only swaps in the Pro image via JS when the shopper picks Pro, so the
 * showcase half came out as `src=""`: blank on the storefront, and perfectly
 * healthy-looking in admin, where an image metafield IS present.
 *
 * Deliberately narrow — only `package_product_*`, the pair whose selection is
 * driven by the variant. `details_N_*` is not included: the theme reads those
 * per-version too, but a product legitimately ships with only some of them, so
 * requiring the full set would produce exactly the false findings this module
 * spends its effort avoiding.
 *
 * Runs only when the product already carries the OTHER half of the before/after
 * pair (`package_box` or a sibling `package_product_*`). A product with no
 * package images at all never opted into that block, and demanding one would
 * flag every cue that simply does not use it — 15 of the 22 in this very group.
 */
export function versionRuleExpectations(
  versions: string[],
  presentKeys: Set<string>
): ExpectedMedia[] {
  const usesPackageBlock =
    presentKeys.has("custom.package_box") ||
    presentKeys.has("custom.package_product_standard") ||
    presentKeys.has("custom.package_product_pro");
  if (!usesPackageBlock) return [];

  // Premium is served by the Standard artwork — the same rule the gallery
  // selection and the theme both follow.
  const needsStandard = versions.includes("Standard") || versions.includes("Premium");
  const needsPro = versions.includes("Pro");

  const expected: ExpectedMedia[] = [];
  if (needsStandard) {
    expected.push({
      key: "custom.package_product_standard",
      kind: "metafield",
      referenceName: "Package-1-Standard",
      source: "version-rule",
      confidence: 1,
    });
  }
  if (needsPro) {
    expected.push({
      key: "custom.package_product_pro",
      kind: "metafield",
      referenceName: "Package-1-Pro",
      source: "version-rule",
      confidence: 1,
    });
  }
  return expected;
}

/** One product's metafield keys, for building a cohort standard. */
export interface CohortMember {
  productId: string;
  presentKeys: Set<string>;
}

/**
 * Infer a cohort's standard: the metafield keys nearly all its members carry.
 *
 * This is the half that answers "rà 200 sản phẩm và thấy 9 sản phẩm thiếu" —
 * no group needs to still exist, and no one needs to have declared anything.
 * Returns an empty list for a cohort too small to speak for itself, so a caller
 * cannot accidentally treat one product's quirks as a rule.
 */
export function inferCohortStandard(members: CohortMember[]): ExpectedMedia[] {
  if (members.length < MIN_COHORT_FOR_INFERENCE) return [];

  const counts = new Map<string, number>();
  for (const member of members) {
    for (const key of member.presentKeys) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const standard: ExpectedMedia[] = [];
  for (const [key, count] of counts) {
    const ratio = count / members.length;
    if (ratio < COHORT_PRESENCE_THRESHOLD) continue;
    standard.push({
      key,
      kind: "metafield",
      referenceName: referenceNameForMetafieldKey(key),
      source: "cohort",
      confidence: Number(ratio.toFixed(3)),
    });
  }

  return standard.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Best-effort reverse map from a metafield key to the reference name that
 * renders it — `custom.details_3` → `Details-3`.
 *
 * Only used on the cohort path, where there is no group to ask. Version
 * suffixes are restored in the capitalisation the classifier expects, so the
 * name it returns is one a render call will actually accept. Unknown keys
 * return null rather than a guess: a made-up reference name would send a render
 * job at a layout that does not exist.
 */
export function referenceNameForMetafieldKey(qualifiedKey: string): string | null {
  const key = qualifiedKey.startsWith("custom.") ? qualifiedKey.slice("custom.".length) : qualifiedKey;

  const details = key.match(/^details_(\d+)(?:_(standard|premium|pro))?$/);
  if (details) {
    const suffix = details[2] ? `-${capitalize(details[2])}` : "";
    return `Details-${details[1]}${suffix}`;
  }

  if (key === "package_product_standard") return "Package-1-Standard";
  if (key === "package_product_pro") return "Package-1-Pro";
  if (key === "package_box") return "Package-2";

  return null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * The media metafield keys, as a predicate.
 *
 * A cohort standard must not include `custom.cue_3d_config` or
 * `custom.shaft_config`: those are config, not media, and an agent told they
 * are "missing media" would try to render an image for them. Matching the
 * naming families rather than a fixed list keeps `details_9` working the day
 * someone adds it.
 */
export function isMediaMetafieldKey(qualifiedKey: string): boolean {
  const key = qualifiedKey.startsWith("custom.") ? qualifiedKey.slice("custom.".length) : qualifiedKey;
  return (
    /^details_\d+(_(standard|premium|pro))?$/.test(key) ||
    key === "package_product_standard" ||
    key === "package_product_pro" ||
    key === "package_box"
  );
}
