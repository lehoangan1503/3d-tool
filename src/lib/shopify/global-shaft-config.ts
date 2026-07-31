/**
 * Global shaft (laser engraving) preview config.
 *
 * The laser-engraving preview was authored once, on product
 * `d8e852f1-c992-41f9-bee5-bd3f0e6ba87c` ("n00-11-Father Day"), and is reused
 * for every cue: the shaft artwork is the same across the catalogue, so the
 * preview images and text-frame placement do not vary per product.
 *
 * The storefront customizer gates its laser-name input on the
 * `custom.shaft_config` metafield (`has_shaft_config` in
 * cue-customizer-dialog-core.liquid). When a product offers a "Shaft Engraving"
 * option but has no shaft_config, picking "Yes" puts the dialog in laser-name
 * mode with no input to fill, which hard-blocks add-to-cart. So any product
 * with that option must carry the config — hence this fallback.
 */

import { createAdminServiceClient } from "@/lib/supabase/server";
import type { ShaftConfig } from "@/types/product";

/** The product row that holds the canonical, hand-authored shaft config. */
export const GLOBAL_SHAFT_CONFIG_PRODUCT_ID = "d8e852f1-c992-41f9-bee5-bd3f0e6ba87c";

interface ShaftConfigRow {
  shaft_config: ShaftConfig | null;
}

// Cached for the lifetime of the server process — the source row changes only
// when someone re-authors the preview in the internal tool.
let cached: ShaftConfig | null | undefined;

/** True when the config carries at least one usable preview image. */
export function isUsableShaftConfig(config: ShaftConfig | null | undefined): config is ShaftConfig {
  return Boolean(config && (config.standard?.imageUrl || config.proLux?.imageUrl));
}

/**
 * Read the global shaft config from its source product row. Returns null (and
 * logs) if it cannot be read — callers treat that as "no config", which is the
 * pre-existing behaviour rather than a deploy failure.
 */
export async function getGlobalShaftConfig(): Promise<ShaftConfig | null> {
  if (cached !== undefined) return cached;

  try {
    const service = createAdminServiceClient();
    const { data, error } = await service
      .from("products")
      .select("shaft_config")
      .eq("id", GLOBAL_SHAFT_CONFIG_PRODUCT_ID)
      .maybeSingle<ShaftConfigRow>();

    if (error) throw new Error(error.message);
    cached = isUsableShaftConfig(data?.shaft_config) ? data!.shaft_config : null;
    if (!cached) {
      console.warn("[global-shaft-config] source product has no usable shaft_config");
    }
  } catch (err) {
    // Do not cache failures — a transient DB error shouldn't disable the
    // fallback for the rest of the process lifetime.
    console.warn("[global-shaft-config] read failed:", err instanceof Error ? err.message : err);
    return null;
  }

  return cached;
}

/**
 * Resolve the shaft config to deploy: the product's own config wins; otherwise
 * fall back to the global one when the product actually offers laser engraving.
 */
export async function resolveShaftConfig(
  ownConfig: ShaftConfig | null | undefined,
  laserShaft: boolean,
): Promise<ShaftConfig | null> {
  if (isUsableShaftConfig(ownConfig)) return ownConfig;
  if (!laserShaft) return null;
  return getGlobalShaftConfig();
}
