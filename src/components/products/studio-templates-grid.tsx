"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Search, Loader2, Film, User, Download, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { VideoStudioTemplate } from "@/types/video-studio";

// Same page size as the dashboard product grid so both lists page identically.
const PAGE_SIZE = 20;

/**
 * V1 and V2 share one table; a V2 config is the one carrying an environment
 * block. Only used to build the right deep link — Studio 3D (v2) is abandoned
 * draft code, so this list does not offer it as a filter.
 */
function isV2Template(t: VideoStudioTemplate): boolean {
  return !!t.config?.environment;
}

interface StudioTemplatesGridProps {
  /** Rendered next to the heading — the dashboard's view tabs. */
  tabs?: React.ReactNode;
  /**
   * Superadmin or tool admin — shows the per-card delete button. The API
   * (`DELETE /api/video-studio-templates/[id]`) enforces this independently, so
   * a false value here only hides the affordance.
   */
  canDelete?: boolean;
}

/**
 * "Video 3D" — every Video Studio template in the team, with search.
 *
 * A template belongs to a product, so opening one deep-links straight into that
 * product's editor with `?tool=studio|studio2&template=<id>`, which opens the
 * matching studio variant with the template loaded.
 */
export function StudioTemplatesGrid({ tabs, canDelete }: StudioTemplatesGridProps) {
  const [templates, setTemplates] = useState<VideoStudioTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [total, setTotal] = useState(0);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isLoadingAll, setIsLoadingAll] = useState(false);
  /** id of the template currently being deleted — disables just that card. */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  async function handleDelete(template: VideoStudioTemplate) {
    if (
      !confirm(`Xoá mẫu "${template.name}"? Hành động này không thể hoàn tác.`)
    ) {
      return;
    }
    setDeletingId(template.id);
    try {
      const res = await fetch(`/api/video-studio-templates/${template.id}`, {
        method: "DELETE",
      });
      // This route answers 204 No Content on success, so there is no body to read.
      if (!res.ok) {
        const { error }: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(error ?? "Xoá mẫu thất bại.");
      }
      // Drop the row locally instead of refetching: this list pages itself, and a
      // refetch from offset 0 would collapse an expanded "Load All".
      setTemplates((prev) => prev.filter((x) => x.id !== template.id));
      setTotal((prev) => Math.max(0, prev - 1));
      offsetRef.current = Math.max(0, offsetRef.current - 1);
    } catch (err) {
      console.error("StudioTemplatesGrid: delete failed:", err);
      alert(err instanceof Error ? err.message : "Xoá mẫu thất bại.");
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(
    async (offset: number, currentSearch: string, append: boolean) => {
      if (offset === 0) setIsLoading(true);
      else setIsFetchingMore(true);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        if (currentSearch) params.set("search", currentSearch);

        const res = await fetch(`/api/video-studio-templates?${params}`);
        if (!res.ok) throw new Error("Failed to fetch templates");
        const json = await res.json();
        const items = (json.items ?? json.data ?? []) as VideoStudioTemplate[];

        setTemplates((prev) => (append ? [...prev, ...items] : items));
        setTotal(json.total ?? 0);
        offsetRef.current = offset + items.length;
      } catch (err) {
        console.error("StudioTemplatesGrid fetch error:", err);
        if (!append) {
          setTemplates([]);
          setTotal(0);
        }
      } finally {
        setIsLoading(false);
        setIsFetchingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    offsetRef.current = 0;
    setTemplates([]);
    fetchPage(0, debouncedSearch, false);
  }, [debouncedSearch, fetchPage]);

  const hasMore = templates.length < total;

  const handleLoadAll = useCallback(async () => {
    setIsLoadingAll(true);
    try {
      let accumulated = [...templates];
      let currentOffset = offsetRef.current;
      let knownTotal = total;
      while (accumulated.length < knownTotal) {
        const params = new URLSearchParams({ limit: "100", offset: String(currentOffset) });
        if (debouncedSearch) params.set("search", debouncedSearch);

        const res = await fetch(`/api/video-studio-templates?${params}`);
        if (!res.ok) break;
        const json = await res.json();
        const items = (json.items ?? json.data ?? []) as VideoStudioTemplate[];
        knownTotal = json.total ?? knownTotal;
        if (items.length === 0) break;
        accumulated = [...accumulated, ...items];
        currentOffset += items.length;
      }
      setTemplates(accumulated);
      setTotal(knownTotal);
      offsetRef.current = currentOffset;
    } catch (err) {
      console.error("StudioTemplatesGrid load-all error:", err);
    } finally {
      setIsLoadingAll(false);
    }
  }, [templates, total, debouncedSearch]);

  // IntersectionObserver sentinel — same approach as ProductsGrid.
  const sentinelRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      if (!el) return;
      observerRef.current = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting && !isFetchingMore && !isLoadingAll && hasMore) {
            fetchPage(offsetRef.current, debouncedSearch, true);
          }
        },
        { threshold: 0.1 }
      );
      observerRef.current.observe(el);
    },
    [isFetchingMore, isLoadingAll, hasMore, fetchPage, debouncedSearch]
  );

  const editorHref = (t: VideoStudioTemplate) => {
    const tool = isV2Template(t) ? "studio2" : "studio";
    return `/dashboard/products/${t.productId}?tool=${tool}&template=${t.id}`;
  };

  return (
    <div>
      <div className="sticky top-18 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pb-3 mb-6 -mx-4 px-4 z-10">
        <div className="flex items-center justify-between gap-3 pt-4">
          <h2 className="text-2xl font-bold shrink-0">Video 3D</h2>
          {tabs}
        </div>
        <p className="text-muted-foreground text-sm mt-0.5">
          Tất cả mẫu Video Studio của đội nhóm
          {total > 0 && (
            <span className="ml-1">
              ({hasMore ? `${templates.length}/${total}` : total})
            </span>
          )}
        </p>

        <div className="flex items-center gap-2 mt-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Tìm theo tên..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleLoadAll}
              disabled={isLoadingAll}
              className="gap-1.5"
            >
              {isLoadingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Load All ({total})
            </Button>
          )}
        </div>
      </div>

      {isLoading && templates.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Film className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-muted-foreground">
            {search ? "Không tìm thấy mẫu nào." : "Chưa có mẫu Video Studio nào."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((t) => (
            <div key={t.id} className="rounded-xl border bg-card p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{t.name}</div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {t.productName ?? "Sản phẩm đã xoá"}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 mt-auto">
                <span className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                  <User className="h-3 w-3 shrink-0" />
                  <span className="truncate">{t.createdByName ?? "—"}</span>
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {t.productId ? (
                    <Button size="sm" variant="outline" asChild>
                      <Link href={editorHref(t)} target="_blank" rel="noopener noreferrer">
                        {t.canEdit ? "Chỉnh sửa" : "Xem"}
                      </Link>
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled>
                      Không mở được
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Xoá mẫu"
                      disabled={deletingId === t.id}
                      onClick={() => handleDelete(t)}
                    >
                      {deletingId === t.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {hasMore && (
        <div ref={sentinelRef} className="flex items-center justify-center py-8">
          {(isFetchingMore || isLoadingAll) && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
      )}
    </div>
  );
}
