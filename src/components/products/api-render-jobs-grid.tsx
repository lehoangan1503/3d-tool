"use client";

/**
 * "Render Job" — renders queued from OUTSIDE the dashboard.
 *
 * Every job here was started by an API token through POST /api/v1/renders,
 * which in practice means an AI agent or an n8n flow. They share the queue and
 * the GPU worker with the dashboard's own renders — the split is only about
 * who is watching: this tab answers "what did the automation do", and /renders
 * answers "what did I just queue".
 *
 * The card, the grouping and the download logic are the ones /renders already
 * uses. Nothing about a job's presentation changes because a token queued it,
 * so re-implementing any of that would only create a second thing to fix.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Server } from "lucide-react";
import { RenderProductCard } from "@/components/render-worker/render-product-card";
import {
  groupJobsByProduct,
  type TargetNameLookup,
} from "@/lib/render/group-jobs";
import type { RenderJob } from "@/types/render-job";

/** Same cadence as /renders: fast enough to feel live, cheap enough to leave on. */
const POLL_MS = 2000;

/** How many jobs the tab shows. Older ones expire out of Storage anyway. */
const JOB_LIMIT = 50;

interface ApiRenderJobsGridProps {
  /** Rendered next to the heading — the dashboard's view tabs. */
  tabs?: React.ReactNode;
}

interface TargetItem {
  id: string;
  name: string;
}

export function ApiRenderJobsGrid({ tabs }: ApiRenderJobsGridProps) {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Names for the group / template ids on each job.
   *
   * The card labels a section by its target, and a job row stores only the id.
   * Loaded once — these lists change far more slowly than the queue does.
   */
  const [groups, setGroups] = useState<TargetItem[]>([]);
  const [templates, setTemplates] = useState<TargetItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [groupRes, templateRes] = await Promise.all([
          fetch("/api/extractor-reference-groups?limit=100"),
          fetch("/api/video-studio-templates?limit=100"),
        ]);
        if (cancelled) return;
        if (groupRes.ok) {
          const { items }: { items?: TargetItem[] } = await groupRes.json();
          if (!cancelled) setGroups(items ?? []);
        }
        if (templateRes.ok) {
          const { items }: { items?: TargetItem[] } = await templateRes.json();
          if (!cancelled) setTemplates(items ?? []);
        }
      } catch (err) {
        console.error("ApiRenderJobsGrid: failed to load target names:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      // source=api is the whole point of this tab — see migration 038.
      const res = await fetch(`/api/render-jobs?source=api&limit=${JOB_LIMIT}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Không tải được danh sách (${res.status})`);
      }
      const { jobs: rows }: { jobs: RenderJob[] } = await res.json();
      setJobs(rows ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được danh sách job");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const targetNames: TargetNameLookup = useMemo(
    () => ({
      groups: Object.fromEntries(groups.map((g) => [g.id, g.name])),
      templates: Object.fromEntries(templates.map((t) => [t.id, t.name])),
    }),
    [groups, templates]
  );

  const productGroups = useMemo(
    () => groupJobsByProduct(jobs, targetNames),
    [jobs, targetNames]
  );

  const liveCount = jobs.filter(
    (job) => job.status === "queued" || job.status === "running"
  ).length;

  async function handleCancel(jobId: string) {
    await fetch(`/api/render-jobs/${jobId}`, { method: "DELETE" });
    await refresh();
  }

  async function handleRemove(jobId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/render-jobs/${jobId}/remove`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Xoá thất bại (${res.status})`);
        return;
      }
      // Drop it locally first so the card reacts to the click rather than to
      // the next poll; refresh then reconciles with the server.
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Xoá thất bại");
    }
  }

  async function handleRemoveGroup(jobIds: string[]) {
    if (jobIds.length === 0) return;
    setError(null);
    try {
      const results = await Promise.all(
        jobIds.map((id) =>
          fetch(`/api/render-jobs/${id}/remove`, { method: "POST" })
            .then((res) => res.ok)
            .catch(() => false)
        )
      );
      const failed = results.filter((ok) => !ok).length;
      if (failed > 0) setError(`${failed}/${jobIds.length} mục không xoá được`);
      setJobs((prev) => prev.filter((j) => !jobIds.includes(j.id)));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Xoá thất bại");
    }
  }

  async function handleRetry(jobId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/render-jobs/${jobId}/retry`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Render lại thất bại (${res.status})`);
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Render lại thất bại");
    }
  }

  return (
    <div>
      <div className="sticky top-18 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pb-3 mb-6 -mx-4 px-4 z-10">
        <div className="flex items-center justify-between gap-3 pt-4">
          <h2 className="text-2xl font-bold shrink-0">Render Job</h2>
          {tabs}
        </div>
        <p className="text-muted-foreground text-sm mt-0.5">
          Job đặt từ bên ngoài qua API token (AI agent, n8n)
          {jobs.length > 0 && (
            <span className="ml-1">
              ({jobs.length}
              {liveCount > 0 && ` · ${liveCount} đang chạy`})
            </span>
          )}
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
          {error}
        </div>
      )}

      {loading && jobs.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : productGroups.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Server className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-muted-foreground">Chưa có job nào đặt qua API.</p>
          <p className="text-xs text-muted-foreground/70 mt-1.5 max-w-md">
            Job đặt từ dashboard nằm ở trang{" "}
            <code className="font-mono">/renders</code>. Tab này chỉ hiện job gọi
            qua <code className="font-mono">POST /api/v1/renders</code> bằng API
            token.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {productGroups.map((group) => (
            <RenderProductCard
              key={group.key}
              group={group}
              onCancel={handleCancel}
              onRetry={handleRetry}
              onRemove={handleRemove}
              onRemoveGroup={handleRemoveGroup}
              // A finished card is history here, not something just queued:
              // this tab is usually opened to check on an agent that ran
              // earlier, so collapsed keeps the list scannable.
              defaultCollapsed={!group.live}
            />
          ))}
        </div>
      )}
    </div>
  );
}
