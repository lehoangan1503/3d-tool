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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  FileArchive,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { RenderProductCard } from "@/components/render-worker/render-product-card";
import { RenderProductPicker } from "@/components/render-worker/render-product-picker";
import {
  RenderTargetPicker,
  type ImageSelection,
  type RenderTargetItem,
} from "@/components/render-worker/render-target-picker";
import {
  downloadProductGroupsAsZip,
  type DownloadProgress,
} from "@/lib/render/download-outputs";
import {
  downloadableSections,
  groupJobsByProduct,
  type TargetNameLookup,
} from "@/lib/render/group-jobs";
import { RenderExpiryNotice } from "@/components/render-worker/render-expiry-notice";
import type { RenderJob } from "@/types/render-job";

/** How often to poll while anything is still running. */
const POLL_MS = 2000;


interface JobsResponse {
  jobs?: RenderJob[];
}

interface QueueResponse {
  jobs?: RenderJob[];
  warning?: string;
  error?: string;
}

export function RendersClient() {
  const [groups, setGroups] = useState<RenderTargetItem[]>([]);
  const [templates, setTemplates] = useState<RenderTargetItem[]>([]);

  // Products live in RenderProductPicker, which pages them; only the selection
  // is lifted here so it survives search and paging.
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());

  // Several groups and templates at once: one click can queue both kinds, so
  // the previous single `kind` + `targetId` pair is gone.
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([]);
  // Per-group image subset. A group absent from the map renders in full.
  const [imageSelection, setImageSelection] = useState<ImageSelection>({});

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
        // referenceIds is carried through for image groups: the badge shows the
        // count and the detail dialog needs the ids to fetch names/thumbnails.
        // Templates have none, so the field stays undefined for them.
        const readList = async (res: Response): Promise<RenderTargetItem[]> => {
          if (!res.ok) return [];
          const data: unknown = await res.json();
          const rows = Array.isArray(data)
            ? data
            : ((data as { items?: unknown }).items ?? []);
          return (Array.isArray(rows) ? rows : [])
            .map((row) => {
              const r = row as { id?: string; name?: string; referenceIds?: string[] };
              return r.id
                ? {
                    id: r.id,
                    name: r.name ?? "(không tên)",
                    ...(Array.isArray(r.referenceIds)
                      ? { referenceIds: r.referenceIds }
                      : {}),
                  }
                : null;
            })
            .filter((r): r is RenderTargetItem => r !== null);
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

  /**
   * Queues every (target x product) combination.
   *
   * One request per target, each carrying the whole product list — the routes
   * already fan a request out into one job per product, so N targets means N
   * requests rather than N x M. They run concurrently: each is a cheap insert
   * whose latency is dominated by the round-trip, so N in sequence meant N
   * times the wait for no benefit.
   */
  async function handleQueue() {
    setError(null);
    setMessage(null);

    const productIds = [...selectedProducts];
    if (productIds.length === 0) {
      setError("Chọn ít nhất 1 sản phẩm");
      return;
    }
    if (selectedGroupIds.length === 0 && selectedTemplateIds.length === 0) {
      setError("Chọn ít nhất 1 nhóm ảnh hoặc 1 template video");
      return;
    }

    // The routes take the first product in the URL and the rest in the body.
    const [first, ...rest] = productIds;

    interface QueueRequest {
      path: string;
      body: Record<string, unknown>;
      label: string;
    }

    const requests: QueueRequest[] = [
      ...selectedGroupIds.map((groupId): QueueRequest => {
        const picked = imageSelection[groupId];
        return {
          path: `/api/products/${first}/renders`,
          body: {
            groupId,
            productIds: rest,
            format: "png",
            // Omitted when the whole group is wanted, so a group that gains an
            // image between picking and rendering still includes it.
            ...(picked ? { referenceIds: picked } : {}),
          },
          label: groups.find((g) => g.id === groupId)?.name ?? "nhóm ảnh",
        };
      }),
      ...selectedTemplateIds.map((templateId): QueueRequest => ({
        path: `/api/products/${first}/videos`,
        body: { templateId, productIds: rest, width: 1920, height: 1080, fps: 60 },
        label: templates.find((t) => t.id === templateId)?.name ?? "video",
      })),
    ];

    setQueueing(true);
    try {
      let queued = 0;
      const failures: string[] = [];
      const warnings: string[] = [];

      // In PARALLEL, not one after another. These are independent inserts
      // against different targets, and running them in sequence made the wait
      // the SUM of every request instead of the slowest one — with four
      // targets that was the difference between ~1s and ~30s before the first
      // card appeared. Order is still deterministic because results come back
      // indexed, so the failure list reads in the order the targets were
      // picked.
      const results = await Promise.all(
        requests.map(async (req) => {
          try {
            const res = await fetch(req.path, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(req.body),
            });
            const data = (await res.json()) as QueueResponse;
            return { req, ok: res.ok, status: res.status, data };
          } catch (err) {
            return {
              req,
              ok: false,
              status: 0,
              data: {
                error: err instanceof Error ? err.message : "lỗi mạng",
              } as QueueResponse,
            };
          }
        })
      );

      for (const { req, ok, status, data } of results) {
        if (!ok) {
          failures.push(`${req.label}: ${data.error ?? status}`);
          continue;
        }
        queued += data.jobs?.length ?? 0;
        if (data.warning) warnings.push(`${req.label}: ${data.warning}`);
      }

      // Both can be set: some targets queued, others did not. Reporting only
      // the error would hide jobs that are already on their way to a pod.
      if (queued > 0) {
        setMessage(
          `Đã đưa ${queued} job vào hàng đợi (${requests.length - failures.length}/${requests.length} mục)` +
            (warnings.length > 0 ? ` — ${warnings.join("; ")}` : "")
        );
      }
      if (failures.length > 0) {
        setError(`${failures.length}/${requests.length} mục thất bại — ${failures.join("; ")}`);
      }

      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setQueueing(false);
    }
  }

  // ── What pressing Render will actually create ──
  // One job per (target x product): the pods run per job, so this is the number
  // that decides GPU spend and how long the batch takes.
  const targetCount = selectedGroupIds.length + selectedTemplateIds.length;
  const plannedJobs = targetCount * selectedProducts.size;

  // File totals, for the line under the button. Images depend on how many
  // layouts each group contributes (a filtered group contributes fewer).
  const plannedImages = selectedGroupIds.reduce((sum, id) => {
    const picked = imageSelection[id];
    const group = groups.find((g) => g.id === id);
    return sum + (picked ? picked.length : (group?.referenceIds?.length ?? 0));
  }, 0) * selectedProducts.size;
  // A video template records exactly one clip per product.
  const plannedVideos = selectedTemplateIds.length * selectedProducts.size;

  /**
   * One card per product, jobs as sections inside it.
   *
   * A batch of 2 products x (2 image groups + 1 video) used to be six cards
   * named after only two products — indistinguishable in the header and
   * impossible to scan. The names come from the pickers already loaded above,
   * so no extra request is needed: the job row carries group_id / template_id,
   * and the payload that holds the name is deliberately not sent to the client.
   */
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

  // Downloadable products: those still holding files. Gating the button on
  // "nothing is running" is deliberate — a zip built mid-batch would silently
  // omit whatever finishes a second later, which is worse than a disabled
  // button, since the user would think they had everything.
  const downloadableGroups = productGroups.filter(
    (g) => downloadableSections(g).length > 0
  );
  const allSettled = jobs.length > 0 && !hasLiveJob;
  const canDownloadAll = allSettled && downloadableGroups.length > 0;
  const totalFiles = downloadableGroups.reduce((sum, g) => sum + g.fileCount, 0);
  const finishedCount = jobs.filter(
    (j) => j.status === "succeeded" || j.status === "failed" || j.status === "canceled"
  ).length;

  async function handleDownloadAll() {
    setError(null);
    setZipping({ done: 0, total: totalFiles });
    try {
      // One folder per product, one sub-folder per group/template inside it —
      // two groups never share a directory, which is the whole point.
      await downloadProductGroupsAsZip(downloadableGroups, setZipping);
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

  /**
   * Deletes every finished job on ONE product card.
   *
   * The card's X now stands for a whole product, so it fans out over the
   * sections rather than deleting a single job. Failures are counted, not
   * thrown: a partial delete still tidied most of the card, and the next poll
   * shows exactly what survived.
   */
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
      // Drop them locally first so the card disappears on click rather than on
      // the next poll; refreshJobs then reconciles with the server.
      const removed = new Set(jobIds);
      setJobs((prev) => prev.filter((j) => !removed.has(j.id)));
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
                    : downloadableGroups.length === 0
                      ? "Không có file nào để tải"
                      : `Tải ${totalFiles} file từ ${downloadableGroups.length} sản phẩm — mỗi sản phẩm một thư mục, mỗi nhóm một thư mục con`
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
              <RenderTargetPicker
                groups={groups}
                templates={templates}
                selectedGroupIds={selectedGroupIds}
                selectedTemplateIds={selectedTemplateIds}
                imageSelection={imageSelection}
                onChangeGroups={setSelectedGroupIds}
                onChangeTemplates={setSelectedTemplateIds}
                onChangeImageSelection={setImageSelection}
                disabled={queueing}
              />
            </div>

            <RenderProductPicker
              selectedIds={selectedProducts}
              onSelectionChange={setSelectedProducts}
            />

            <Button
              className="w-full"
              onClick={() => void handleQueue()}
              disabled={queueing || selectedProducts.size === 0 || targetCount === 0}
            >
              {queueing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Đang gửi...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Render{plannedJobs > 0 ? ` ${plannedJobs} job` : ""}
                </>
              )}
            </Button>

            {/* The arithmetic behind the button, because "5 products x 3 groups
                + 2 templates" is not obvious from the badges alone. */}
            {plannedJobs > 0 && (
              <p className="text-center text-xs text-muted-foreground">
                {selectedProducts.size} sản phẩm × {targetCount} mục
                {selectedGroupIds.length > 0 && ` (${selectedGroupIds.length} nhóm ảnh`}
                {selectedGroupIds.length > 0 && selectedTemplateIds.length > 0 && ", "}
                {selectedGroupIds.length === 0 && selectedTemplateIds.length > 0 && " ("}
                {selectedTemplateIds.length > 0 && `${selectedTemplateIds.length} video`}
                {targetCount > 0 && ")"}
                {plannedImages > 0 && ` — ${plannedImages} ảnh`}
                {plannedVideos > 0 && `, ${plannedVideos} clip`}
              </p>
            )}

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
              productGroups.map((group) => (
                <RenderProductCard
                  key={group.key}
                  group={group}
                  onCancel={handleCancel}
                  onRetry={handleRetry}
                  onRemove={handleRemove}
                  onRemoveGroup={handleRemoveGroup}
                  // A single product stays open; in a batch, fully-succeeded
                  // cards fold away so the running one is not buried under old
                  // thumbnails. A card with a failure stays open on purpose —
                  // its error message is why the user is looking at the page.
                  defaultCollapsed={
                    productGroups.length > 1 &&
                    !group.live &&
                    group.counts.failed === 0
                  }
                />
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
