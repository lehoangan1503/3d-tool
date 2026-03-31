"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import JSZip from "jszip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Loader2, Download, Image as ImageIcon, Search,
  FolderPlus, Trash2, X, ChevronLeft, Pencil,
} from "lucide-react";
import type { ExtractorReference, ExtractorFrame, ExtractorReferenceGroup } from "@/types/extractor";
import { isCueFrame, isImageFrame } from "@/types/extractor";
import { useReferenceList } from "@/hooks/use-reference-list";
import { renderPool } from "@/lib/render-pool";

const PREVIEW_CANVAS = 2048;

function LayoutPreviewSvg({ frames, size }: { frames: ExtractorFrame[]; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${PREVIEW_CANVAS} ${PREVIEW_CANVAS}`}
      style={{ background: "#111827" }}
      className="rounded block flex-shrink-0"
    >
      {frames.map((frame, i) => {
        const cx = frame.transform.x + frame.transform.width / 2;
        const cy = frame.transform.y + frame.transform.height / 2;
        const fill = isImageFrame(frame) ? "#f87171" : `hsl(${(i * 137) % 360}, 65%, 60%)`;
        return (
          <rect
            key={frame.id}
            x={frame.transform.x}
            y={frame.transform.y}
            width={frame.transform.width}
            height={frame.transform.height}
            fill={fill}
            opacity={0.85}
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={22}
            rx={36}
            transform={
              frame.transform.rotation
                ? `rotate(${frame.transform.rotation},${cx},${cy})`
                : undefined
            }
          />
        );
      })}
    </svg>
  );
}

interface DownloadMultipleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  onRenderReference: (reference: ExtractorReference) => Promise<Blob>;
  onExportStart?: () => Promise<void> | void;
  onExportEnd?: () => void;
}

export function DownloadMultipleDialog({
  open,
  onOpenChange,
  productName,
  onRenderReference,
  onExportStart,
  onExportEnd,
}: DownloadMultipleDialogProps) {
  // ── Shared ───────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab]       = useState<"references" | "groups">("references");
  const [isExporting, setIsExporting]   = useState(false);
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, status: "" });
  const [error, setError]               = useState<string | null>(null);

  // ── References tab ───────────────────────────────────────────────────────
  const [selectedRefIds, setSelectedRefIds] = useState<Set<string>>(new Set());
  // Track locally deleted refs so they disappear without a full reload
  const [deletedRefIds, setDeletedRefIds]   = useState<Set<string>>(new Set());

  // ── Groups tab ───────────────────────────────────────────────────────────
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [groupSearch, setGroupSearch]     = useState("");
  const [groups, setGroups]               = useState<ExtractorReferenceGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);

  // New group creation (inline panel)
  const [showNewGroup, setShowNewGroup]   = useState(false);
  const [newGroupName, setNewGroupName]   = useState("");
  const [newGroupIds, setNewGroupIds]     = useState<Set<string>>(new Set());
  const [newGroupSearch, setNewGroupSearch] = useState("");
  const [savingGroup, setSavingGroup]     = useState(false);

  // Group detail editing
  const [detailGroup, setDetailGroup]     = useState<ExtractorReferenceGroup | null>(null);
  const [detailEditIds, setDetailEditIds] = useState<Set<string>>(new Set());
  const [detailSearch, setDetailSearch]   = useState("");
  const [savingDetail, setSavingDetail]   = useState(false);

  // ── Thumbnails ───────────────────────────────────────────────────────────
  const thumbnailUrls    = useRef<Map<string, string>>(new Map());
  const [thumbnailVersion, setThumbnailVersion] = useState(0);
  const renderPoolRunning = useRef(false);

  // ── Reference list hooks ─────────────────────────────────────────────────
  const { references: allRefs, total, isLoading, isFetchingMore, hasMore,
          search, setSearch, loadMore, reload: reloadRefs } =
    useReferenceList({ enabled: open });

  // Picker for New Group + Group Detail (enabled when either panel is open)
  const pickerEnabled = open && (showNewGroup || detailGroup !== null);
  const { references: pickerRefs, isLoading: pickerLoading, isFetchingMore: pickerFetchingMore,
          hasMore: pickerHasMore, search: pickerSearch, setSearch: setPickerSearch,
          loadMore: pickerLoadMore } =
    useReferenceList({ enabled: pickerEnabled });

  // Visible references (after local deletions)
  const references = allRefs.filter((r) => !deletedRefIds.has(r.id));

  // ── Auto-select on first load (References tab) ───────────────────────────
  useEffect(() => {
    if (references.length > 0 && selectedRefIds.size === 0 && !search && activeTab === "references") {
      setSelectedRefIds(new Set(references.map((r) => r.id)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRefs]);

  // ── Render thumbnails (serial to protect GPU) ────────────────────────────
  const renderThumbnails = useCallback(
    (batch: ExtractorReference[]) => {
      if (batch.length === 0 || renderPoolRunning.current) return;
      const unrendered = batch.filter((r) => !thumbnailUrls.current.has(r.id));
      if (!unrendered.length) return;
      renderPoolRunning.current = true;
      renderPool(unrendered, onRenderReference, (idx, url) => {
        thumbnailUrls.current.set(unrendered[idx].id, url);
        setThumbnailVersion((v) => v + 1);
      }, 1).finally(() => {
        renderPoolRunning.current = false;
      });
    },
    [onRenderReference]
  );

  useEffect(() => { renderThumbnails(references); }, [allRefs, renderThumbnails]);
  useEffect(() => { renderThumbnails(pickerRefs); }, [pickerRefs, renderThumbnails]);

  // ── Load groups ───────────────────────────────────────────────────────────
  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const res = await fetch("/api/extractor-reference-groups");
      if (res.ok) setGroups((await res.json()).items);
    } catch (err) {
      console.error("Failed to load groups:", err);
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && activeTab === "groups") loadGroups();
  }, [open, activeTab, loadGroups]);

  // ── Reset on close ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      setSelectedRefIds(new Set());
      setSelectedGroupIds(new Set());
      setDeletedRefIds(new Set());
      setExportProgress({ current: 0, total: 0, status: "" });
      setError(null);
      setShowNewGroup(false);
      setNewGroupName("");
      setNewGroupIds(new Set());
      setNewGroupSearch("");
      setDetailGroup(null);
      setDetailEditIds(new Set());
      setDetailSearch("");
      setGroupSearch("");
      setActiveTab("references");
    }
  }, [open]);

  useEffect(() => {
    return () => {
      thumbnailUrls.current.forEach((url) => URL.revokeObjectURL(url));
      thumbnailUrls.current.clear();
    };
  }, []);

  // ── References tab handlers ───────────────────────────────────────────────
  const handleSelectAllRefs = () => setSelectedRefIds(new Set(references.map((r) => r.id)));
  const handleDeselectAllRefs = () => setSelectedRefIds(new Set());

  const handleToggleRef = (id: string) =>
    setSelectedRefIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const handleDeleteRef = async (e: React.MouseEvent, refId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this template? This cannot be undone.")) return;
    try {
      const res = await fetch(`/api/extractor-references/${refId}`, { method: "DELETE" });
      if (res.ok) {
        setDeletedRefIds((prev) => new Set([...prev, refId]));
        setSelectedRefIds((prev) => { const n = new Set(prev); n.delete(refId); return n; });
      }
    } catch (err) {
      console.error("Failed to delete reference:", err);
    }
  };

  // ── Groups tab handlers ───────────────────────────────────────────────────
  const handleSelectAllGroups = () => setSelectedGroupIds(new Set(filteredGroups.map((g) => g.id)));
  const handleDeselectAllGroups = () => setSelectedGroupIds(new Set());

  const handleToggleGroup = (groupId: string) =>
    setSelectedGroupIds((prev) => { const n = new Set(prev); n.has(groupId) ? n.delete(groupId) : n.add(groupId); return n; });

  const handleDeleteGroup = async (e: React.MouseEvent, groupId: string) => {
    e.stopPropagation();
    if (!confirm("Delete this group? Templates are not deleted.")) return;
    try {
      await fetch(`/api/extractor-reference-groups/${groupId}`, { method: "DELETE" });
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
      setSelectedGroupIds((prev) => { const n = new Set(prev); n.delete(groupId); return n; });
    } catch (err) {
      console.error("Failed to delete group:", err);
    }
  };

  const handleSaveNewGroup = async () => {
    if (!newGroupName.trim() || newGroupIds.size === 0) return;
    setSavingGroup(true);
    try {
      const res = await fetch("/api/extractor-reference-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName.trim(), referenceIds: Array.from(newGroupIds) }),
      });
      if (res.ok) {
        const newGroup = await res.json();
        setGroups((prev) => [newGroup, ...prev]);
        setShowNewGroup(false);
        setNewGroupName("");
        setNewGroupIds(new Set());
        setNewGroupSearch("");
      }
    } catch (err) {
      console.error("Failed to save group:", err);
    } finally {
      setSavingGroup(false);
    }
  };

  const openGroupDetail = (group: ExtractorReferenceGroup) => {
    setDetailGroup(group);
    setDetailEditIds(new Set(group.referenceIds));
    setDetailSearch("");
    setPickerSearch("");
  };

  const handleSaveGroupDetail = async () => {
    if (!detailGroup) return;
    setSavingDetail(true);
    try {
      const res = await fetch(`/api/extractor-reference-groups/${detailGroup.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceIds: Array.from(detailEditIds) }),
      });
      if (res.ok) {
        const updated = await res.json();
        setGroups((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
        setDetailGroup(updated);
      }
    } catch (err) {
      console.error("Failed to update group:", err);
    } finally {
      setSavingDetail(false);
    }
  };

  // ── Export ────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    setIsExporting(true);
    setError(null);

    try {
      let refsToExport: ExtractorReference[] = [];

      if (activeTab === "references") {
        refsToExport = references.filter((r) => selectedRefIds.has(r.id));
      } else {
        // Collect all referenceIds from selected groups
        const selectedGroups = groups.filter((g) => selectedGroupIds.has(g.id));
        const allRefIds = [...new Set(selectedGroups.flatMap((g) => g.referenceIds))];

        // Use already-loaded refs; fetch missing ones
        const loadedMap = new Map(allRefs.map((r) => [r.id, r]));
        const missing = allRefIds.filter((id) => !loadedMap.has(id));

        const fetchedMissing = await Promise.all(
          missing.map((id) =>
            fetch(`/api/extractor-references/${id}`)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        );

        fetchedMissing.forEach((r) => { if (r) loadedMap.set(r.id, r); });
        refsToExport = allRefIds.map((id) => loadedMap.get(id)!).filter(Boolean);
      }

      if (refsToExport.length === 0) {
        setError("Nothing to export.");
        setIsExporting(false);
        return;
      }

      await onExportStart?.();
      const zip = new JSZip();

      for (let i = 0; i < refsToExport.length; i++) {
        const ref = refsToExport[i];
        setExportProgress({ current: i + 1, total: refsToExport.length, status: `Rendering "${ref.name}"...` });
        const blob = await onRenderReference(ref);
        zip.file(`${ref.name.replace(/[^a-zA-Z0-9-_]/g, "-")}.png`, blob);
        if (i < refsToExport.length - 1) await new Promise((r) => setTimeout(r, 80));
      }

      setExportProgress({ current: refsToExport.length, total: refsToExport.length, status: "Creating ZIP..." });
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });

      const timestamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
      const safeName = productName.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "export";
      const link = document.createElement("a");
      link.href = URL.createObjectURL(zipBlob);
      link.download = `${safeName}-${timestamp}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      onOpenChange(false);
    } catch (err) {
      console.error("Export failed:", err);
      setError("Export failed. Please try again.");
    } finally {
      onExportEnd?.();
      setIsExporting(false);
      setExportProgress({ current: 0, total: 0, status: "" });
    }
  };

  const getFramesSummary = (frames: ExtractorFrame[]) => {
    const n = frames.filter(isCueFrame).length;
    return `${n} frame${n !== 1 ? "s" : ""}`;
  };

  // Filtered groups by search
  const filteredGroups = groups.filter(
    (g) => !groupSearch || g.name.toLowerCase().includes(groupSearch.toLowerCase())
  );

  // Footer counters
  const footerLabel =
    activeTab === "references"
      ? `${selectedRefIds.size} of ${total} templates selected`
      : `${selectedGroupIds.size} of ${filteredGroups.length} groups selected`;

  const exportDisabled =
    isExporting ||
    isLoading ||
    (activeTab === "references" ? selectedRefIds.size === 0 : selectedGroupIds.size === 0);

  void thumbnailVersion;

  // ── Reusable template row ─────────────────────────────────────────────────
  const TemplateRow = ({
    ref: r,
    checked,
    onToggle,
    onDelete,
    size = 20,
  }: {
    ref: ExtractorReference;
    checked: boolean;
    onToggle: () => void;
    onDelete?: (e: React.MouseEvent) => void;
    size?: number;
  }) => {
    const thumbUrl = thumbnailUrls.current.get(r.id);
    return (
      <div className="group/row flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
        <Checkbox checked={checked} onCheckedChange={onToggle} disabled={isExporting} />
        <div className="flex-shrink-0 w-20 h-20 rounded overflow-hidden bg-[#111827]">
          {thumbUrl
            ? <img src={thumbUrl} alt={r.name} className="w-full h-full object-contain" />
            : <LayoutPreviewSvg frames={r.frames} size={80} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{r.name}</div>
          <div className="text-xs text-muted-foreground">{getFramesSummary(r.frames)}</div>
        </div>
        {onDelete && (
          <button
            onClick={onDelete}
            className="opacity-0 group-hover/row:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1 rounded"
            title="Delete template"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

  // Picker row (compact — for New Group / Detail)
  const PickerRow = ({
    ref: r,
    checked,
    onToggle,
  }: {
    ref: ExtractorReference;
    checked: boolean;
    onToggle: () => void;
  }) => {
    const thumbUrl = thumbnailUrls.current.get(r.id);
    return (
      <label className="flex items-center gap-2 p-1.5 rounded cursor-pointer hover:bg-muted/50">
        <Checkbox checked={checked} onCheckedChange={onToggle} />
        <div className="flex-shrink-0 w-10 h-10 rounded overflow-hidden bg-[#111827]">
          {thumbUrl
            ? <img src={thumbUrl} alt={r.name} className="w-full h-full object-contain" />
            : <LayoutPreviewSvg frames={r.frames} size={40} />}
        </div>
        <span className="text-sm truncate flex-1">{r.name}</span>
      </label>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col gap-0">
        <DialogHeader className="pb-3">
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Download Multiple References
          </DialogTitle>
          <DialogDescription>
            Select references or groups to export as a ZIP file.
          </DialogDescription>
        </DialogHeader>

        {/* ── Tab switcher (pill style) ─────────────────────────────────── */}
        <div className="flex gap-1 p-1 rounded-lg bg-muted mb-3">
          {(["references", "groups"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors capitalize ${
                activeTab === tab
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* ══ REFERENCES TAB ═══════════════════════════════════════════════ */}
        {activeTab === "references" && (
          <>
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search templates..." value={search}
                onChange={(e) => setSearch(e.target.value)} className="pl-8" />
            </div>

            {isLoading && references.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : references.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
                <ImageIcon className="h-10 w-10 text-muted-foreground/50 mb-2" />
                <p className="text-sm text-muted-foreground">No saved references found</p>
                <p className="text-xs text-muted-foreground/70 mt-1">Save a layout in Image Extractor first</p>
              </div>
            ) : (
              <>
                <div className="flex gap-2 pb-2 border-b mb-1">
                  <Button variant="ghost" size="sm" onClick={handleSelectAllRefs}>Select All</Button>
                  <Button variant="ghost" size="sm" onClick={handleDeselectAllRefs}>Deselect All</Button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-0.5 py-1"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    if (el.scrollHeight - el.scrollTop - el.clientHeight < 100 && hasMore && !isFetchingMore)
                      loadMore();
                  }}
                >
                  {references.map((ref) => (
                    <TemplateRow
                      key={ref.id}
                      ref={ref}
                      checked={selectedRefIds.has(ref.id)}
                      onToggle={() => handleToggleRef(ref.id)}
                      onDelete={(e) => handleDeleteRef(e, ref.id)}
                    />
                  ))}
                  {isFetchingMore && (
                    <div className="py-2 flex justify-center">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* ══ GROUPS TAB ═══════════════════════════════════════════════════ */}
        {activeTab === "groups" && (
          <>
            {/* ── GROUP DETAIL VIEW ──────────────────────────────────── */}
            {detailGroup ? (
              <div className="flex flex-col flex-1 min-h-0 gap-2">
                {/* Header */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDetailGroup(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="font-medium text-sm truncate flex-1">{detailGroup.name}</span>
                  <span className="text-xs text-muted-foreground">{detailEditIds.size} templates</span>
                </div>

                {/* Search picker */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search to add/remove templates..."
                    value={pickerSearch}
                    onChange={(e) => setPickerSearch(e.target.value)}
                    className="pl-8 h-8 text-sm"
                  />
                </div>

                {/* Template picker — checked = in group */}
                <div className="flex-1 overflow-y-auto space-y-0.5"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 && pickerHasMore && !pickerFetchingMore)
                      pickerLoadMore();
                  }}
                >
                  {pickerLoading && pickerRefs.length === 0 ? (
                    <div className="flex justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : pickerRefs.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-3">No templates found</p>
                  ) : (
                    pickerRefs.map((ref) => (
                      <PickerRow
                        key={ref.id}
                        ref={ref}
                        checked={detailEditIds.has(ref.id)}
                        onToggle={() =>
                          setDetailEditIds((prev) => {
                            const n = new Set(prev);
                            n.has(ref.id) ? n.delete(ref.id) : n.add(ref.id);
                            return n;
                          })
                        }
                      />
                    ))
                  )}
                  {pickerFetchingMore && (
                    <div className="py-2 flex justify-center">
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>

                <div className="flex justify-end pt-1 border-t">
                  <Button size="sm" onClick={handleSaveGroupDetail} disabled={savingDetail}>
                    {savingDetail ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save Changes"}
                  </Button>
                </div>
              </div>
            ) : (
              /* ── GROUPS LIST ────────────────────────────────────────── */
              <>
                {/* Search + New Group */}
                <div className="flex gap-2 mb-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input placeholder="Search groups..." value={groupSearch}
                      onChange={(e) => setGroupSearch(e.target.value)} className="pl-8" />
                  </div>
                  <Button variant="outline" size="sm" className="shrink-0"
                    onClick={() => { setShowNewGroup(true); setPickerSearch(""); setNewGroupIds(new Set()); setNewGroupName(""); }}>
                    <FolderPlus className="h-4 w-4 mr-1.5" />
                    New Group
                  </Button>
                </div>

                {/* New Group inline panel */}
                {showNewGroup && (
                  <div className="border rounded-lg p-3 space-y-2 bg-muted/30 mb-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">New Group</span>
                      <button onClick={() => setShowNewGroup(false)} className="text-muted-foreground hover:text-foreground">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <Input placeholder="Group name..." value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)} className="h-8 text-sm" />
                    <div className="relative">
                      <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input placeholder="Search templates..." value={pickerSearch}
                        onChange={(e) => setPickerSearch(e.target.value)} className="pl-7 h-8 text-sm" />
                    </div>
                    <div className="max-h-44 overflow-y-auto space-y-0.5"
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 && pickerHasMore && !pickerFetchingMore)
                          pickerLoadMore();
                      }}
                    >
                      {pickerLoading && pickerRefs.length === 0 ? (
                        <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
                      ) : pickerRefs.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-3">No templates found</p>
                      ) : pickerRefs.map((ref) => (
                        <PickerRow key={ref.id} ref={ref}
                          checked={newGroupIds.has(ref.id)}
                          onToggle={() => setNewGroupIds((prev) => {
                            const n = new Set(prev); n.has(ref.id) ? n.delete(ref.id) : n.add(ref.id); return n;
                          })}
                        />
                      ))}
                      {pickerFetchingMore && <div className="py-2 flex justify-center"><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></div>}
                    </div>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-xs text-muted-foreground">{newGroupIds.size} selected</span>
                      <Button size="sm" disabled={savingGroup || !newGroupName.trim() || newGroupIds.size === 0} onClick={handleSaveNewGroup}>
                        {savingGroup ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save Group"}
                      </Button>
                    </div>
                  </div>
                )}

                {groupsLoading ? (
                  <div className="flex-1 flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredGroups.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
                    <ImageIcon className="h-10 w-10 text-muted-foreground/50 mb-2" />
                    <p className="text-sm text-muted-foreground">{groupSearch ? "No groups match" : "No groups yet"}</p>
                    {!groupSearch && <p className="text-xs text-muted-foreground/70 mt-1">Create a group to bundle templates for export</p>}
                  </div>
                ) : (
                  <>
                    <div className="flex gap-2 pb-2 border-b mb-1">
                      <Button variant="ghost" size="sm" onClick={handleSelectAllGroups}>Select All</Button>
                      <Button variant="ghost" size="sm" onClick={handleDeselectAllGroups}>Deselect All</Button>
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-0.5 py-1">
                      {filteredGroups.map((group) => (
                        <div key={group.id}
                          className="group/row flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50"
                        >
                          <Checkbox
                            checked={selectedGroupIds.has(group.id)}
                            onCheckedChange={() => handleToggleGroup(group.id)}
                            disabled={isExporting}
                          />
                          <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openGroupDetail(group)}>
                            <div className="font-medium text-sm truncate">{group.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {group.referenceIds.length} template{group.referenceIds.length !== 1 ? "s" : ""}
                            </div>
                          </div>
                          {/* Detail button */}
                          <button
                            onClick={() => openGroupDetail(group)}
                            className="opacity-0 group-hover/row:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded"
                            title="Edit group"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {/* Delete button */}
                          <button
                            onClick={(e) => handleDeleteGroup(e, group.id)}
                            className="opacity-0 group-hover/row:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1 rounded"
                            title="Delete group"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* Progress indicator */}
        {isExporting && (
          <div className="py-2 space-y-2 mt-2">
            <Progress value={(exportProgress.current / exportProgress.total) * 100} />
            <p className="text-xs text-muted-foreground text-center">
              {exportProgress.status} ({exportProgress.current}/{exportProgress.total})
            </p>
          </div>
        )}

        {error && <p className="text-sm text-destructive text-center py-2">{error}</p>}

        <DialogFooter className="border-t pt-4 mt-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground flex-1">{footerLabel}</span>
          <Button onClick={handleExport} disabled={exportDisabled} className="w-full sm:w-auto">
            {isExporting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Exporting...</>
            ) : (
              <><Download className="h-4 w-4 mr-2" />Export ({activeTab === "references" ? selectedRefIds.size : selectedGroupIds.size})</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
