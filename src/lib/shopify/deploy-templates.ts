/**
 * Server-side access to price templates — the named price tables picked at
 * deploy time.
 */

import { createServiceClient } from "@/lib/supabase/server";
import type { DeployPricing, DeployTemplate } from "@/types/deploy-template";

/** Raw DB row shape (snake_case), narrowed rather than cast through `any`. */
interface TemplateRow {
  id: string;
  name: string;
  vendor: string | null;
  pricing: DeployPricing | null;
  created_at?: string;
  updated_at?: string;
}

const TEMPLATE_COLUMNS = "id, name, vendor, pricing, created_at, updated_at";

function mapTemplate(row: TemplateRow): DeployTemplate {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor ?? null,
    // A NULL/absent pricing column is an empty table, which resolves to the
    // built-in defaults rather than throwing.
    pricing: row.pricing ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every price template, name-sorted for the pickers. */
export async function listDeployTemplates(): Promise<DeployTemplate[]> {
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("deploy_templates")
    .select(TEMPLATE_COLUMNS)
    .order("name", { ascending: true });

  if (error) throw new Error(error.message);
  return ((data ?? []) as TemplateRow[]).map(mapTemplate);
}

/** One template, or null when the id does not exist. */
export async function getDeployTemplate(id: string): Promise<DeployTemplate | null> {
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("deploy_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? mapTemplate(data as TemplateRow) : null;
}

/**
 * Load a template for a deploy. A blank/unknown id yields null, which makes the
 * builder fall back to the built-in prices — the pre-template behaviour — rather
 * than failing the deploy.
 */
export async function getDeployTemplateForDeploy(
  id: string | null | undefined,
): Promise<DeployTemplate | null> {
  if (!id?.trim()) return null;
  try {
    return await getDeployTemplate(id.trim());
  } catch (error) {
    console.error("[deploy-templates] failed to load template", id, error);
    return null;
  }
}
