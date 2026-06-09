/**
 * Shopify product builder — TypeScript port of app/services/product_config.py
 * and parts of shopify_product_builder.py from the up_web_python tool.
 */

// ── Base config ──────────────────────────────────────────────────────────────

const SPEC_METAFIELDS: Record<string, Record<string, string>> = {
  Standard: {
    wrap: "gid://shopify/Metaobject/170152984713",
    wrapless: "gid://shopify/Metaobject/181394309257",
  },
  Premium: {
    wrap: "gid://shopify/Metaobject/170153181321",
    wrapless: "gid://shopify/Metaobject/181394342025",
  },
  Pro: {
    wrap: "gid://shopify/Metaobject/181394374793",
    wrapless: "gid://shopify/Metaobject/181394833545",
  },
};

const BASE_VERSIONS: Record<string, { price: number; discount_percent: number }> = {
  Standard: { price: 154.5, discount_percent: 15 },
  Premium: { price: 229.5, discount_percent: 20 },
  Pro: { price: 299.5, discount_percent: 20 },
};

const PRICE_MODIFIER_LASER_SHAFT = 20;
const PRICE_MODIFIER_CUSTOM_IMAGE = 20;
const PRICE_MODIFIER_CUSTOM_TEXT_PAID = 20;

const DEFAULT_PRODUCT_SETTINGS = {
  vendor: "Uni Cues",
  product_type: "Pool Cue",
  status: "active",
  weight: 600,
  weight_unit: "g",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function roundPriceNaturally(price: number): number {
  const whole = Math.floor(price);
  const decimal = price - whole;
  if (decimal < 0.25) return whole;
  if (decimal < 0.75) return whole + 0.5;
  return whole + 1;
}

function calculateCompareAtPrice(finalPrice: number, version: string): number {
  const pct = BASE_VERSIONS[version]?.discount_percent ?? 20;
  return roundPriceNaturally(finalPrice / (1 - pct / 100));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

/** Strip a file extension from an image name → its stem (e.g. "Mockup-Web-1.png" → "Mockup-Web-1"). */
function imageStem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

// ── Image classification (port of classify_attachments) ─────────────────────────

/** A rendered image: a public URL plus its reference name (e.g. "Mockup-Web-1"). */
export interface NamedImage {
  url: string;
  name: string;
}

/** A metafield image: which uploaded image (by gallery position) feeds which metafield key. */
export interface ImageMetafieldRef {
  position: number;
  metafieldKey: string;
}

export interface ClassifiedImages {
  /** Ordered gallery images (product images). */
  galleryImages: NamedImage[];
  /** Images uploaded to the gallery only so they get a Media GID, then moved to
   *  a metafield and deleted from the gallery. */
  metafieldImages: NamedImage[];
}

/**
 * Classify named images into product (gallery) images vs metafield images,
 * preserving a fixed gallery order regardless of input order.
 *
 * - Details-N[-Version]   → metafield custom.details_N[_version]
 * - Mockup-Web-N          → gallery image (base, always)
 * - Mockup-Web-N-Version  → gallery image selected by available versions
 *                           (N=2,5 pick one by Pro>Premium>Standard)
 * - Package-1-Standard    → metafield custom.package_product_standard
 * - Package-1-Pro         → metafield custom.package_product_pro
 * - Package-2             → metafield custom.package_box
 * - anything else         → skipped
 */
export function classifyImages(images: NamedImage[], versions: string[]): ClassifiedImages {
  const hasStandardOrPremium = versions.includes("Standard") || versions.includes("Premium");
  const hasPremium = versions.includes("Premium");
  const hasPro = versions.includes("Pro");

  const galleryImages: NamedImage[] = [];
  const metafieldImages: NamedImage[] = [];

  // Collect Mockup-Web candidates first, then emit in a fixed gallery order.
  const mockupCandidates = new Map<string, { base?: NamedImage; Standard?: NamedImage; Pro?: NamedImage }>();
  const package1: { Standard?: NamedImage; Pro?: NamedImage } = {};
  let package2: NamedImage | null = null;

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  for (const img of images) {
    const stem = imageStem(img.name);

    // Details-N or Details-N-Version
    let m = stem.match(/^Details-(\d+)(?:-(.+))?$/i);
    if (m) {
      const num = m[1];
      const verSuffix = m[2];
      if (verSuffix) {
        const ver = cap(verSuffix.trim());
        if (ver === "Standard" && versions.includes("Standard")) metafieldImages.push({ ...img, name: `details_${num}_standard` });
        else if (ver === "Premium" && versions.includes("Premium")) metafieldImages.push({ ...img, name: `details_${num}_premium` });
        else if (ver === "Pro" && versions.includes("Pro")) metafieldImages.push({ ...img, name: `details_${num}_pro` });
        // version not in card versions → skip
      } else {
        metafieldImages.push({ ...img, name: `details_${num}` });
      }
      continue;
    }

    // Mockup-Web-N or Mockup-Web-N-Version
    m = stem.match(/^Mockup-Web-(\d+)(?:-(.+))?$/i);
    if (m) {
      const num = m[1];
      const verSuffix = m[2];
      const entry = mockupCandidates.get(num) ?? {};
      if (!verSuffix) {
        if (!entry.base) entry.base = img;
      } else {
        const ver = cap(verSuffix.trim());
        if ((ver === "Standard" || ver === "Pro") && !entry[ver]) entry[ver] = img;
      }
      mockupCandidates.set(num, entry);
      continue;
    }

    // Package-N or Package-N-Version
    m = stem.match(/^Package-(\d+)(?:-(.+))?$/i);
    if (m) {
      const num = m[1];
      const verSuffix = m[2];
      if (num === "1" && verSuffix) {
        const ver = cap(verSuffix.trim());
        if ((ver === "Standard" || ver === "Pro") && !package1[ver]) package1[ver] = img;
      } else if (num === "2" && !verSuffix && package2 === null) {
        package2 = img;
      }
      continue;
    }
    // Unclassified → skip
  }

  // Finalize Mockup-Web gallery images in fixed numeric order.
  const sortedNums = [...mockupCandidates.keys()].sort((a, b) => Number(a) - Number(b));
  for (const num of sortedNums) {
    const c = mockupCandidates.get(num)!;
    if (c.base) galleryImages.push(c.base);

    if (num === "2" || num === "5") {
      // Pick a single versioned image by priority Pro > Premium(Standard) > Standard.
      let selected: NamedImage | undefined;
      if (hasPro && c.Pro) selected = c.Pro;
      else if (hasPremium && c.Standard) selected = c.Standard;
      else if (versions.includes("Standard") && c.Standard) selected = c.Standard;
      else if (c.Pro) selected = c.Pro;
      else if (c.Standard) selected = c.Standard;
      if (selected) galleryImages.push(selected);
      continue;
    }

    if (hasStandardOrPremium && c.Standard) galleryImages.push(c.Standard);
    if (hasPro && c.Pro) galleryImages.push(c.Pro);
  }

  if (package1.Standard) metafieldImages.push({ ...package1.Standard, name: "package_product_standard" });
  if (package1.Pro) metafieldImages.push({ ...package1.Pro, name: "package_product_pro" });
  if (package2) metafieldImages.push({ ...package2, name: "package_box" });

  return { galleryImages, metafieldImages };
}

// ── Variant generation ────────────────────────────────────────────────────────

export interface VariantInput {
  versions: Array<"Standard" | "Premium" | "Pro">;
  wrapType: "wrap" | "wrapless";
  laserShaft: boolean;
  customImage: boolean;
  /** Paid custom text adds a flat surcharge to every variant. */
  customTextPaid: boolean;
  baseSku: string;
}

export interface ShopifyVariant {
  option1: string;
  option2?: string;
  price: string;
  compare_at_price: string;
  sku?: string;
  inventory_management: string;
  inventory_quantity: number;
  weight: number;
  weight_unit: string;
  requires_shipping: boolean;
  metafields?: Array<{ namespace: string; key: string; type: string; value: string }>;
}

function generateVariants(input: VariantInput): ShopifyVariant[] {
  const { versions, wrapType, laserShaft, customImage, customTextPaid, baseSku } = input;
  const variants: ShopifyVariant[] = [];

  for (const version of versions) {
    const basePrice = BASE_VERSIONS[version]?.price ?? 154.5;
    const imagePriceAdd = customImage ? PRICE_MODIFIER_CUSTOM_IMAGE : 0;
    const textPaidAdd = customTextPaid ? PRICE_MODIFIER_CUSTOM_TEXT_PAID : 0;
    const optionValues = laserShaft ? ["No", "Yes"] : [null];

    for (const laserOpt of optionValues) {
      const priceIncrease = laserOpt === "Yes" ? PRICE_MODIFIER_LASER_SHAFT : 0;
      const finalPrice = basePrice + imagePriceAdd + textPaidAdd + priceIncrease;
      const compareAt = calculateCompareAtPrice(finalPrice, version);

      const versionSlug = slugify(version);
      let sku = `${baseSku}-${versionSlug}`;
      if (laserOpt !== null) {
        sku += `-${slugify(laserOpt)}`;
      }

      const metafieldGid = SPEC_METAFIELDS[version]?.[wrapType];

      const variant: ShopifyVariant = {
        option1: version,
        price: finalPrice.toString(),
        compare_at_price: compareAt.toString(),
        sku,
        inventory_management: "shopify",
        inventory_quantity: 10000,
        weight: DEFAULT_PRODUCT_SETTINGS.weight,
        weight_unit: DEFAULT_PRODUCT_SETTINGS.weight_unit,
        requires_shipping: true,
      };

      if (laserOpt !== null) {
        variant.option2 = laserOpt;
      }

      if (metafieldGid) {
        variant.metafields = [
          {
            namespace: "custom",
            key: "cue_spec_variants",
            type: "metaobject_reference",
            value: metafieldGid,
          },
        ];
      }

      variants.push(variant);
    }
  }

  return variants;
}

// ── Product builder ───────────────────────────────────────────────────────────

export interface CustomTextConfig {
  label: string;
  example: string;
}

export interface ProductInput {
  /** Product code e.g. n01-05 */
  productCode: string;
  /** Employee code e.g. n01 */
  employeeCode: string;
  title: string;
  descriptionHtml: string;
  /** Comma-separated or array */
  collections: string | string[];
  /** The single collection shown in the storefront breadcrumb (one of `collections`). */
  breadcrumbCollection?: string | null;
  /** Array of tag strings */
  manualTags: string[];
  /** Image URLs (parallel to imageNames). */
  imageUrls: string[];
  /** Image reference names (parallel to imageUrls) used for classification. */
  imageNames?: string[];
  versions: Array<"Standard" | "Premium" | "Pro">;
  wrapType: "wrap" | "wrapless";
  laserShaft: boolean;
  /** Custom_image label: price +$20, adds custom-upload tags, sets template_suffix */
  customImage?: boolean;
  /** Custom_text label: adds custom text metafields (free, no surcharge) */
  customText?: CustomTextConfig | null;
  /** Paid custom text: same metafields PLUS +$20 on every variant + a tag */
  customTextPaid?: boolean;
}

export interface ShopifyProductPayload {
  product: {
    title: string;
    handle: string;
    body_html: string;
    vendor: string;
    product_type: string;
    tags: string;
    status: string;
    template_suffix?: string;
    options: Array<{ name: string; position: number; values: string[] }>;
    variants: ShopifyVariant[];
    images: Array<{ src: string; alt: string; position: number }>;
    metafields?: Array<{ namespace: string; key: string; type: string; value: string }>;
  };
  /** Post-create instructions resolved by the API route (not sent to Shopify). */
  _metadata: {
    collections: string[];
    /** The single collection written to custom.breadcrumb_collection (null = skip). */
    breadcrumbCollection: string | null;
    /** Gallery position → custom metafield key (Details/Package images). */
    imageMetafields: ImageMetafieldRef[];
    /** Gallery position of the "Mockup-Web-1" image (laser shaft = No / default). */
    laserShaftDefaultImagePosition: number | null;
    /** Gallery position of the "Mockup-Web-5" image (laser shaft = Yes). */
    laserShaftImagePosition: number | null;
  };
}

export function buildShopifyProduct(input: ProductInput): ShopifyProductPayload {
  const {
    productCode,
    employeeCode,
    title,
    descriptionHtml,
    collections,
    breadcrumbCollection = null,
    manualTags,
    imageUrls,
    imageNames = [],
    versions,
    wrapType,
    laserShaft,
    customImage = false,
    customText = null,
    customTextPaid = false,
  } = input;

  // Build handle
  const titleSlug = slugify(title);
  const codeSlug = slugify(productCode);
  const handle = titleSlug.includes(codeSlug) ? titleSlug : `${titleSlug}-${codeSlug}`;

  // Build tags. No title/handle-derived tag (it produced a stray duplicate tag).
  // Tag the full product code (nXX-YY) only — the employee code is implied by it.
  const tags = new Set<string>([wrapType, productCode.toLowerCase()]);
  if (laserShaft) tags.add("laser shaft");

  // Custom_image label adds specific tags
  if (customImage) {
    tags.add("custom-upload");
    tags.add("custom-image");
  }

  // Either custom-text mode (free or paid) uses the same Shopify tag, since
  // only one can be picked per product and the storefront logic keys on it.
  if (customTextPaid || customText?.label) {
    tags.add("custom-text");
  }

  for (const tag of manualTags) {
    if (tag.trim()) tags.add(tag.trim().toLowerCase());
  }

  // Collections → col_ tags
  const collectionList = Array.isArray(collections)
    ? collections
    : collections.split(",").map((c) => c.trim()).filter(Boolean);

  for (const col of collectionList) {
    tags.add(`col_${col.trim()}`);
  }

  // Build options
  const options: Array<{ name: string; position: number; values: string[] }> = [
    { name: "Version", position: 1, values: versions },
  ];
  if (laserShaft) {
    options.push({ name: "Shaft Engraving", position: 2, values: ["No", "Yes"] });
  }

  // Build variants
  const TIER_ORDER = ["Standard", "Premium", "Pro"] as const;
  const sortedVersions = [...versions].sort(
    (a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b)
  );

  const variants = generateVariants({
    versions: sortedVersions,
    wrapType,
    laserShaft,
    customImage,
    customTextPaid,
    baseSku: productCode,
  });

  // Classify images by name → gallery (product) images vs metafield images.
  // Both are uploaded as gallery images (so Shopify mints a Media GID for each);
  // the API route later moves the metafield images off the gallery.
  const named: NamedImage[] = imageUrls.map((url, idx) => ({
    url,
    name: imageNames[idx] ?? `image-${idx + 1}`,
  }));
  const classified = classifyImages(named, sortedVersions);
  // Fallback: if no image followed the Mockup-Web/Details/Package naming
  // convention, classification would drop everything. Keep the legacy behaviour
  // (every rendered image becomes a gallery image, in order) so products are
  // never created with an empty gallery.
  const { galleryImages, metafieldImages } =
    classified.galleryImages.length === 0 && classified.metafieldImages.length === 0
      ? { galleryImages: named, metafieldImages: [] as NamedImage[] }
      : classified;

  const images: Array<{ src: string; alt: string; position: number }> = [];
  const imageMetafields: ImageMetafieldRef[] = [];
  let laserShaftDefaultImagePosition: number | null = null;
  let laserShaftImagePosition: number | null = null;
  let pos = 1;

  // Gallery images first, tracking the laser-shaft default (Mockup-Web-1) and
  // toggled (Mockup-Web-5) positions for later variant-image mapping.
  for (const img of galleryImages) {
    const stem = imageStem(img.name);
    images.push({ src: img.url, alt: title, position: pos });
    if (laserShaftDefaultImagePosition === null && /^Mockup-Web-1$/i.test(stem)) {
      laserShaftDefaultImagePosition = pos;
    }
    if (laserShaftImagePosition === null && /^Mockup-Web-5(?:-.+)?$/i.test(stem)) {
      laserShaftImagePosition = pos;
    }
    pos++;
  }

  // Metafield images appended at the end; the route promotes them to metafields
  // (custom.details_N / package_*) and deletes them from the gallery.
  for (const img of metafieldImages) {
    images.push({ src: img.url, alt: title, position: pos });
    imageMetafields.push({ position: pos, metafieldKey: img.name });
    pos++;
  }

  // Build product-level metafields for Custom_text
  const metafields: Array<{ namespace: string; key: string; type: string; value: string }> = [];
  if (customText?.label) {
    metafields.push({
      namespace: "custom",
      key: "custom_text_caption",
      type: "single_line_text_field",
      value: customText.label,
    });
  }
  if (customText?.example) {
    metafields.push({
      namespace: "custom",
      key: "custom_text_example",
      type: "single_line_text_field",
      value: customText.example,
    });
  }

  const payload: ShopifyProductPayload = {
    product: {
      title,
      handle,
      body_html: descriptionHtml,
      vendor: DEFAULT_PRODUCT_SETTINGS.vendor,
      product_type: DEFAULT_PRODUCT_SETTINGS.product_type,
      tags: Array.from(tags).join(", "),
      status: DEFAULT_PRODUCT_SETTINGS.status,
      options,
      variants,
      images,
    },
    _metadata: {
      collections: collectionList,
      breadcrumbCollection: breadcrumbCollection?.trim() && collectionList.includes(breadcrumbCollection.trim())
        ? breadcrumbCollection.trim()
        : null,
      imageMetafields,
      laserShaftDefaultImagePosition,
      laserShaftImagePosition,
    },
  };

  // Custom_image sets the theme template for the custom upload experience
  if (customImage) {
    payload.product.template_suffix = "custom-upload";
  }

  if (metafields.length > 0) {
    payload.product.metafields = metafields;
  }

  return payload;
}

// ── Description field parser (mirrors Python's _extract_line_value) ───────────

export interface ParsedDescription {
  title?: string;
  collections?: string;
  tags?: string;
  aiHint?: string;
  customTextLabel?: string;
  customTextExample?: string;
  description?: string;
}

/** Extract structured fields from a freeform description string.
 *  Supports: Title:, collections:, Tags:, AI_HINT:, Custom text label:,
 *  Custom text example:, Description: (case-insensitive).
 */
export function parseDescriptionFields(text: string): ParsedDescription {
  if (!text?.trim()) return {};

  function extractLine(fieldName: string): string {
    const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, "im"));
    return match ? match[1].trim() : "";
  }

  return {
    title: extractLine("Title") || undefined,
    collections: extractLine("collections") || undefined,
    tags: extractLine("Tags") || undefined,
    aiHint: extractLine("AI_HINT") || undefined,
    customTextLabel: extractLine("Custom text label") || undefined,
    customTextExample: extractLine("Custom text example") || undefined,
    description: extractLine("Description") || undefined,
  };
}

/** Basic markdown → HTML (handles bold, italic, newlines). */
export function markdownToHtml(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}
