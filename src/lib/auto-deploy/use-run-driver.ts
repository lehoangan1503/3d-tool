"use client";

import { useCallback, useRef, useState } from "react";
import type { Product } from "@/types/product";
import type { AutoDeployConfig } from "./types";
import {
  runProductDeploy,
  fetchReferencesForGroups,
  fetchSkills,
  fetchVideoTemplate,
  type RunContext,
} from "./run-pipeline";
import type { RunItem } from "@/components/auto-deploy/run-progress";

interface RunDriver {
  items: RunItem[];
  running: boolean;
  finished: boolean;
  prepError: string | null;
  start: (products: Product[], config: AutoDeployConfig) => Promise<void>;
  retryFailed: (config: AutoDeployConfig) => Promise<void>;
  cancel: () => void;
}

/**
 * Sequential driver for the auto-deploy run. Processes products one at a time
 * (safe for browser memory + Shopify rate limits), skips-and-continues on a
 * per-product failure, supports cancel and retry-of-failed.
 */
export function useRunDriver(): RunDriver {
  const [items, setItems] = useState<RunItem[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const updateItem = useCallback((productId: string, patch: Partial<RunItem>) => {
    setItems((prev) => prev.map((it) => (it.product.id === productId ? { ...it, ...patch } : it)));
  }, []);

  // Process a fixed list of products that already exist as items in state.
  const process = useCallback(
    async (products: Product[], config: AutoDeployConfig) => {
      setPrepError(null);
      setRunning(true);
      setFinished(false);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Fetch shared context once for the whole run.
      let ctx: RunContext;
      try {
        const [references, skills, videoTemplate] = await Promise.all([
          fetchReferencesForGroups(config.groupIds, ctrl.signal),
          fetchSkills(config.skillIds, ctrl.signal),
          fetchVideoTemplate(config.videoTemplateId, ctrl.signal),
        ]);
        if (references.length === 0) throw new Error("Nhóm đã chọn không có khung ảnh nào");
        ctx = { references, skills, config, videoTemplate };
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setPrepError(e instanceof Error ? e.message : String(e));
        }
        setRunning(false);
        setFinished(true);
        return;
      }

      for (const product of products) {
        if (ctrl.signal.aborted) break;
        updateItem(product.id, { status: "running", step: "render", stepDone: 0, stepTotal: ctx.references.length, error: undefined });
        try {
          const result = await runProductDeploy(
            product,
            ctx,
            (p) => updateItem(product.id, { step: p.step, stepDone: p.done, stepTotal: p.total }),
            ctrl.signal,
          );
          updateItem(product.id, {
            status: "done",
            adminUrl: result.adminUrl,
            isUpdate: result.isUpdate,
            step: undefined,
          });
        } catch (err) {
          if (ctrl.signal.aborted) break;
          // Skip & continue — record the failure and move on.
          updateItem(product.id, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            step: undefined,
          });
        }
      }

      setRunning(false);
      setFinished(true);
      abortRef.current = null;
    },
    [updateItem],
  );

  const start = useCallback(
    async (products: Product[], config: AutoDeployConfig) => {
      setItems(products.map((product) => ({ product, status: "pending" as const })));
      await process(products, config);
    },
    [process],
  );

  const retryFailed = useCallback(
    async (config: AutoDeployConfig) => {
      const failedProducts = items.filter((it) => it.status === "failed").map((it) => it.product);
      if (failedProducts.length === 0) return;
      // Reset the failed ones to pending; leave succeeded items as-is.
      setItems((prev) =>
        prev.map((it) => (it.status === "failed" ? { ...it, status: "pending", error: undefined, step: undefined } : it)),
      );
      await process(failedProducts, config);
    },
    [items, process],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { items, running, finished, prepError, start, retryFailed, cancel };
}
