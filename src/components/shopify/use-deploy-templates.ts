"use client";

/**
 * Loads the price templates once per mount and resolves the picked one's table.
 *
 * The resolution runs the same function the deploy route uses, so the dialog's
 * variant preview cannot disagree with what is actually created.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_PRICING, resolvePricing, resolveVendor } from "@/lib/shopify/pricing";
import type { DeployTemplate, ResolvedPricing } from "@/types/deploy-template";

interface UseDeployTemplatesResult {
  templates: DeployTemplate[];
  loading: boolean;
  /** The selected template object, or null when none is picked. */
  template: DeployTemplate | null;
  /** Price table for the selected template (built-in defaults when none). */
  pricing: ResolvedPricing;
  /** Vendor for the selected template, or null to keep the builder default. */
  vendor: string | null;
  /** True when the signed-in user may create/edit/delete price tables (admin). */
  canEdit: boolean;
  reload: () => Promise<void>;
}

export function useDeployTemplates(templateId: string | null): UseDeployTemplatesResult {
  const [templates, setTemplates] = useState<DeployTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [canEdit, setCanEdit] = useState(false);

  /**
   * Fetch the list. `showSpinner` is false for the initial mount fetch so the
   * effect does not set state synchronously (it already starts as loading);
   * an explicit reload() from the UI does want the spinner back.
   */
  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch("/api/shopify/deploy-templates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: DeployTemplate[]; canEdit?: boolean };
      setTemplates(data.items ?? []);
      setCanEdit(Boolean(data.canEdit));
    } catch (error) {
      // A failed load must not block deploying: with no templates the dialog
      // falls back to the built-in default prices.
      console.error("[deploy-templates] load failed", error);
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(() => load(true), [load]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
  );

  const pricing = useMemo(
    () => (template ? resolvePricing(template.pricing) : DEFAULT_PRICING),
    [template],
  );

  const vendor = useMemo(() => resolveVendor(template), [template]);

  return { templates, loading, template, pricing, vendor, canEdit, reload };
}
