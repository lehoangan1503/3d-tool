"use client";

/**
 * Picks WHAT to render: any number of image groups and video templates at once.
 *
 * Before this the page held a single exclusive `kind` plus one target id, so a
 * batch was either all-image or all-video and switching tabs silently discarded
 * the other side's choice. One click now queues both kinds, and each selection
 * shows as a badge whose image groups can be opened to include/exclude
 * individual layouts.
 *
 * Selection state lives in the parent (the queue call needs it), so this
 * component is presentational apart from the reference list it lazy-loads for
 * the dialog.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Film, ImageIcon, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** A selectable group or template. */
export interface RenderTargetItem {
  id: string;
  name: string;
  /** Image groups only: how many references the group holds. */
  referenceIds?: string[];
}

/**
 * Which images of a chosen group to render.
 *
 * `null` means "the whole group, whatever it holds now" — deliberately distinct
 * from an array listing every id: the group can gain a reference between
 * choosing it and pressing render, and the unfiltered case should pick that up.
 */
export type ImageSelection = Record<string, string[] | null>;

interface ReferenceSummary {
  id: string;
  name: string;
  thumbUrl: string | null;
}

interface SummaryResponse {
  items?: ReferenceSummary[];
}

interface RenderTargetPickerProps {
  groups: RenderTargetItem[];
  templates: RenderTargetItem[];
  selectedGroupIds: string[];
  selectedTemplateIds: string[];
  /** Per-group image subset; a group absent from this map renders in full. */
  imageSelection: ImageSelection;
  onChangeGroups: (ids: string[]) => void;
  onChangeTemplates: (ids: string[]) => void;
  onChangeImageSelection: (selection: ImageSelection) => void;
  disabled?: boolean;
}

export function RenderTargetPicker({
  groups,
  templates,
  selectedGroupIds,
  selectedTemplateIds,
  imageSelection,
  onChangeGroups,
  onChangeTemplates,
  onChangeImageSelection,
  disabled,
}: RenderTargetPickerProps) {
  // Which group's detail dialog is open; null = closed.
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);

  const groupById = useMemo(
    () => new Map(groups.map((g) => [g.id, g])),
    [groups]
  );
  const templateById = useMemo(
    () => new Map(templates.map((t) => [t.id, t])),
    [templates]
  );

  /** How many images a chosen group will actually render. */
  const countFor = useCallback(
    (groupId: string): number => {
      const picked = imageSelection[groupId];
      if (picked) return picked.length;
      return groupById.get(groupId)?.referenceIds?.length ?? 0;
    },
    [imageSelection, groupById]
  );

  const availableGroups = groups.filter((g) => !selectedGroupIds.includes(g.id));
  const availableTemplates = templates.filter((t) => !selectedTemplateIds.includes(t.id));

  function addGroup(id: string) {
    onChangeGroups([...selectedGroupIds, id]);
  }

  function removeGroup(id: string) {
    onChangeGroups(selectedGroupIds.filter((g) => g !== id));
    // Drop the subset too, so re-adding the group starts from "all of it"
    // rather than silently restoring a filter the user cannot see.
    if (id in imageSelection) {
      const next = { ...imageSelection };
      delete next[id];
      onChangeImageSelection(next);
    }
  }

  const openGroup = openGroupId ? groupById.get(openGroupId) : undefined;

  return (
    <div className="space-y-3">
      {/* ── Image groups ── */}
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ImageIcon className="h-3.5 w-3.5" /> Nhóm ảnh mockup
        </label>

        <Select
          // Radix keeps the chosen value; here every pick is an "add", so the
          // trigger must fall back to its placeholder each time.
          value=""
          onValueChange={addGroup}
          disabled={disabled || availableGroups.length === 0}
        >
          <SelectTrigger className="w-full">
            <SelectValue
              placeholder={
                groups.length === 0
                  ? "— không có nhóm nào —"
                  : availableGroups.length === 0
                    ? "— đã chọn hết —"
                    : "+ thêm nhóm ảnh"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {availableGroups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
                {g.referenceIds ? ` (${g.referenceIds.length} ảnh)` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedGroupIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedGroupIds.map((id) => {
              const group = groupById.get(id);
              const total = group?.referenceIds?.length ?? 0;
              const picked = countFor(id);
              const filtered = imageSelection[id] != null && picked !== total;

              return (
                <span
                  key={id}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border py-0.5 pl-2 pr-1 text-[11px] font-medium",
                    filtered
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
                      : "border-blue-500/30 bg-blue-500/10 text-blue-500 dark:text-blue-400"
                  )}
                >
                  {/* The badge body opens the detail dialog; the × removes. */}
                  <button
                    type="button"
                    onClick={() => setOpenGroupId(id)}
                    className="hover:underline"
                    title="Chọn ảnh cụ thể trong nhóm"
                  >
                    {group?.name ?? id.slice(0, 8)}{" "}
                    <span className="tabular-nums opacity-80">
                      {picked}
                      {filtered ? `/${total}` : ""} ảnh
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeGroup(id)}
                    aria-label={`Bỏ nhóm ${group?.name ?? ""}`}
                    className="rounded-full p-0.5 hover:bg-black/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Video templates ── */}
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Film className="h-3.5 w-3.5" /> Template video
        </label>

        <Select
          value=""
          onValueChange={(id) => onChangeTemplates([...selectedTemplateIds, id])}
          disabled={disabled || availableTemplates.length === 0}
        >
          <SelectTrigger className="w-full">
            <SelectValue
              placeholder={
                templates.length === 0
                  ? "— không có template nào —"
                  : availableTemplates.length === 0
                    ? "— đã chọn hết —"
                    : "+ thêm template video"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {availableTemplates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedTemplateIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedTemplateIds.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/10 py-0.5 pl-2 pr-1 text-[11px] font-medium text-purple-500 dark:text-purple-400"
              >
                {templateById.get(id)?.name ?? id.slice(0, 8)}
                <button
                  type="button"
                  onClick={() =>
                    onChangeTemplates(selectedTemplateIds.filter((t) => t !== id))
                  }
                  aria-label={`Bỏ template ${templateById.get(id)?.name ?? ""}`}
                  className="rounded-full p-0.5 hover:bg-black/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {selectedTemplateIds.length > 0 && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Video 1920×1080 — mỗi clip vài chục MB và mất vài phút GPU. Video chạy
            sau cùng, một mình trên GPU để không bị giật.
          </p>
        )}
      </div>

      {openGroup && (
        <GroupImageDialog
          group={openGroup}
          selected={imageSelection[openGroup.id] ?? null}
          onClose={() => setOpenGroupId(null)}
          onChange={(ids) => {
            const next = { ...imageSelection };
            // All of them selected is stored as null, i.e. "the whole group",
            // so a group that later gains an image still renders it.
            if (ids === null || ids.length === (openGroup.referenceIds?.length ?? 0)) {
              delete next[openGroup.id];
            } else {
              next[openGroup.id] = ids;
            }
            onChangeImageSelection(next);
          }}
        />
      )}
    </div>
  );
}

/**
 * The per-group checklist.
 *
 * Names and thumbnails come from one summary request rather than N per-id
 * fetches — a 22-image group would otherwise open with 22 round trips.
 */
function GroupImageDialog({
  group,
  selected,
  onClose,
  onChange,
}: {
  group: RenderTargetItem;
  selected: string[] | null;
  onClose: () => void;
  onChange: (ids: string[] | null) => void;
}) {
  const [refs, setRefs] = useState<ReferenceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ids = useMemo(() => group.referenceIds ?? [], [group.referenceIds]);

  useEffect(() => {
    if (ids.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRefs([]);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/extractor-references/summary?ids=${encodeURIComponent(ids.join(","))}`
        );
        if (cancelled) return;
        if (!res.ok) {
          setError("Không tải được danh sách ảnh");
          setRefs([]);
          return;
        }
        const data = (await res.json()) as SummaryResponse;
        if (!cancelled) setRefs(data.items ?? []);
      } catch {
        if (!cancelled) {
          setError("Không tải được danh sách ảnh");
          setRefs([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ids]);

  // null (whole group) is expanded to "everything that exists" for display, so
  // the checkboxes start ticked.
  const effective = selected ?? refs?.map((r) => r.id) ?? [];
  const isOn = (id: string) => effective.includes(id);

  function toggle(id: string) {
    const next = isOn(id)
      ? effective.filter((x) => x !== id)
      : // Re-tick in the group's own order, not click order — that order is the
        // gallery slot order and the render follows it.
        (refs ?? []).map((r) => r.id).filter((x) => x === id || effective.includes(x));
    onChange(next);
  }

  const allOn = refs !== null && refs.length > 0 && effective.length === refs.length;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{group.name}</DialogTitle>
          <DialogDescription>
            Bỏ tick ảnh không muốn render. Thứ tự render theo thứ tự trong nhóm.
          </DialogDescription>
        </DialogHeader>

        {refs === null ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground tabular-nums">
                Đã chọn {effective.length}/{refs.length}
              </span>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onChange(allOn ? [] : null)}
                >
                  {allOn ? "Bỏ chọn hết" : "Chọn hết"}
                </Button>
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="-mx-1 max-h-[55vh] overflow-y-auto px-1">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {refs.map((ref) => {
                  const on = isOn(ref.id);
                  return (
                    <button
                      key={ref.id}
                      type="button"
                      onClick={() => toggle(ref.id)}
                      className={cn(
                        "group relative overflow-hidden rounded-md border text-left transition",
                        on
                          ? "border-blue-500/60 ring-1 ring-blue-500/40"
                          : "border-border opacity-50 hover:opacity-80"
                      )}
                    >
                      <div className="relative aspect-square bg-muted/30">
                        {ref.thumbUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={ref.thumbUrl}
                            alt={ref.name}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-muted-foreground">
                            <ImageIcon className="h-5 w-5" />
                          </div>
                        )}

                        <span
                          className={cn(
                            "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-white transition",
                            on
                              ? "border-blue-400 bg-blue-500"
                              : "border-white/40 bg-black/50"
                          )}
                        >
                          {on ? (
                            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={3}>
                              <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            <Plus className="h-3 w-3" />
                          )}
                        </span>
                      </div>
                      <div className="truncate p-1.5 text-[11px] font-medium">
                        {ref.name}
                      </div>
                    </button>
                  );
                })}
              </div>

              {refs.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nhóm này không còn ảnh nào.
                </p>
              )}
            </div>
          </>
        )}

        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={onClose}>
            Xong
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
