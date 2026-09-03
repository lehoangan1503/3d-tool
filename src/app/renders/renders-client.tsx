"use client";

/**
 * /renders — the operator-facing front end for GPU rendering.
 *
 * Before this page the pipeline had no UI at all: jobs could only be queued
 * with curl, and finished output existed solely as URLs in a JSON response.
 * The deploy dialog still renders in the browser; this page is the first thing
 * that actually uses the server-side path end to end.
 *
 * Polling, not Realtime: a render is minutes long and a handful of rows, so a
 * 2s poll of one endpoint (`/api/render-jobs?status=…` returns the whole batch
 * in ONE request) is simpler than a subscription and degrades better — a
 * dropped socket would silently stop updating, a failed poll retries.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  FileArchive,
  Film,
  ImageIcon,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { RenderJobCard } from "@/components/render-worker/render-job-card";
import { RenderProductPicker } from "@/components/render-worker/render-product-picker";
import {
  downloadJobsAsZip,
  type DownloadProgress,
} from "@/lib/render/download-outputs";
import { RenderExpiryNotice } from "@/components/render-worker/render-expiry-notice";
import type { RenderJob } from "@/types/render-job";

/** How often to poll while anything is still running. */
const POLL_MS = 2000;

interface PickerItem {
  id: string;
  name: string;
}

type RenderKind = "image" | "video";

interface JobsResponse {
  jobs?: RenderJob[];
}

interface QueueResponse {
  jobs?: RenderJob[];
  warning?: string;
  error?: string;
}

export function RendersClient() {
  const [kind, setKind] = useState<RenderKind>("image");
  const [groups, setGroups] = useState<PickerItem[]>([]);
  const [templates, setTemplates] = useState<PickerItem[]>([]);

  // Products live in RenderProductPicker, which pages them; only the selection
  // is lifted here so it survives search and kind changes.
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [targetId, setTargetId] = useState<string | null>(null);

  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [queueing, setQueueing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zipping, setZipping] = useState<DownloadProgress | null>(null);
  const [clearing, setClearing] = useState(false);

  // Load the group/template pickers once.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [groupRes, templateRes] = await Promise.all([
          fetch("/api/extractor-reference-groups?limit=100"),
          fetch("/api/video-studio-templates?limit=100"),
        ]);

        if (cancelled) return;

        // All three list endpoints answer with { items, total } — verified
        // against the routes, not guessed. The array fallback covers a plain
        // list response so this does not silently empty if one ever changes.
        const readList = async (res: Response): Promise<PickerItem[]> => {
          if (!res.ok) return [];
          const data: unknown = await res.json();
          const rows = Array.isArray(data)
            ? data
            : ((data as { items?: unknown }).items ?? []);
          return (Array.isArray(rows) ? rows : [])
            .map((row) => {
              const r = row as { id?: string; name?: string };
              return r.id ? { id: r.id, name: r.name ?? "(không tên)" } : null;
            })
            .filter((r): r is PickerItem => r !== null);
        };

        const [g, t] = await Promise.all([readList(groupRes), readList(templateRes)]);

        if (cancelled) return;
        setGroups(g);
        setTemplates(t);
      } catch {
        if (!cancelled) setError("Không tải được danh sách nhóm ảnh / template");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/render-jobs?limit=30");
      if (!res.ok) return;
      const data = (await res.json()) as JobsResponse;
      setJobs(data.jobs ?? []);
    } catch {
      // A failed poll is not worth surfacing — the next tick retries.
    }
  }, []);

  // Initial load. The lint rule flags setState-in-effect, but this is the case
  // the rule explicitly allows: refreshJobs awaits a fetch and only sets state
  // in the async continuation, which is "subscribe to an external system", not
  // a synchronous cascade.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshJobs();
  }, [refreshJobs]);

  // Poll only while something is live, so an idle page makes no requests.
  // refreshJobs is stable (useCallback, no deps), so this interval is created
  // once per live/idle transition rather than on every job update.
  const hasLiveJob = jobs.some((j) => j.status === "queued" || j.status === "running");

  useEffect(() => {
    if (!hasLiveJob) return;
    const id = setInterval(() => void refreshJobs(), POLL_MS);
    return () => clearInterval(id);
  }, [hasLiveJob, refreshJobs]);

  const targets = kind === "image" ? groups : templates;

  /** Switching kind clears the target: a group id is meaningless for video.
   *  Done here rather than in an effect so there is no second render pass. */
  function selectKind(next: RenderKind) {
    if (next === kind) return;
    setKind(next);
    setTargetId(null);
  }

  async function handleQueue() {
    setError(null);
    setMessage(null);

    const ids = [...selectedProducts];
    if (ids.length === 0) {
      setError("Chọn ít nhất 1 sản phẩm");
      return;
    }
    if (!targetId) {
      setError(kind === "image" ? "Chọn 1 nhóm ảnh" : "Chọn 1 template video");
      return;
    }

    setQueueing(true);
    try {
      // The route takes the first product in the URL and the rest in the body;
      // it creates one job per product so they run on separate pods.
      const [first, ...rest] = ids;
      const path =
        kind === "image"
          ? `/api/products/${first}/renders`
          : `/api/products/${first}/videos`;

      const body =
        kind === "image"
          ? { groupId: targetId, productIds: rest, format: "png" }
          : { templateId: targetId, productIds: rest, width: 1920, height: 1080, fps: 60 };

      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as QueueResponse;

      if (!res.ok) {
        setError(data.error ?? `Queue thất bại (${res.status})`);
        return;
      }

      const count = data.jobs?.length ?? 0;
      setMessage(
        `Đã đưa ${count} job vào hàng đợi` + (data.warning ? ` — ${data.warning}` : "")
      );
      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setQueueing(false);
    }
  }

  // Downloadable jobs: finished, still holding files. Gating the button on
  // "nothing is running" is deliberate — a zip built mid-batch would silently
  // omit whatever finishes a second later, which is worse than a disabled
  // button, since the user would think they had everything.
  const downloadableJobs = jobs.filter(
    (j) => j.status === "succeeded" && j.purgedAt === null && j.outputs.length > 0
  );
  const allSettled = jobs.length > 0 && !hasLiveJob;
  const canDownloadAll = allSettled && downloadableJobs.length > 0;
  const totalFiles = downloadableJobs.reduce((sum, j) => sum + j.outputs.length, 0);
  const finishedCount = jobs.filter(
    (j) => j.status === "succeeded" || j.status === "failed" || j.status === "canceled"
  ).length;

  async function handleDownloadAll() {
    setError(null);
    setZipping({ done: 0, total: totalFiles });
    try {
      await downloadJobsAsZip(downloadableJobs, setZipping);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tải tất cả thất bại");
    } finally {
      setZipping(null);
    }
  }

  async function handleCancel(jobId: string) {
    await fetch(`/api/render-jobs/${jobId}`, { method: "DELETE" });
    await refreshJobs();
  }

  async function handleRemove(jobId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/render-jobs/${jobId}/remove`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? `Xoá thất bại (${res.status})`);
        return;
      }
      // Drop it locally first so the card disappears on click rather than on
      // the next poll; refreshJobs then reconciles with the server.
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Xoá thất bại");
    }
  }

  /** Clears every finished job at once — the "tidy up" the list needs after a
   *  batch. Running jobs are left alone; they have a pod on the way. */
  async function handleClearFinished() {
    const targets = jobs.filter(
      (j) => j.status === "succeeded" || j.status === "failed" || j.status === "canceled"
    );
    if (targets.length === 0) return;

    setError(null);
    setClearing(true);
    try {
      const results = await Promise.all(
        targets.map((j) =>
          fetch(`/api/render-jobs/${j.id}/remove`, { method: "POST" })
            .then((res) => ({ id: j.id, ok: res.ok }))
            .catch(() => ({ id: j.id, ok: false }))
        )
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setError(`${failed.length}/${targets.length} job không xoá được`);
      }
      await refreshJobs();
    } finally {
      setClearing(false);
    }
  }

  async function handleRetry(jobId: string) {
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/render-jobs/${jobId}/retry`, { method: "POST" });
      const data = (await res.json()) as QueueResponse & { job?: RenderJob };
      if (!res.ok) {
        setError(data.error ?? `Render lại thất bại (${res.status})`);
        return;
      }
      setMessage(
        `Đã đưa lại vào hàng đợi${data.warning ? ` — ${data.warning}` : ""}`
      );
      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Render lại thất bại");
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/dashboard">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <h1 className="text-lg font-semibold">Render trên GPU</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleDownloadAll()}
              disabled={!canDownloadAll || zipping !== null}
              title={
                jobs.length === 0
                  ? "Chưa có job nào"
                  : !allSettled
                    ? "Đợi tất cả job render xong"
                    : downloadableJobs.length === 0
                      ? "Không có file nào để tải"
                      : `Tải ${totalFiles} file từ ${downloadableJobs.length} sản phẩm`
              }
              className="gap-1.5"
            >
              {zipping ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="hidden sm:inline">
                    {zipping.done}/{zipping.total}
                  </span>
                </>
              ) : (
                <>
                  <FileArchive className="h-4 w-4" />
                  <span className="hidden sm:inline">
                    Tải tất cả{totalFiles > 0 ? ` (${totalFiles})` : ""}
                  </span>
                </>
              )}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleClearFinished()}
              disabled={finishedCount === 0 || clearing}
              title={
                finishedCount === 0
                  ? "Không có job nào đã xong"
                  : `Xoá ${finishedCount} job đã xong (kèm file)`
              }
              className="gap-1.5"
            >
              {clearing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">
                Xoá đã xong{finishedCount > 0 ? ` (${finishedCount})` : ""}
              </span>
            </Button>

            <Button variant="outline" size="sm" onClick={() => void refreshJobs()}>
              <RefreshCw className="h-4 w-4" />
              <span className="hidden sm:inline">Làm mới</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          {/* ── Picker ─────────────────────────────────────────── */}
          <div className="space-y-4">
            <div className="rounded-lg border bg-card p-3">
              <div className="mb-3 flex gap-2">
                <KindTab
                  active={kind === "image"}
                  onClick={() => selectKind("image")}
                  icon={ImageIcon}
                  label="Ảnh mockup"
                />
                <KindTab
                  active={kind === "video"}
                  onClick={() => selectKind("video")}
                  icon={Film}
                  label="Video"
                />
              </div>

              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {kind === "image" ? "Nhóm ảnh" : "Template video"}
              </label>
              <Select
                value={targetId ?? undefined}
                onValueChange={(value) => setTargetId(value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={`— chọn ${kind === "image" ? "nhóm ảnh" : "template"} —`}
                  />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {kind === "video" && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Video 1920×1080 60fps — mỗi clip vài chục MB và mất vài phút GPU.
                </p>
              )}
            </div>

            <RenderProductPicker
              selectedIds={selectedProducts}
              onSelectionChange={setSelectedProducts}
            />

            <Button
              className="w-full"
              onClick={() => void handleQueue()}
              disabled={queueing || selectedProducts.size === 0 || !targetId}
            >
              {queueing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Đang gửi...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Render {selectedProducts.size > 0 ? `${selectedProducts.size} sản phẩm` : ""}
                </>
              )}
            </Button>

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </p>
            )}
            {message && (
              <p className="rounded-md border border-green-500/40 bg-green-500/10 p-2 text-sm text-muted-foreground">
                {message}
              </p>
            )}
          </div>

          {/* ── Jobs ───────────────────────────────────────────── */}
          <div className="space-y-3">
            <RenderExpiryNotice jobs={jobs} />

            {jobs.length === 0 ? (
              <div className="rounded-lg border border-dashed p-12 text-center">
                <p className="text-sm text-muted-foreground">
                  Chưa có job nào. Chọn sản phẩm và nhóm ảnh bên trái để bắt đầu.
                </p>
              </div>
            ) : (
              jobs.map((job) => (
                <RenderJobCard
                  key={job.id}
                  job={job}
                  onCancel={handleCancel}
                  onRetry={handleRetry}
                  onRemove={handleRemove}
                  // A single job stays open; in a batch, SUCCEEDED ones fold away
                  // so the running one is not buried under old thumbnails.
                  // A failed job stays open on purpose — its error message is
                  // the reason the user is looking at the page.
                  defaultCollapsed={jobs.length > 1 && job.status === "succeeded"}
                />
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function KindTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof ImageIcon;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-muted"
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
