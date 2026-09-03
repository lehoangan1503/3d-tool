"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import JSZip from "jszip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Loader2, Download, Image as ImageIcon, Search, FolderPlus, Trash2, X, ChevronLeft, Pencil } from "lucide-react";
import type { ExtractorReference, ExtractorFrame, ExtractorReferenceGroup } from "@/types/extractor";
import { isCueFrame, isImageFrame } from "@/types/extractor";
import { useReferenceList } from "@/hooks/use-reference-list";

const PREVIEW_CANVAS = 2048;

function getFramesSummary(frames: ExtractorFrame[]) {
  const n = frames.filter(isCueFrame).length;
  return `${n} khung`;
}

function TemplateRow({
  ref: r,
  checked,
  onToggle,
  onDelete,
  isExporting,
}: {
  ref: ExtractorReference;
  checked: boolean;
  onToggle: () => void;
  onDelete?: (e: React.MouseEvent) => void;
  isExporting?: boolean;
}) {
  return (
    <div className="group/row flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
      <Checkbox checked={checked} onCheckedChange={onToggle} disabled={isExporting} />
      <div className="flex-shrink-0 w-20 h-20 rounded overflow-hidden bg-[#111827]">
        <img src={r.thumbUrl} alt={r.name} className="w-full h-full object-cover" draggable={false} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{r.name}</div>
        <div className="text-xs text-muted-foreground">
          {getFramesSummary(r.frames)}
          {r.createdByName && (
            <span className="ml-1.5 text-muted-foreground/60">· {r.createdByName}</span>
          )}
        </div>
      </div>
      {onDelete && (r.canEdit ?? r.isOwned) && (
        <button onClick={onDelete} className="opacity-0 group-hover/row:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1 rounded" title="Xóa mẫu">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// Picker row (compact — for New Group / Detail). Uses div+onClick instead of label
// to avoid browser scroll-to-focus behavior on checkbox click.
function PickerRow({ ref: r, checked, onToggle }: { ref: ExtractorReference; checked: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-2 p-1.5 rounded cursor-pointer hover:bg-muted/50" onClick={onToggle}>
      <div onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={onToggle} />
      </div>
      <div className="flex-shrink-0 w-10 h-10 rounded overflow-hidden bg-[#111827]">
        <img src={r.thumbUrl} alt={r.name} className="w-full h-full object-cover" draggable={false} />
      </div>
      <span className="text-sm truncate flex-1">{r.name}</span>
    </div>
  );
}

function LayoutPreviewSvg({ frames, size, canvasW = 2048, canvasH = 2048 }: { frames: ExtractorFrame[]; size: number; canvasW?: number; canvasH?: number }) {
  const aspect = canvasW / canvasH;
  const svgW = aspect >= 1 ? size : Math.round(size * aspect);
  const svgH = aspect <= 1 ? size : Math.round(size / aspect);
  return (
    <svg width={svgW} height={svgH} viewBox={`0 0 ${canvasW} ${canvasH}`} style={{ background: "#111827" }} className="rounded block flex-shrink-0">
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
            transform={frame.transform.rotation ? `rotate(${frame.transform.rotation},${cx},${cy})` : undefined}
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

export function DownloadMultipleDialog({ open, onOpenChange, productName, onRenderReference, onExportStart, onExportEnd }: DownloadMultipleDialogProps) {
  // ── Shared ───────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"references" | "groups">("references");
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, status: "" });
  const [error, setError] = useState<string | null>(null);

  // ── References tab ───────────────────────────────────────────────────────
  const [selectedRefIds, setSelectedRefIds] = useState<Set<string>>(new Set());
  // Track locally deleted refs so they disappear without a full reload
  const [deletedRefIds, setDeletedRefIds] = useState<Set<string>>(new Set());

  // ── Groups tab ───────────────────────────────────────────────────────────
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [groupSearch, setGroupSearch] = useState("");
  const [groups, setGroups] = useState<ExtractorReferenceGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);

  // New group creation (inline panel)
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupIds, setNewGroupIds] = useState<Set<string>>(new Set());
  const [newGroupSearch, setNewGroupSearch] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);

  // Group detail editing
  const [detailGroup, setDetailGroup] = useState<ExtractorReferenceGroup | null>(null);
  const [detailEditIds, setDetailEditIds] = useState<Set<string>>(new Set());
  const [detailSearch, setDetailSearch] = useState("");
  const [savingDetail, setSavingDetail] = useState(false);
  const [saveDetailStatus, setSaveDetailStatus] = useState<null | "success" | "error">(null);

  // Group list filter
  const [filterMyGroups, setFilterMyGroups] = useState(false);

  // References tab filter
  const [filterMyRefs, setFilterMyRefs] = useState(false);

  // ── Reference list hooks ─────────────────────────────────────────────────
  const { references: allRefs, total, isLoading, isFetchingMore, hasMore, search, setSearch, loadMore, reload: reloadRefs } = useReferenceList({ enabled: open });

  // Picker for New Group + Group Detail (enabled when either panel is open)
  const pickerEnabled = open && (showNewGroup || detailGroup !== null);
  const {
    references: pickerRefs,
    isLoading: pickerLoading,
    isFetchingMore: pickerFetchingMore,
    hasMore: pickerHasMore,
    search: pickerSearch,
    setSearch: setPickerSearch,
    loadMore: pickerLoadMore,
  } = useReferenceList({ enabled: pickerEnabled });

  // Visible references (after local deletions and optional owner filter)
  const references = allRefs.filter((r) => !deletedRefIds.has(r.id) && (!filterMyRefs || r.isOwned));

  // ── Auto-select on first load (References tab) ───────────────────────────
  useEffect(() => {
    if (references.length > 0 && selectedRefIds.size === 0 && !search && activeTab === "references") {
      setSelectedRefIds(new Set(references.map((r) => r.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRefs]);

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
      setSaveDetailStatus(null);
      setFilterMyGroups(false);
      setFilterMyRefs(false);
      setActiveTab("references");
    }
  }, [open]);

  // ── References tab handlers ───────────────────────────────────────────────
  const handleSelectAllRefs = () => setSelectedRefIds(new Set(references.map((r) => r.id)));
  const handleDeselectAllRefs = () => setSelectedRefIds(new Set());

  const handleToggleRef = (id: string) =>
    setSelectedRefIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const handleDeleteRef = async (e: React.MouseEvent, refId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Xóa mẫu này? Thao tác này không thể hoàn tác.")) return;
    try {
      const res = await fetch(`/api/extractor-references/${refId}`, { method: "DELETE" });
      if (res.ok) {
        setDeletedRefIds((prev) => new Set([...prev, refId]));
        setSelectedRefIds((prev) => {
          const n = new Set(prev);
          n.delete(refId);
          return n;
        });
      }
    } catch (err) {
      console.error("Failed to delete reference:", err);
    }
  };

  // ── Groups tab handlers ───────────────────────────────────────────────────
  const handleSelectAllGroups = () => setSelectedGroupIds(new Set(filteredGroups.map((g) => g.id)));
  const handleDeselectAllGroups = () => setSelectedGroupIds(new Set());

  const handleToggleGroup = (groupId: string) =>
    setSelectedGroupIds((prev) => {
      const n = new Set(prev);
      n.has(groupId) ? n.delete(groupId) : n.add(groupId);
      return n;
    });

  const handleDeleteGroup = async (e: React.MouseEvent, groupId: string) => {
    e.stopPropagation();
    if (!confirm("Xóa nhóm này? Các mẫu sẽ không bị xóa.")) return;
    try {
      await fetch(`/api/extractor-reference-groups/${groupId}`, { method: "DELETE" });
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
      setSelectedGroupIds((prev) => {
        const n = new Set(prev);
        n.delete(groupId);
        return n;
      });
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
    setSaveDetailStatus(null);
    try {
      const res = await fetch(`/api/extractor-reference-groups/${detailGroup.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceIds: Array.from(detailEditIds) }),
      });
      if (res.ok) {
        const updated = await res.json();
        // Trust the server's ownership/permission flags — an admin editing
        // someone else's group is not its owner.
        setGroups((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
        setDetailGroup(updated);
        setSaveDetailStatus("success");
      } else {
        setSaveDetailStatus("error");
      }
    } catch (err) {
      console.error("Failed to update group:", err);
      setSaveDetailStatus("error");
    } finally {
      setSavingDetail(false);
      setTimeout(() => setSaveDetailStatus(null), 3000);
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

        fetchedMissing.forEach((r) => {
          if (r) loadedMap.set(r.id, r);
        });
        refsToExport = allRefIds.map((id) => loadedMap.get(id)!).filter(Boolean);
      }

      if (refsToExport.length === 0) {
        setError("Không có gì để xuất.");
        setIsExporting(false);
        return;
      }

      await onExportStart?.();
      const zip = new JSZip();

      for (let i = 0; i < refsToExport.length; i++) {
        const ref = refsToExport[i];
        setExportProgress({ current: i + 1, total: refsToExport.length, status: `Đang render "${ref.name}"...` });
        const blob = await onRenderReference(ref);
        zip.file(`${ref.name.replace(/[^a-zA-Z0-9-_]/g, "-")}.png`, blob);
        if (i < refsToExport.length - 1) await new Promise((r) => setTimeout(r, 80));
      }

      setExportProgress({ current: refsToExport.length, total: refsToExport.length, status: "Đang tạo ZIP..." });
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const datePart = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;

      const safe = (s: string) => s.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "export";
      const safeProduct = safe(productName);

      let groupPart: string;
      if (activeTab === "groups") {
        const selectedGroups = groups.filter((g) => selectedGroupIds.has(g.id));
        groupPart =
          selectedGroups.length === 1
            ? safe(selectedGroups[0].name)
            : selectedGroups.length > 1
              ? `${safe(selectedGroups[0].name)}+${selectedGroups.length - 1}`
              : safeProduct;
      } else {
        groupPart = safeProduct;
      }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(zipBlob);
      link.download = `${safeProduct}_${groupPart}_${datePart}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      onOpenChange(false);
    } catch (err) {
      console.error("Export failed:", err);
      setError("Xuất thất bại. Vui lòng thử lại.");
    } finally {
      onExportEnd?.();
      setIsExporting(false);
      setExportProgress({ current: 0, total: 0, status: "" });
    }
  };

  // Filtered groups by search and optional owner filter
  const filteredGroups = groups.filter((g) => (!groupSearch || g.name.toLowerCase().includes(groupSearch.toLowerCase())) && (!filterMyGroups || g.isOwner));

  // Footer counters
  const footerLabel =
    activeTab === "references"
      ? `Đã chọn ${selectedRefIds.size} / ${filterMyRefs ? references.length : total} mẫu`
      : `Đã chọn ${selectedGroupIds.size} / ${filteredGroups.length} nhóm`;

  const exportDisabled = isExporting || isLoading || (activeTab === "references" ? selectedRefIds.size === 0 : selectedGroupIds.size === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col gap-0">
        <DialogHeader className="pb-3">
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Tải Xuống Nhiều Mẫu
          </DialogTitle>
          <DialogDescription>Chọn mẫu hoặc nhóm để xuất thành file ZIP.</DialogDescription>
        </DialogHeader>

        {/* ── Tab switcher (pill style) ─────────────────────────────────── */}
        <div className="flex gap-1 p-1 rounded-lg bg-muted mb-3">
          {(["references", "groups"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors capitalize ${
                activeTab === tab ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "references" ? "Mẫu" : "Nhóm"}
            </button>
          ))}
        </div>

        {/* ══ REFERENCES TAB ═══════════════════════════════════════════════ */}
        {activeTab === "references" && (
          <>
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Tìm kiếm mẫu..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
            </div>

            {isLoading && allRefs.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : allRefs.filter((r) => !deletedRefIds.has(r.id)).length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
                <ImageIcon className="h-10 w-10 text-muted-foreground/50 mb-2" />
                <p className="text-sm text-muted-foreground">Không tìm thấy mẫu nào đã lưu</p>
                <p className="text-xs text-muted-foreground/70 mt-1">Hãy lưu một bố cục trong Image Extractor trước</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 pb-2 border-b mb-1">
                  <Button variant="ghost" size="sm" onClick={handleSelectAllRefs}>
                    Chọn Tất Cả
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleDeselectAllRefs}>
                    Bỏ Chọn Tất Cả
                  </Button>
                  <div className="flex-1" />
                  <Button
                    variant={filterMyRefs ? "default" : "outline"}
                    size="sm"
                    className="shrink-0"
                    onClick={() => setFilterMyRefs((v) => !v)}
                  >
                    Mẫu Của Bạn
                  </Button>
                </div>

                {references.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
                    <ImageIcon className="h-10 w-10 text-muted-foreground/50 mb-2" />
                    <p className="text-sm text-muted-foreground">Không có mẫu nào của bạn</p>
                  </div>
                ) : (
                  <div
                    className="flex-1 overflow-y-auto space-y-0.5 py-1"
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      if (el.scrollHeight - el.scrollTop - el.clientHeight < 100 && hasMore && !isFetchingMore) loadMore();
                    }}
                  >
                    {references.map((ref) => (
                      <TemplateRow
                        key={ref.id}
                        ref={ref}
                        checked={selectedRefIds.has(ref.id)}
                        onToggle={() => handleToggleRef(ref.id)}
                        onDelete={(e) => handleDeleteRef(e, ref.id)}
                        isExporting={isExporting}
                      />
                    ))}
                    {isFetchingMore && (
                      <div className="py-2 flex justify-center">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                )}
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
                  <button onClick={() => setDetailGroup(null)} className="text-muted-foreground hover:text-foreground">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="font-medium text-sm truncate flex-1">{detailGroup.name}</span>
                  <span className="text-xs text-muted-foreground">{detailEditIds.size} mẫu</span>
                </div>

                {/* Search picker */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input placeholder="Tìm kiếm để thêm/xóa mẫu..." value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} className="pl-8 h-8 text-sm" />
                </div>

                {/* Template picker — checked = in group */}
                <div
                  className="flex-1 overflow-y-auto space-y-0.5"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 && pickerHasMore && !pickerFetchingMore) pickerLoadMore();
                  }}
                >
                  {pickerLoading && pickerRefs.length === 0 ? (
                    <div className="flex justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : pickerRefs.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-3">Không tìm thấy mẫu nào</p>
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

                <div className={`flex items-center justify-end gap-3  border-t ${(detailGroup.canEdit ?? detailGroup.isOwner) ? "py-2" : ""}`}>
                  {saveDetailStatus === "success" && <span className="text-xs text-green-500">Đã lưu thành công!</span>}
                  {saveDetailStatus === "error" && <span className="text-xs text-destructive">Lưu thất bại. Vui lòng thử lại.</span>}
                  {(detailGroup.canEdit ?? detailGroup.isOwner) && (
                    <Button size="sm" onClick={handleSaveGroupDetail} disabled={savingDetail}>
                      {savingDetail ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Lưu Thay Đổi"}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              /* ── GROUPS LIST ────────────────────────────────────────── */
              <>
                {/* Search + New Group */}
                <div className="flex gap-2 mb-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input placeholder="Tìm kiếm nhóm..." value={groupSearch} onChange={(e) => setGroupSearch(e.target.value)} className="pl-8" />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      setShowNewGroup(true);
                      setPickerSearch("");
                      setNewGroupIds(new Set());
                      setNewGroupName("");
                    }}
                  >
                    <FolderPlus className="h-4 w-4 mr-1.5" />
                    Nhóm Mới
                  </Button>
                </div>

                {/* New Group inline panel */}
                {showNewGroup && (
                  <div className="border rounded-lg p-3 space-y-2 bg-muted/30 mb-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Nhóm Mới</span>
                      <button onClick={() => setShowNewGroup(false)} className="text-muted-foreground hover:text-foreground">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <Input placeholder="Tên nhóm..." value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} className="h-8 text-sm" />
                    <div className="relative">
                      <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input placeholder="Tìm kiếm mẫu..." value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} className="pl-7 h-8 text-sm" />
                    </div>
                    <div
                      className="max-h-44 overflow-y-auto space-y-0.5"
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 && pickerHasMore && !pickerFetchingMore) pickerLoadMore();
                      }}
                    >
                      {pickerLoading && pickerRefs.length === 0 ? (
                        <div className="flex justify-center py-4">
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : pickerRefs.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-3">Không tìm thấy mẫu nào</p>
                      ) : (
                        pickerRefs.map((ref) => (
                          <PickerRow
                            key={ref.id}
                            ref={ref}
                            checked={newGroupIds.has(ref.id)}
                            onToggle={() =>
                              setNewGroupIds((prev) => {
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
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-xs text-muted-foreground">{newGroupIds.size} đã chọn</span>
                      <Button size="sm" disabled={savingGroup || !newGroupName.trim() || newGroupIds.size === 0} onClick={handleSaveNewGroup}>
                        {savingGroup ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Lưu Nhóm"}
                      </Button>
                    </div>
                  </div>
                )}

                {groupsLoading ? (
                  <div className="flex-1 flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : groups.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
                    <ImageIcon className="h-10 w-10 text-muted-foreground/50 mb-2" />
                    <p className="text-sm text-muted-foreground">Chưa có nhóm nào</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">Tạo nhóm để gộp các mẫu khi xuất</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 pb-2 border-b mb-1">
                      <Button variant="ghost" size="sm" onClick={handleSelectAllGroups}>
                        Chọn Tất Cả
                      </Button>
                      <Button variant="ghost" size="sm" onClick={handleDeselectAllGroups}>
                        Bỏ Chọn Tất Cả
                      </Button>
                      <div className="flex-1" />
                      <Button variant={filterMyGroups ? "default" : "outline"} size="sm" className="shrink-0" onClick={() => setFilterMyGroups((v) => !v)}>
                        Nhóm Của Bạn
                      </Button>
                    </div>

                    {filteredGroups.length === 0 ? (
                      <div className="flex-1 flex flex-col items-center justify-center py-8 text-center">
                        <ImageIcon className="h-10 w-10 text-muted-foreground/50 mb-2" />
                        <p className="text-sm text-muted-foreground">
                          {groupSearch ? "Không tìm thấy nhóm nào" : "Không có nhóm nào của bạn"}
                        </p>
                      </div>
                    ) : (
                      <div className="flex-1 overflow-y-auto space-y-0.5 py-1">
                        {filteredGroups.map((group) => (
                          <div key={group.id} className="group/row flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
                            <Checkbox checked={selectedGroupIds.has(group.id)} onCheckedChange={() => handleToggleGroup(group.id)} disabled={isExporting} />
                            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openGroupDetail(group)}>
                              <div className="font-medium text-sm truncate">{group.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {group.referenceIds.length} mẫu
                                {group.createdByName && (
                                  <span className="ml-1.5 text-muted-foreground/60">· {group.createdByName}</span>
                                )}
                              </div>
                            </div>
                            {(group.canEdit ?? group.isOwner) && (
                              <>
                                {/* Edit button */}
                                <button
                                  onClick={() => openGroupDetail(group)}
                                  className="opacity-0 group-hover/row:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded"
                                  title="Chỉnh sửa nhóm"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                {/* Delete button */}
                                <button
                                  onClick={(e) => handleDeleteGroup(e, group.id)}
                                  className="opacity-0 group-hover/row:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1 rounded"
                                  title="Xóa nhóm"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
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
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang xuất...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Xuất ({activeTab === "references" ? selectedRefIds.size : selectedGroupIds.size})
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
