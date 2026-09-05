"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Loader2, Layers, User, Download, Pencil, Trash2, Plus, FolderOpen } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PickProductDialog } from "@/components/products/pick-product-dialog";
import { ReferenceGroupDialog } from "@/components/products/reference-group-dialog";
import { useReferenceList, invalidateReferenceListCache } from "@/hooks/use-reference-list";
import { isCueFrame } from "@/types/extractor";
import type { ExtractorReference, ExtractorReferenceGroup } from "@/types/extractor";
import type { Product } from "@/types/product";

/** Which of the two sub-tabs is showing. */
type ReferenceView = "groups" | "singles";

interface ReferencesGridProps {
  /** Rendered next to the heading — the dashboard's view tabs. */
  tabs?: React.ReactNode;
  /**
   * Superadmin or tool admin — shows the per-card delete button. The API
   * (`DELETE /api/extractor-references/[id]`) enforces this independently, so a
   * false value here only hides the affordance.
   */
  canDelete?: boolean;
}

/**
 * "Tham Chiếu 2D" — every extractor layout in the team, with search.
 *
 * A layout is not tied to a product, so opening one for editing asks which
 * product to render it on, then deep-links into that product's editor with
 * `?tool=extractor&ref=<id>` so the extractor opens on that layout.
 */
export function ReferencesGrid({ tabs, canDelete }: ReferencesGridProps) {
  const {
    references,
    total,
    isLoading,
    isFetchingMore,
    hasMore,
    search,
    setSearch,
    loadMore,
    reload,
    sentinelRef,
  } = useReferenceList({ enabled: true });

  /** id of the reference currently being deleted — disables just that card. */
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /** Groups vs loose references — groups open first, they are the tidier view. */
  const [view, setView] = useState<ReferenceView>("groups");

  const [groups, setGroups] = useState<ExtractorReferenceGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
  /** Group being edited in the dialog; `null` inside `editorOpen` means "create". */
  const [editingGroup, setEditingGroup] = useState<ExtractorReferenceGroup | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const res = await fetch("/api/extractor-reference-groups");
      if (!res.ok) throw new Error("Failed to fetch groups");
      const { items }: { items: ExtractorReferenceGroup[] } = await res.json();
      setGroups(items ?? []);
    } catch (err) {
      console.error("ReferencesGrid: failed to load groups:", err);
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "groups") loadGroups();
  }, [view, loadGroups]);

  async function handleDeleteGroup(group: ExtractorReferenceGroup) {
    if (
      !confirm(
        `Xoá nhóm "${group.name}"? Các tham chiếu bên trong không bị xoá.`
      )
    ) {
      return;
    }
    setDeletingGroupId(group.id);
    try {
      const res = await fetch(`/api/extractor-reference-groups/${group.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const { error }: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(error ?? "Xoá nhóm thất bại.");
      }
      setGroups((prev) => prev.filter((g) => g.id !== group.id));
    } catch (err) {
      console.error("ReferencesGrid: delete group failed:", err);
      alert(err instanceof Error ? err.message : "Xoá nhóm thất bại.");
    } finally {
      setDeletingGroupId(null);
    }
  }

  const handleGroupSaved = (saved: ExtractorReferenceGroup, isNew: boolean) => {
    setGroups((prev) =>
      isNew ? [saved, ...prev] : prev.map((g) => (g.id === saved.id ? saved : g))
    );
  };

  // A reference layout records no product — `extractor_references` has only
  // user_id + name, and its frames hold camera/HDRI data — so there is nothing
  // to detect. The extractor still needs a cue to render, so default to the
  // newest product and let the user switch.
  const [baseProduct, setBaseProduct] = useState<Product | null>(null);
  /** Set when the user is choosing a product: the reference to open after picking. */
  const [pending, setPending] = useState<ExtractorReference | null>(null);
  /** True when the picker was opened just to change the default product. */
  const [changingBase, setChangingBase] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/products?limit=1&offset=0");
        if (!res.ok) return;
        const { items }: { items: Product[] } = await res.json();
        if (!cancelled) setBaseProduct(items?.[0] ?? null);
      } catch (err) {
        console.error("ReferencesGrid: failed to load default product:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDelete(reference: ExtractorReference) {
    if (
      !confirm(
        `Xoá bố cục "${reference.name}"? Hành động này không thể hoàn tác.`
      )
    ) {
      return;
    }
    setDeletingId(reference.id);
    try {
      const res = await fetch(`/api/extractor-references/${reference.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const { error }: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(error ?? "Xoá bố cục thất bại.");
      }
      // reload() drops the hook's session cache; without it the deleted row
      // comes straight back from cache on the next render.
      reload();
    } catch (err) {
      console.error("ReferencesGrid: delete failed:", err);
      alert(err instanceof Error ? err.message : "Xoá bố cục thất bại.");
    } finally {
      setDeletingId(null);
    }
  }

  // The list hook caches pages for the whole session, so returning here after
  // editing a layout in the editor would show stale data. Drop the cache once
  // when this tab mounts.
  useEffect(() => {
    invalidateReferenceListCache();
  }, []);

  // "Load All" just drives the hook's own pager until nothing is left, so it
  // reuses the same caching and dedup as infinite scroll.
  const [isLoadingAll, setIsLoadingAll] = useState(false);
  useEffect(() => {
    if (!isLoadingAll) return;
    if (!hasMore) {
      setIsLoadingAll(false);
      return;
    }
    if (!isFetchingMore) loadMore();
  }, [isLoadingAll, hasMore, isFetchingMore, loadMore]);

  const openReference = (reference: ExtractorReference, product: Product) => {
    // Open in a new tab so the dashboard list stays put behind it.
    window.open(
      `/dashboard/products/${product.id}?tool=extractor&ref=${reference.id}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  /** Open on the default product, or ask for one if none could be loaded. */
  const handleOpen = (reference: ExtractorReference) => {
    if (baseProduct) openReference(reference, baseProduct);
    else setPending(reference);
  };

  const handlePickProduct = (product: Product) => {
    setBaseProduct(product);
    if (pending) openReference(pending, product);
    setPending(null);
    setChangingBase(false);
  };

  const pickerOpen = !!pending || changingBase;

  // Group search is client-side: the list endpoint returns every group at once.
  const groupQuery = groupSearch.trim().toLowerCase();
  const visibleGroups = groupQuery
    ? groups.filter((g) => g.name.toLowerCase().includes(groupQuery))
    : groups;

  return (
    <div>
      <div className="sticky top-18 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pb-3 mb-6 -mx-4 px-4 z-10">
        <div className="flex items-center justify-between gap-3 pt-4">
          <h2 className="text-2xl font-bold shrink-0">Tham Chiếu 2D</h2>
          {tabs}
        </div>
        <p className="text-muted-foreground text-sm mt-0.5">
          Tất cả bố cục khung chụp ảnh của đội nhóm
          {view === "groups"
            ? groups.length > 0 && <span className="ml-1">({groups.length} nhóm)</span>
            : total > 0 && (
                <span className="ml-1">
                  ({hasMore ? `${references.length}/${total}` : total})
                </span>
              )}
        </p>

        {/* Nhóm vs từng tham chiếu — the same layout can belong to several
            groups, so the singles tab stays a full list rather than a leftover. */}
        <div className="inline-flex items-center gap-1 mt-3 rounded-lg bg-muted/50 p-1">
          <button
            type="button"
            onClick={() => setView("groups")}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
              view === "groups"
                ? "bg-background shadow-sm font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Nhóm
          </button>
          <button
            type="button"
            onClick={() => setView("singles")}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
              view === "singles"
                ? "bg-background shadow-sm font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Tham chiếu lẻ
          </button>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder={view === "groups" ? "Tìm nhóm..." : "Tìm theo tên..."}
              value={view === "groups" ? groupSearch : search}
              onChange={(e) =>
                view === "groups" ? setGroupSearch(e.target.value) : setSearch(e.target.value)
              }
              className="pl-8"
            />
          </div>
          {view === "groups" && (
            <Button
              size="sm"
              onClick={() => {
                setEditingGroup(null);
                setEditorOpen(true);
              }}
              className="gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              Tạo nhóm
            </Button>
          )}
          {view === "singles" && hasMore && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsLoadingAll(true)}
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

          {/* Which cue the layouts open on — a layout stores no product, so this
              defaults to the newest one and stays switchable. */}
          <div className="flex items-center gap-1.5 ml-auto min-w-0">
            <span className="text-xs text-muted-foreground shrink-0">Mở trên:</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setChangingBase(true)}
              className="gap-1.5 max-w-[220px]"
              title="Đổi sản phẩm dùng để mở bố cục"
            >
              <Pencil className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{baseProduct?.name ?? "Chọn sản phẩm"}</span>
            </Button>
          </div>
        </div>
      </div>

      {view === "groups" ? (
        groupsLoading && groups.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : visibleGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground">
              {groupSearch ? "Không tìm thấy nhóm nào." : "Chưa có nhóm nào."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleGroups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  setEditingGroup(g);
                  setEditorOpen(true);
                }}
                className="group rounded-xl border bg-card overflow-hidden flex flex-col text-left hover:border-foreground/30 transition-colors cursor-pointer"
              >
                <div className="aspect-square bg-[#111827] flex items-center justify-center">
                  <div className="text-center">
                    <FolderOpen className="h-10 w-10 text-muted-foreground/40 mx-auto mb-2" />
                    <span className="text-xs text-muted-foreground">
                      {g.referenceIds.length} tham chiếu
                    </span>
                  </div>
                </div>
                <div className="p-3 flex flex-col gap-2 flex-1">
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{g.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {g.referenceIds.length} tham chiếu
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-auto">
                    <span className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                      <User className="h-3 w-3 shrink-0" />
                      <span className="truncate">{g.createdByName ?? "—"}</span>
                    </span>
                    {g.canEdit !== false && (
                      <span
                        role="button"
                        tabIndex={0}
                        title="Xoá nhóm"
                        aria-disabled={deletingGroupId === g.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (deletingGroupId !== g.id) handleDeleteGroup(g);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            if (deletingGroupId !== g.id) handleDeleteGroup(g);
                          }
                        }}
                        className="h-8 w-8 shrink-0 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      >
                        {deletingGroupId === g.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )
      ) : (
        <>
        {isLoading && references.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : references.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Layers className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground">
              {search ? "Không tìm thấy tham chiếu nào." : "Chưa có tham chiếu nào."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {references.map((r) => (
              <div
                key={r.id}
                className="group rounded-xl border bg-card overflow-hidden flex flex-col"
              >
                <div className="aspect-square bg-[#111827] overflow-hidden">
                  {r.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.thumbUrl}
                      alt={r.name}
                      className="w-full h-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Layers className="h-8 w-8 text-muted-foreground/30" />
                    </div>
                  )}
                </div>
                <div className="p-3 flex flex-col gap-2 flex-1">
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{r.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {r.frames.filter(isCueFrame).length} khung
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-auto">
                    <span className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                      <User className="h-3 w-3 shrink-0" />
                      <span className="truncate">{r.createdByName ?? "—"}</span>
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="outline" onClick={() => handleOpen(r)}>
                        {r.canEdit ? "Chỉnh sửa" : "Xem"}
                      </Button>
                      {canDelete && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          title="Xoá bố cục"
                          disabled={deletingId === r.id}
                          onClick={() => handleDelete(r)}
                        >
                          {deletingId === r.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
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
        </>
      )}

      <ReferenceGroupDialog
        open={editorOpen}
        group={editingGroup}
        onClose={() => {
          setEditorOpen(false);
          setEditingGroup(null);
        }}
        onSaved={handleGroupSaved}
        // Opening a reference needs a cue to render it on; without a base
        // product the dialog hides the shortcut rather than opening the picker
        // on top of itself.
        onOpenReference={
          baseProduct ? (r) => openReference(r, baseProduct) : undefined
        }
      />

      <PickProductDialog
        open={pickerOpen}
        title="Chọn sản phẩm"
        description={
          pending
            ? `Mở bố cục "${pending.name}" trên sản phẩm nào?`
            : "Bố cục sẽ mở trên sản phẩm này."
        }
        onClose={() => {
          setPending(null);
          setChangingBase(false);
        }}
        onPick={handlePickProduct}
      />
    </div>
  );
}
