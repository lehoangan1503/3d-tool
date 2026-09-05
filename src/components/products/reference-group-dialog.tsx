"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Search, Loader2, Layers, Check, Pencil, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useReferenceList } from "@/hooks/use-reference-list";
import { isCueFrame } from "@/types/extractor";
import type { ExtractorReference, ExtractorReferenceGroup } from "@/types/extractor";

interface ReferenceGroupDialogProps {
  /** The group being edited, or null to create a new one. */
  group: ExtractorReferenceGroup | null;
  open: boolean;
  onClose: () => void;
  /** Called with the created/updated group so the caller can patch its list. */
  onSaved: (group: ExtractorReferenceGroup, isNew: boolean) => void;
  /** Open one reference in the extractor; absent when no base product is known. */
  onOpenReference?: (reference: ExtractorReference) => void;
}

/**
 * Group editor for the dashboard's "Tham Chiếu 2D" tab.
 *
 * A group is just an ordered list of reference ids, so the dialog shows the
 * whole team's reference list with the members ticked. Members are pinned to
 * the top: the picker pages lazily, so a member that has not been paged in yet
 * would otherwise be invisible — the dialog fetches those by id up front.
 */
export function ReferenceGroupDialog({
  group,
  open,
  onClose,
  onSaved,
  onOpenReference,
}: ReferenceGroupDialogProps) {
  const isNew = group === null;

  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Members fetched by id because they are not in the picker's loaded pages. */
  const [memberRefs, setMemberRefs] = useState<ExtractorReference[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  const {
    references,
    isLoading,
    isFetchingMore,
    hasMore,
    search,
    setSearch,
    sentinelRef,
  } = useReferenceList({ enabled: open });

  // Seed the form each time the dialog opens on a different group.
  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    setSelectedIds(new Set(group?.referenceIds ?? []));
    setError(null);
    setSearch("");
  }, [open, group, setSearch]);

  // Pull in the group's members by id — the picker's first page may not contain
  // them, and an unloaded member must still be visible (and untickable).
  useEffect(() => {
    if (!open || !group || group.referenceIds.length === 0) {
      setMemberRefs([]);
      return;
    }
    let cancelled = false;
    setLoadingMembers(true);
    (async () => {
      try {
        const fetched = await Promise.all(
          group.referenceIds.map((id) =>
            fetch(`/api/extractor-references/${id}`)
              .then((r) => (r.ok ? (r.json() as Promise<ExtractorReference>) : null))
              .catch(() => null)
          )
        );
        if (!cancelled) {
          setMemberRefs(fetched.filter((r): r is ExtractorReference => r !== null));
        }
      } finally {
        if (!cancelled) setLoadingMembers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, group]);

  // Everything the dialog knows about, deduped: fetched members first so a
  // member always has a card even before its page loads.
  const knownRefs = useMemo(() => {
    const byId = new Map<string, ExtractorReference>();
    for (const r of memberRefs) byId.set(r.id, r);
    for (const r of references) if (!byId.has(r.id)) byId.set(r.id, r);
    return byId;
  }, [memberRefs, references]);

  // Selected first (so ticking one lifts it to the top), then the rest of the
  // loaded page. Search filters both halves.
  const { selectedList, unselectedList } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (r: ExtractorReference) =>
      !q || r.name.toLowerCase().includes(q);

    const selected: ExtractorReference[] = [];
    for (const id of selectedIds) {
      const r = knownRefs.get(id);
      if (r && matches(r)) selected.push(r);
    }
    // The picker already applies `search` server-side; filter again so members
    // pinned from `memberRefs` obey the same query.
    const unselected = references.filter((r) => !selectedIds.has(r.id) && matches(r));
    return { selectedList: selected, unselectedList: unselected };
  }, [selectedIds, knownRefs, references, search]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Nhập tên nhóm.");
      return;
    }
    if (selectedIds.size === 0) {
      setError("Chọn ít nhất một tham chiếu.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const referenceIds = Array.from(selectedIds);
      const res = await fetch(
        isNew
          ? "/api/extractor-reference-groups"
          : `/api/extractor-reference-groups/${group.id}`,
        {
          method: isNew ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), referenceIds }),
        }
      );
      if (!res.ok) {
        const { error: message }: { error?: string } = await res
          .json()
          .catch(() => ({}));
        throw new Error(message ?? "Lưu nhóm thất bại.");
      }
      const saved: ExtractorReferenceGroup = await res.json();
      onSaved(saved, isNew);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lưu nhóm thất bại.");
    } finally {
      setIsSaving(false);
    }
  };

  const canEdit = isNew || group.canEdit !== false;

  const renderCard = (r: ExtractorReference, checked: boolean) => (
    <button
      key={r.id}
      type="button"
      onClick={() => canEdit && toggle(r.id)}
      disabled={!canEdit}
      className={`group relative rounded-lg border overflow-hidden text-left transition-colors ${
        checked ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/30"
      } ${canEdit ? "cursor-pointer" : "cursor-default"}`}
      title={canEdit ? (checked ? "Bỏ khỏi nhóm" : "Thêm vào nhóm") : r.name}
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
            <Layers className="h-6 w-6 text-muted-foreground/30" />
          </div>
        )}
      </div>

      {checked && (
        <span className="absolute top-1.5 left-1.5 h-5 w-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow">
          <Check className="h-3 w-3" />
        </span>
      )}

      {onOpenReference && (
        <span
          role="button"
          tabIndex={0}
          title="Mở trong trình chỉnh sửa"
          onClick={(e) => {
            e.stopPropagation();
            onOpenReference(r);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onOpenReference(r);
            }
          }}
          className="absolute top-1.5 right-1.5 h-6 w-6 rounded-md bg-black/60 text-white/80 hover:text-white hover:bg-black/80 flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </span>
      )}

      <div className="p-2">
        <div className="text-xs font-medium truncate">{r.name}</div>
        <div className="text-[11px] text-muted-foreground">
          {r.frames.filter(isCueFrame).length} khung
        </div>
      </div>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[88vh] flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{isNew ? "Tạo nhóm mới" : "Sửa nhóm"}</DialogTitle>
          <DialogDescription>
            Tick để thêm hoặc bỏ tham chiếu khỏi nhóm. Các tham chiếu đã chọn nằm
            ở trên đầu.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Pencil className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tên nhóm..."
              className="pl-8"
              disabled={!canEdit}
            />
          </div>
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Tìm tham chiếu..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {selectedList.length > 0 && (
            <>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                Đã chọn ({selectedIds.size})
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 mb-5">
                {selectedList.map((r) => renderCard(r, true))}
              </div>
            </>
          )}

          {loadingMembers && selectedList.length === 0 && selectedIds.size > 0 && (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}

          <div className="text-xs font-medium text-muted-foreground mb-2">
            Tất cả tham chiếu
          </div>
          {isLoading && references.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : unselectedList.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Không còn tham chiếu nào khác.
            </p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {unselectedList.map((r) => renderCard(r, false))}
            </div>
          )}

          {hasMore && (
            <div ref={sentinelRef} className="flex items-center justify-center py-6">
              {isFetchingMore && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <span className="text-sm text-muted-foreground">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : (
              `${selectedIds.size} tham chiếu trong nhóm`
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={isSaving}>
              Đóng
            </Button>
            {canEdit && (
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                {isNew ? "Tạo nhóm" : "Lưu"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
