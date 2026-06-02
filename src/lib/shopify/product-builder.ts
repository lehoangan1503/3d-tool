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

function buildTitleTag(title: string): string {
  const words = title.toLowerCase().split(/\s+/).filter(Boolean);
  const stopWords = new Set(["a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by", "of", "from"]);
  return words.filter((w) => !stopWords.has(w)).join("-");
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
  /** Array of tag strings */
  manualTags: string[];
  /** Image URLs for gallery */
  imageUrls: string[];
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
}

export function buildShopifyProduct(input: ProductInput): ShopifyProductPayload {
  const {
    productCode,
    employeeCode,
    title,
    descriptionHtml,
    collections,
    manualTags,
    imageUrls,
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

  // Build tags
  const tags = new Set<string>([wrapType, employeeCode]);
  const titleTag = buildTitleTag(title);
  if (titleTag) tags.add(titleTag);
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
    tags.add(`col_${col.toLowerCase().replace(/\s+/g, "_")}`);
  }

  // Build options
  const options: Array<{ name: string; position: number; values: string[] }> = [
    { name: "Version", position: 1, values: versions },
  ];
  if (laserShaft) {
    options.push({ name: "Laser Shaft", position: 2, values: ["No", "Yes"] });
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

  // Build images
  const images = imageUrls.map((url, idx) => ({
    src: url,
    alt: title,
    position: idx + 1,
  }));

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
