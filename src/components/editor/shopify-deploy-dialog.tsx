"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  Sparkles,
  ShoppingBag,
  Loader2,
  Check,
  RefreshCw,
  Plus,
  Trash2,
  ExternalLink,
  Image as ImageIcon,
  Video,
  AlertCircle,
  XCircle,
  AlertTriangle,
  Save,
  GripVertical,
  Upload,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { Product, ShaftConfig, ShopifyDeploymentSummary, ShopifyCollection, ShopifySkill } from "@/types/product";
import type { ShopifyLiveCollection } from "@/app/api/shopify/collections/shopify/route";
import type { SceneManager } from "@/lib/three/scene-manager";
import type { ExtractorReference, ExtractorReferenceGroup } from "@/types/extractor";
import type { VideoStudioConfig } from "@/types/video-studio";
import { ensureFullConfig, computeVideoDuration, isCameraFixed } from "@/types/video-studio";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { renderReferenceToBlob } from "@/components/editor/image-extractor";
import { sortGalleryByName, isMetafieldImageName } from "@/lib/shopify/image-order";
import { uploadBlobToStorage } from "@/lib/supabase/upload";
import { StoreSwitcher, useStore } from "@/components/shopify/store-switcher";
import { createClient } from "@/lib/supabase/client";
import { parseProductTitle } from "@/lib/shopify/parse-title";
import { getProductCodeFormat, isValidProductCode } from "@/lib/shopify/product-code";
import { useDeployTemplates } from "@/components/shopify/use-deploy-templates";
import { PriceTablesEditor } from "@/components/shopify/price-tables-editor";
import { priceVariants } from "@/lib/shopify/pricing";
import { ShaftConfigEditor } from "@/components/editor/shaft-config-editor";
import { buildPreviewPose } from "@/lib/shopify/preview-pose";
import { createStudioFrameSink, BROWSER_SUPERSAMPLE } from "@/lib/video/webcodecs-frame-sink";

// ── Types ─────────────────────────────────────────────────────────────────────

interface VideoTemplateItem {
  id: string;
  name: string;
  config: VideoStudioConfig;
}

type Version = "Standard" | "Premium" | "Pro" | "Lux";
type WrapType = "wrap" | "wrapless";

interface RenderedImage {
  refId: string;
  refName: string;
  url: string; // object URL (freshly rendered) OR a saved storage URL on reopen
  // Freshly rendered images carry a blob to upload; images restored from a saved
  // deployment have no blob — their `url` is already a public storage URL.
  blob: Blob | null;
  /** True when this entry was restored from form_data (url is already hosted). */
  saved?: boolean;
  /** MIME type of the blob (rendered = image/png; user uploads keep their own). */
  mimeType?: string;
  /** True for user-uploaded images. These persist across a group re-render
   *  (only auto-rendered images are cleared/replaced when re-rendering). */
  uploaded?: boolean;
}

interface RenderedVideo {
  /** Stable id for drag-and-drop + React keys. */
  id: string;
  /** object URL (freshly rendered/uploaded) OR a saved storage URL on reopen. */
  url: string;
  /** Freshly rendered/uploaded videos carry a blob to upload; saved ones don't. */
  blob: Blob | null;
  /** Human label shown on the tile (template name / file name). */
  label: string;
  /** True when restored from form_data (url already hosted). */
  saved?: boolean;
  /** MIME type of the blob (rendered = video/mp4; uploads keep their own). */
  mimeType?: string;
}

interface ContentResult {
  title: string;
  description: string;
  viTitle: string;
  viDescription: string;
  tags: string[];
}

interface DeployResult {
  productId: number;
  adminUrl: string;
  storefrontUrl: string;
  title: string;
  isUpdate?: boolean;
  /** Display name of the store this was deployed to. */
  storeName?: string | null;
}

interface Props {
  product: Product;
  sceneManager: SceneManager | null;
  /**
   * The product's engraved logo id (`ProductConfig.logoId`), from the editor's
   * live config.
   *
   * The cue model itself already carries the right mark (it is cloned from the
   * editor's SceneManager), but a studio snapshot's logo BACKDROP plate set to
   * "auto" resolves against the ExtractorSceneManager's own productLogoId —
   * and cueLogoPath(null) silently falls back to "uni". Without this the
   * deployed images and video showed a Uni plate beside a correctly engraved
   * cue. Same reason VideoStudio takes a productLogoId prop.
   */
  productLogoId?: string | null;
  deployment?: ShopifyDeploymentSummary | null;
  canDelete?: boolean;
  // Lets the parent (editor) update its badge / button / header links live,
  // without a page reload, after a deploy or delete.
  onDeploymentChange?: (deployment: ShopifyDeploymentSummary | null) => void;
  onClose: () => void;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-white/70 uppercase tracking-widest">{title}</h3>
      {children}
    </div>
  );
}

function Divider() {
  return <div className="border-t border-white/10" />;
}

/** Small circular badge showing the final deploy position of a media item. */
function OrderBadge({ position, color = "blue" }: { position: number; color?: "blue" | "purple" }) {
  const cls = color === "purple" ? "bg-purple-500" : "bg-blue-500";
  return (
    <div className={`absolute top-1 left-1 z-10 flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white shadow ${cls}`}>
      {position}
    </div>
  );
}

/**
 * One draggable rendered/uploaded image tile with an order badge (final deploy
 * position), a drag handle, and hover actions to replace or remove it.
 * `position` is the 1-based slot this image will occupy in the Shopify gallery.
 */
function SortableImageTile({
  id,
  refName,
  url,
  position,
  expanded,
  onReplace,
  onRemove,
}: {
  id: string;
  refName: string;
  url: string;
  position: number | null;
  expanded: boolean;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-lg overflow-hidden border border-blue-500/40 bg-white/5 ${expanded ? "aspect-[2/3]" : "aspect-square w-20 shrink-0"} ${isDragging ? "opacity-50 z-20 shadow-lg" : ""}`}
    >
      {position !== null && <OrderBadge position={position} />}
      <img src={url} alt={refName} className="w-full h-full object-cover pointer-events-none" />
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
        <p className="text-[10px] text-white/70 truncate">{refName}</p>
      </div>
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        title="Kéo để đổi thứ tự"
        className="absolute top-1 right-1 z-10 flex h-5 w-5 items-center justify-center rounded bg-black/50 text-white/80 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
      >
        <GripVertical className="h-3 w-3" />
      </button>
      {/* Hover actions */}
      <div className="absolute inset-x-0 bottom-0 top-7 flex items-center justify-center gap-1.5 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onReplace}
          title="Thay ảnh (giữ nguyên tên)"
          className="flex h-7 w-7 items-center justify-center rounded-md bg-white/15 text-white hover:bg-white/30"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onRemove} title="Xóa ảnh" className="flex h-7 w-7 items-center justify-center rounded-md bg-red-500/70 text-white hover:bg-red-500">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * One draggable video tile. Videos always occupy the block right after the first
 * image, so `position` is 2,3,... Dragging reorders videos among themselves only.
 */
function SortableVideoTile({
  id,
  label,
  url,
  position,
  expanded,
  onRemove,
}: {
  id: string;
  label: string;
  url: string;
  position: number | null;
  expanded: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-lg overflow-hidden border border-purple-500/50 bg-black ${expanded ? "aspect-[2/3]" : "aspect-square w-20 shrink-0"} ${isDragging ? "opacity-50 z-20 shadow-lg" : ""}`}
    >
      {position !== null && <OrderBadge position={position} color="purple" />}
      <video src={url} muted playsInline className="w-full h-full object-cover pointer-events-none" />
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <Video className="h-5 w-5 text-white/70 drop-shadow" />
      </div>
      <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5">
        <p className="text-[10px] text-purple-200/90 truncate">{label}</p>
      </div>
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        title="Kéo để đổi thứ tự video"
        className="absolute top-1 right-1 z-10 flex h-5 w-5 items-center justify-center rounded bg-black/50 text-white/80 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
      >
        <GripVertical className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        title="Xóa video"
        className="absolute bottom-1 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-red-500/70 text-white opacity-0 group-hover:opacity-100 hover:bg-red-500 transition-opacity"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function ToggleBtn({ active, onClick, children, color = "green" }: { active: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  const colors: Record<string, string> = {
    green: "bg-green-600 border-green-500",
    blue: "bg-blue-600 border-blue-500",
    purple: "bg-purple-600 border-purple-500",
    orange: "bg-orange-600 border-orange-500",
    teal: "bg-teal-600 border-teal-500",
  };
  const active_cls = colors[color] ?? colors.green;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border transition-colors ${
        active ? `${active_cls} text-white` : "bg-white/5 border-white/20 text-white/60 hover:border-white/40"
      }`}
    >
      {active ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

// ── Skill create/edit modal ─────────────────────────────────────────────────
function SkillModal({ skill, onClose, onSaved, onDeleted }: { skill: ShopifySkill | null; onClose: () => void; onSaved: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(skill?.name ?? "");
  const [promptText, setPromptText] = useState(skill?.prompt_text ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!name.trim() || !promptText.trim()) {
      setError("Tên và nội dung skill là bắt buộc.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/shopify/skills", {
        method: skill ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: skill?.id, name: name.trim(), promptText: promptText.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Lưu skill thất bại");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!skill) return;
    if (!confirm(`Xóa skill “${skill.name}”?`)) return;
    setDeleting(true);
    setError("");
    try {
      const res = await fetch("/api/shopify/skills", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: skill.id }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Xóa skill thất bại");
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-white/10 bg-zinc-900 shadow-xl flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3 shrink-0">
          <h2 className="text-sm font-semibold text-white">{skill ? "Sửa Skill" : "Skill mới"}</h2>
          <button type="button" onClick={onClose} className="text-white/50 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <Label className="text-white/70 text-xs mb-1 block">
              Tên skill <span className="text-red-400">*</span>
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="VD: Copywriter carbon fiber cue"
              className="bg-white/5 border-white/20 text-white placeholder:text-white/30"
            />
          </div>
          <div>
            <Label className="text-white/70 text-xs mb-1 block">
              Nội dung prompt <span className="text-red-400">*</span>
            </Label>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="Dán nội dung prompt đầy đủ cho skill này..."
              rows={14}
              className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono"
            />
          </div>
          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-white/10 px-5 py-3 shrink-0">
          {skill ? (
            <Button variant="outline" onClick={handleDelete} disabled={deleting || saving} className="gap-2 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300">
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Xóa
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="border-white/20 text-white/70 hover:text-white">
              Hủy
            </Button>
            <Button onClick={handleSave} disabled={saving || deleting} className="gap-2 bg-green-600 hover:bg-green-700 text-white">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Lưu
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ShopifyDeployDialog({ product, sceneManager, productLogoId, deployment: initialDeployment = null, canDelete = false, onDeploymentChange, onClose }: Props) {
  const { storeId, stores, codeFormat } = useStore();
  const activeStoreName = stores.find((s) => s.id === storeId)?.name ?? null;
  const codeFormatDef = getProductCodeFormat(codeFormat);
  // The deployment shown reflects the CURRENTLY-SELECTED store. Starts from the
  // server-provided default-store row, then re-fetched whenever the store changes.
  const [deployment, setDeployment] = useState<ShopifyDeploymentSummary | null>(initialDeployment);
  const prefill = deployment?.form_data ?? null;
  // "Connected" = a live Shopify product exists on the selected store. A row may
  // persist after delete (keeps form_data) with a null id — that's NOT connected.
  const isConnected = Boolean(deployment?.shopify_product_id);
  const [connected, setConnected] = useState(isConnected);
  const isUpdateMode = connected;

  // When the selected store changes, load THIS product's deployment on that store
  // (or null → shows as not deployed for this store).
  useEffect(() => {
    if (!storeId) return;
    let active = true;
    fetch(`/api/shopify/deployment?productId=${product.id}&storeId=${encodeURIComponent(storeId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!active) return;
        const dep = (json?.deployment ?? null) as ShopifyDeploymentSummary | null;
        setDeployment(dep);
        setConnected(Boolean(dep?.shopify_product_id));
        // Restore what THIS store's last deploy used — price table, mockup image
        // group, video template — so switching stores shows that store's own
        // setup instead of the previously-viewed store's.
        const storeTemplateId = dep?.deploy_template_id ?? dep?.form_data?.deployTemplateId ?? null;
        if (storeTemplateId) setDeployTemplateId(storeTemplateId);
        if (dep?.image_group_id) setSelectedGroupId(dep.image_group_id);
        if (dep?.video_template_id) setSelectedTemplateId(dep.video_template_id);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [storeId, product.id]);
  // ── Data lists ──
  const [groups, setGroups] = useState<ExtractorReferenceGroup[]>([]);
  const [templates, setTemplates] = useState<VideoTemplateItem[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingTemplates, setLoadingTemplates] = useState(true);

  // ── Price template ──
  // A named price table (Global / Uni / Novera / ...). Picking one prices this
  // deploy, which is what lets one store carry several brands at several prices.
  const [deployTemplateId, setDeployTemplateId] = useState<string>(
    () => deployment?.deploy_template_id ?? prefill?.deployTemplateId ?? "",
  );
  const {
    templates: priceTemplates,
    template: priceTemplate,
    pricing: activePricing,
    loading: loadingPriceTemplates,
    canEdit: canEditPriceTables,
    reload: reloadPriceTables,
  } = useDeployTemplates(deployTemplateId || null);
  // Admin-only inline editor, so prices can be fixed without leaving the deploy.
  const [priceEditorOpen, setPriceEditorOpen] = useState(false);

  // ── Selection ──
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [groupRefs, setGroupRefs] = useState<ExtractorReference[]>([]);
  const [loadingRefs, setLoadingRefs] = useState(false);

  // ── Render pipeline ──
  // Restore previously-deployed images from the saved form snapshot so a
  // connected product re-opens with its gallery visible (no re-render needed).
  const [renderedImages, setRenderedImages] = useState<RenderedImage[]>(() => {
    const urls = prefill?.imageUrls ?? [];
    const names = prefill?.imageNames ?? [];
    return urls.map((url, i) => ({
      refId: `saved-${i}`,
      refName: names[i] ?? `image-${i + 1}`,
      url,
      blob: null,
      saved: true,
    }));
  });
  const [renderingImages, setRenderingImages] = useState(false);
  const [imageGridExpanded, setImageGridExpanded] = useState(false);
  const [imageProgress, setImageProgress] = useState({ done: 0, total: 0 });
  // Ordered list of videos to deploy (rendered from templates + user uploads).
  // Restored from the saved snapshot so reopening previews them; videoUrls[] is
  // the current field, with a fallback to the legacy single videoUrl.
  const [renderedVideos, setRenderedVideos] = useState<RenderedVideo[]>(() => {
    const urls = prefill?.videoUrls?.length ? prefill.videoUrls : prefill?.videoUrl ? [prefill.videoUrl] : [];
    return urls.filter(Boolean).map((url, i) => ({
      id: `saved-video-${i}`,
      url,
      blob: null,
      label: `Video ${i + 1}`,
      saved: true,
    }));
  });
  const [renderingVideo, setRenderingVideo] = useState(false);
  const [videoProgressPct, setVideoProgressPct] = useState(0);
  const [videoProgressLabel, setVideoProgressLabel] = useState("");
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const cancelVideoRef = useRef(false);
  const activeEsmRef = useRef<ExtractorSceneManager | null>(null);
  const renderedImageUrlsRef = useRef<string[]>([]);
  // Object URLs created for rendered/uploaded videos — revoked on unmount.
  const renderedVideoUrlsRef = useRef<string[]>([]);
  // Hidden picker for uploading user videos.
  const videoUploadInputRef = useRef<HTMLInputElement | null>(null);
  // Hidden picker for bulk-uploading user images (added as gallery images).
  const imageUploadInputRef = useRef<HTMLInputElement | null>(null);
  // dnd sensors (pointer w/ small activation distance, keyboard for a11y).
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // ── Manual image editing (replace one / add new) ──
  // Replacing: holds the refId being replaced; the hidden picker keeps the name.
  const replaceTargetRef = useRef<string | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  // Adding: a small dialog collects a file + a name matching our naming scheme.
  const [addImageOpen, setAddImageOpen] = useState(false);
  const [addImageName, setAddImageName] = useState("");
  const [addImageFile, setAddImageFile] = useState<File | null>(null);
  const [addImageError, setAddImageError] = useState("");

  // ── Product config (prefilled from a saved deployment when present) ──
  const [productCode, setProductCode] = useState(prefill?.productCode ?? "");
  const [versions, setVersions] = useState<Version[]>(prefill?.versions ?? ["Standard", "Premium"]);
  // No default — the editor must pick wrap or wrapless.
  const [wrapType, setWrapType] = useState<WrapType | "">(prefill?.wrapType ?? "");
  const [laserShaft, setLaserShaft] = useState(prefill?.laserShaft ?? true);
  const [shaftConfigOpen, setShaftConfigOpen] = useState(false);
  const [shaftConfig, setShaftConfig] = useState<ShaftConfig | null>(prefill?.shaftConfig ?? product.shaft_config ?? null);
  const [customImage, setCustomImage] = useState(prefill?.customImage ?? false);
  // Custom text has two mutually-exclusive modes: "free" and "paid" (+$20).
  const [customTextMode, setCustomTextMode] = useState<"none" | "free" | "paid">(prefill?.customTextPaid ? "paid" : prefill?.customText ? "free" : "none");
  const [customTextLabel, setCustomTextLabel] = useState(prefill?.customTextPaid?.label ?? prefill?.customText?.label ?? "");
  const [customTextExample, setCustomTextExample] = useState(prefill?.customTextPaid?.example ?? prefill?.customText?.example ?? "");
  // Extra freeform tags the editor adds (e.g. for testing). Not persisted to a
  // collection DB — just written onto the Shopify product alongside auto tags.
  const [manualTags, setManualTags] = useState<string[]>(prefill?.manualTags ?? []);
  const [manualTagInput, setManualTagInput] = useState("");

  // ── Content ──
  const [aiHint, setAiHint] = useState(prefill?.aiHint ?? "");
  const [aiModel, setAiModel] = useState(prefill?.aiModel || "gpt-5.4-mini");
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>([]);
  // ── AI skills (reusable prompt templates) ──
  const [skills, setSkills] = useState<ShopifySkill[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>(prefill?.skillIds ?? []);
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<ShopifySkill | null>(null);
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [description, setDescription] = useState(prefill?.description ?? "");
  const [descExpanded, setDescExpanded] = useState(false);
  // Collections is now a managed list of chips (persisted to DB for re-use).
  const [collectionList, setCollectionList] = useState<string[]>(prefill?.collections ?? []);
  // The single collection (one of collectionList) shown in the storefront
  // breadcrumb. null = not picked → warning shown, no metafield written.
  const [breadcrumbCollection, setBreadcrumbCollection] = useState<string | null>(prefill?.breadcrumbCollection ?? null);
  const [savedCollections, setSavedCollections] = useState<ShopifyCollection[]>([]);
  // Live collections pulled straight from the Shopify store (custom + smart).
  const [shopifyCollections, setShopifyCollections] = useState<ShopifyLiveCollection[]>([]);
  const [loadingShopifyCollections, setLoadingShopifyCollections] = useState(false);
  const [collectionInput, setCollectionInput] = useState("");
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(false);
  const [generatingContent, setGeneratingContent] = useState(false);
  const [contentGenerated, setContentGenerated] = useState(false);
  const [genWarn, setGenWarn] = useState("");
  const [genWarnType, setGenWarnType] = useState<"trying" | "warn" | "error">("warn");

  // ── Upload + Deploy ──
  const [uploadingAssets, setUploadingAssets] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [deployError, setDeployError] = useState("");
  const [deleting, setDeleting] = useState(false);
  // ── Save draft (persist form_data without touching Shopify) ──
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  // ── Close confirmation (draft has unsaved work) ──
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  // ── Load available AI models ──
  useEffect(() => {
    fetch("/api/shopify/generate-content")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.models?.length) {
          setAvailableModels(data.models);
          // If current model isn't in the list, reset to first available
          setAiModel((cur) => (data.models.find((m: { id: string }) => m.id === cur) ? cur : data.models[0].id));
        }
      });
  }, []);

  // ── Load saved collections (for the picker) ──
  useEffect(() => {
    fetch("/api/shopify/collections")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.items) setSavedCollections(data.items as ShopifyCollection[]);
      });
  }, []);

  // ── Load live collections from the selected Shopify store (custom + smart) ──
  useEffect(() => {
    setLoadingShopifyCollections(true);
    const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
    fetch(`/api/shopify/collections/shopify${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.items) setShopifyCollections(data.items as ShopifyLiveCollection[]);
      })
      .finally(() => setLoadingShopifyCollections(false));
  }, [storeId]);

  // ── Load AI skills ──
  const loadSkills = useCallback(() => {
    fetch("/api/shopify/skills")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.items) return;
        const items = data.items as ShopifySkill[];
        setSkills(items);
        // Drop any prefilled/selected ids that no longer exist.
        const valid = new Set(items.map((s) => s.id));
        setSelectedSkillIds((prev) => prev.filter((id) => valid.has(id)));
      });
  }, []);
  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  // ── Auto-parse "<code> - [theme]" from the product name using the active
  // store's code format (nXX-YY or WA1). Re-runs when the store's format
  // resolves so the code is parsed with the right pattern — important because
  // codeFormat starts as the default until the store list loads async, which
  // would otherwise leave the code (and its auto-tag) empty for Wow cue.
  //
  // The code is back-filled whenever the field is empty (even with a prefill,
  // since an old draft saved before the right format resolved may have an empty
  // code). The theme only seeds the AI hint when it isn't already set, and is
  // never auto-set from a prefilled draft. ──
  useEffect(() => {
    const { code, theme } = parseProductTitle(product.name, codeFormat);
    if (code) setProductCode((cur) => cur.trim() || code);
    if (theme && !prefill) setAiHint((cur) => cur || theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeFormat]);

  // ── Load groups ──
  useEffect(() => {
    fetch("/api/extractor-reference-groups")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setGroups(data.items ?? []);
      })
      .finally(() => setLoadingGroups(false));
  }, []);

  // ── Load templates ──
  useEffect(() => {
    fetch("/api/video-studio-templates?limit=100")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setTemplates(data.items ?? []);
      })
      .finally(() => setLoadingTemplates(false));
  }, []);

  // ── Load full refs for selected group ──
  useEffect(() => {
    if (!selectedGroupId) {
      setGroupRefs([]);
      return;
    }
    const group = groups.find((g) => g.id === selectedGroupId);
    if (!group?.referenceIds?.length) {
      setGroupRefs([]);
      return;
    }

    setLoadingRefs(true);
    Promise.all(group.referenceIds.map((id) => fetch(`/api/extractor-references/${id}`).then((r) => (r.ok ? (r.json() as Promise<ExtractorReference>) : null))))
      .then((results) => setGroupRefs(results.filter(Boolean) as ExtractorReference[]))
      .finally(() => setLoadingRefs(false));
  }, [selectedGroupId, groups]);

  // Cleanup rendered image/video object URLs on unmount
  useEffect(() => {
    return () => {
      renderedImageUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      renderedVideoUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Put a rendered set into final deploy order: gallery images sorted by NAME
  // (Mockup-Web-1 → 2 → 3 …, version images per slot), then user uploads, then
  // the metafield images (Details-* / Package-*) last. That last-place ordering
  // mirrors the server, which appends metafield images after the gallery and
  // then moves them off it — so array index still lines up with imageNames[].
  const orderForGallery = useCallback(
    (rendered: RenderedImage[], uploads: RenderedImage[]): RenderedImage[] => {
      const { gallery, metafield } = sortGalleryByName(rendered, (ri) => ri.refName, versions);
      return [...gallery, ...uploads, ...metafield];
    },
    [versions],
  );

  // ── Render images ──
  const handleRenderImages = useCallback(async () => {
    if (!sceneManager || !groupRefs.length) return;

    // Preserve user uploads across a re-render — only the previously auto-rendered
    // images are cleared/replaced. Uploaded images keep their spot after the
    // rendered set (the user can drag them anywhere afterwards).
    const preservedUploads = renderedImages.filter((ri) => ri.uploaded);
    // Revoke object URLs of the OLD rendered images only (not the kept uploads).
    const uploadUrls = new Set(preservedUploads.map((ri) => ri.url));
    renderedImageUrlsRef.current = renderedImageUrlsRef.current.filter((u) => {
      if (uploadUrls.has(u)) return true;
      URL.revokeObjectURL(u);
      return false;
    });
    setRenderedImages(preservedUploads);
    setRenderingImages(true);
    setImageProgress({ done: 0, total: groupRefs.length });

    const model = sceneManager.getModelForClone();
    if (!model) {
      alert("Scene model not ready. Please wait for the 3D model to load.");
      setRenderingImages(false);
      return;
    }

    const results: RenderedImage[] = [];
    for (let i = 0; i < groupRefs.length; i++) {
      const ref = groupRefs[i];
      try {
        const blob = await renderReferenceToBlob(
          model,
          ref,
          undefined,
          product.surface_url,
          productLogoId ?? null,
        );
        const url = URL.createObjectURL(blob);
        renderedImageUrlsRef.current.push(url);
        results.push({ refId: ref.id, refName: ref.name, url, blob });
        // Sort by NAME into final gallery order (Mockup-Web-1 → 2 → 3 …) rather
        // than the reference group's arbitrary order, and drop Details-*/
        // Package-* out of the gallery grid — they go to metafields. Uploads
        // keep their spot after the rendered set.
        setRenderedImages(orderForGallery(results, preservedUploads));
        setImageProgress({ done: i + 1, total: groupRefs.length });
      } catch (err) {
        console.error(`[ShopifyDeploy] Failed to render ref ${ref.name}:`, err);
        setImageProgress({ done: i + 1, total: groupRefs.length });
      }
    }
    setRenderingImages(false);
  }, [sceneManager, groupRefs, renderedImages, product.surface_url, productLogoId, orderForGallery]);

  // ── Render video ──
  const handleRenderVideo = useCallback(async () => {
    if (!sceneManager || !selectedTemplateId) return;

    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template?.config) {
      alert("Template config not found.");
      return;
    }

    setRenderingVideo(true);
    setVideoProgressPct(0);
    setVideoProgressLabel("");
    cancelVideoRef.current = false;

    const model = sceneManager.getModelForClone();
    if (!model) {
      alert("Scene model not ready.");
      setRenderingVideo(false);
      return;
    }

    // Wait one frame for React to commit the canvas container to the DOM
    // (canvasContainerRef must be mounted before we append the ESM canvas)
    await new Promise<void>((r) => setTimeout(r, 50));

    const config = ensureFullConfig(template.config);
    const totalDuration = computeVideoDuration(
      config.cameraStart,
      config.cameraEnd,
      config.cameraSpeed,
      "xyz",
      isCameraFixed(config.cameraStart, config.cameraEnd, config.cameraPath) ? config.fixedCameraDuration : undefined,
      config.cameraPath
    );
    const fmt = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

    const esm = new ExtractorSceneManager(1920, 1080);
    activeEsmRef.current = esm;

    // Mount canvas into the VISIBLE container — Chrome throttles rAF for
    // off-screen / visibility:hidden canvases causing choppy recording.
    const canvas = esm.getCanvas();
    canvas.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;";
    if (canvasContainerRef.current) {
      canvasContainerRef.current.innerHTML = "";
      canvasContainerRef.current.appendChild(canvas);
    }

    try {
      esm.setModel(model);
      // Must precede startStudioRecording, which applies the config and
      // resolves an "auto" logo plate against this value.
      esm.setProductLogoId(productLogoId ?? null);

      let lastProgressMs = 0;
      const sink = await createStudioFrameSink(config);
      const blob = await esm.startStudioRecording(config, (progressPct) => {
        if (cancelVideoRef.current) {
          esm.stopRecording();
          return;
        }
        const now = performance.now();
        if (progressPct >= 100 || now - lastProgressMs >= 100) {
          lastProgressMs = now;
          const elapsed = (progressPct / 100) * totalDuration;
          setVideoProgressPct(Math.round(progressPct));
          setVideoProgressLabel(`${fmt(elapsed)} / ${fmt(totalDuration)} (${Math.round(progressPct)}%)`);
        }
      }, sink, BROWSER_SUPERSAMPLE);

      if (!cancelVideoRef.current) {
        const url = URL.createObjectURL(blob);
        renderedVideoUrlsRef.current.push(url);
        // Append the freshly rendered video to the ordered list (keeps existing
        // videos + uploads). It joins the "after image #1" block.
        setRenderedVideos((prev) => [
          ...prev,
          { id: `render-${prev.length}-${selectedTemplateId}`, url, blob, label: template.name || `Video ${prev.length + 1}` },
        ]);
      }
    } catch (err) {
      if (!cancelVideoRef.current) {
        console.error("[ShopifyDeploy] Video render failed:", err);
        alert("Video render failed: " + (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      activeEsmRef.current = null;
      esm.dispose();
      if (canvasContainerRef.current) canvasContainerRef.current.innerHTML = "";
      setRenderingVideo(false);
    }
  }, [sceneManager, selectedTemplateId, templates, productLogoId]);

  // Selected skill texts (in pick order) → sent as a SYSTEM prompt for strict
  // adherence. The AI Hint stays separate as the theme direction.
  const composeSkillPrompt = useCallback(() => {
    return selectedSkillIds
      .map((id) => skills.find((s) => s.id === id)?.prompt_text?.trim())
      .filter(Boolean)
      .join("\n\n");
  }, [selectedSkillIds, skills]);

  // Only one skill at a time — picking another replaces the selection.
  const toggleSkill = useCallback((id: string) => {
    setSelectedSkillIds((prev) => (prev[0] === id ? [] : [id]));
  }, []);

  // ── Generate AI content ──
  const handleGenerateContent = useCallback(async () => {
    if (!renderedImages.length) {
      setGenWarnType("warn");
      setGenWarn("Hãy render ảnh mockup trước để AI phân tích ảnh sản phẩm.");
      return;
    }
    // A skill is the system prompt — require one before generating.
    if (selectedSkillIds.length === 0) {
      setGenWarnType("warn");
      setGenWarn("Hãy chọn 1 Skill trước khi tạo nội dung AI.");
      return;
    }
    setGenWarn("");
    setGeneratingContent(true);
    try {
      // Freshly rendered images carry a blob; restored ones only have a hosted
      // URL — fetch it back into a blob so the AI vision call still works.
      const first = renderedImages[0];
      const firstBlob: Blob = first.blob ?? (await fetch(first.url).then((r) => r.blob()));
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((res, rej) => {
        reader.onload = () => res(reader.result as string);
        reader.onerror = rej;
        reader.readAsDataURL(firstBlob);
      });

      const skillPrompt = composeSkillPrompt();
      const res = await fetch("/api/shopify/generate-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: dataUrl,
          hint: aiHint.trim() || undefined,
          skillPrompt: skillPrompt || undefined,
          model: aiModel,
          // Picked product version(s) — silently steered into the prompt head
          // so the AI writes content "based on the version" (Dựa trên version gậy).
          versions: versions.length ? versions : undefined,
        }),
      });

      if (!res.ok || !res.body) throw new Error("Kết nối thất bại");

      const streamReader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const chunk of lines) {
          const line = chunk.replace(/^data:\s*/, "").trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line) as {
              type: string;
              model?: string;
              phase?: string;
              message?: string;
              title?: string;
              description?: string;
              viTitle?: string;
              viDescription?: string;
              tags?: string[];
            };
            if (event.type === "trying") {
              setGenWarnType("trying");
              setGenWarn(`Đang thử model ${event.model}${event.phase === "text-only" ? " (chỉ văn bản)" : " (vision)"}...`);
            } else if (event.type === "failed") {
              setGenWarnType("warn");
              setGenWarn(`Model ${event.model} không khả dụng — đang thử model tiếp theo...`);
            } else if (event.type === "fallback") {
              setGenWarnType("warn");
              setGenWarn("Vision thất bại — chuyển sang chế độ văn bản...");
            } else if (event.type === "result") {
              setTitle(event.title ?? "");
              setDescription(event.description ?? "");
              // Tags are auto-generated server-side; AI-suggested tags are ignored.
              setContentGenerated(true);
              setGenWarn("");
            } else if (event.type === "error") {
              setGenWarnType("error");
              setGenWarn(event.message ?? "Lỗi không xác định");
            }
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch (err) {
      setGenWarnType("error");
      setGenWarn(err instanceof Error ? err.message : "Lỗi khi tạo nội dung AI");
    } finally {
      setGeneratingContent(false);
    }
  }, [renderedImages, aiModel, aiHint, composeSkillPrompt, selectedSkillIds, versions]);

  // Upload rendered images/videos to storage and return their hosted URLs, both
  // in their current (dragged) order. Reused by Deploy and Save so the gallery
  // restores either way. Toggles `uploadingAssets` for the shared progress label.
  const uploadAssets = useCallback(async (): Promise<{ imageUrls: string[]; videoUrls: string[] }> => {
    setUploadingAssets(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Bạn cần đăng nhập.");

      const ts = Date.now();
      const imageUrls: string[] = [];
      for (let i = 0; i < renderedImages.length; i++) {
        const ri = renderedImages[i];
        // Restored images already have a hosted URL — reuse it; only freshly
        // rendered images (with a blob) need uploading.
        if (!ri.blob) {
          imageUrls.push(ri.url);
          continue;
        }
        // Rendered images are PNG; user-uploaded ones keep their own type/ext.
        const mime = ri.mimeType || ri.blob.type || "image/png";
        const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
        const path = `shopify-mockups/${product.id}/${ts}-img-${i}.${ext}`;
        imageUrls.push(await uploadBlobToStorage(ri.blob, path, mime));
      }

      // Upload each video in order. Freshly rendered/uploaded ones carry a blob;
      // saved ones already have a hosted URL and are reused as-is.
      const videoUrls: string[] = [];
      for (let i = 0; i < renderedVideos.length; i++) {
        const rv = renderedVideos[i];
        if (!rv.blob) {
          videoUrls.push(rv.url);
          continue;
        }
        const mime = rv.mimeType || rv.blob.type || "video/mp4";
        const ext = mime.includes("mp4") ? "mp4" : mime.includes("quicktime") || mime.includes("mov") ? "mov" : "webm";
        const videoPath = `shopify-mockups/${product.id}/${ts}-video-${i}.${ext}`;
        videoUrls.push(await uploadBlobToStorage(rv.blob, videoPath, mime));
      }
      return { imageUrls, videoUrls };
    } finally {
      setUploadingAssets(false);
    }
  }, [product.id, renderedImages, renderedVideos]);

  // ── Replace one image (keep its name) ──
  // Open the hidden picker for a specific entry; the chosen file replaces the
  // image's url/blob but keeps refName so classification/ordering is unchanged.
  const startReplaceImage = useCallback((refId: string) => {
    replaceTargetRef.current = refId;
    replaceInputRef.current?.click();
  }, []);

  const onReplaceFilePicked = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetId = replaceTargetRef.current;
    e.target.value = ""; // allow re-picking the same file later
    replaceTargetRef.current = null;
    if (!file || !targetId) return;
    const url = URL.createObjectURL(file);
    setRenderedImages((prev) => prev.map((ri) => (ri.refId === targetId ? { ...ri, url, blob: file, mimeType: file.type || "image/png", saved: false } : ri)));
  }, []);

  // ── Add a new image (user names it to match the sort scheme) ──
  const confirmAddImage = useCallback(() => {
    const name = addImageName.trim();
    if (!addImageFile || !name) return;
    // Names map 1:1 to gallery/metafield slots, and classification matches them
    // case-insensitively — a duplicate would be silently dropped, so block it.
    const dup = renderedImages.some((ri) => ri.refName.trim().toLowerCase() === name.toLowerCase());
    if (dup) {
      setAddImageError(`Đã có ảnh tên "${name}". Mỗi tên chỉ dùng một lần — đổi tên hoặc dùng "Thay ảnh".`);
      return;
    }
    const url = URL.createObjectURL(addImageFile);
    setRenderedImages((prev) => [
      ...prev,
      {
        refId: `manual-${prev.length}-${name}`,
        refName: name,
        url,
        blob: addImageFile,
        mimeType: addImageFile.type || "image/png",
        saved: false,
      },
    ]);
    setAddImageOpen(false);
    setAddImageName("");
    setAddImageFile(null);
    setAddImageError("");
  }, [addImageFile, addImageName, renderedImages]);

  const removeImage = useCallback((refId: string) => {
    setRenderedImages((prev) => prev.filter((ri) => ri.refId !== refId));
  }, []);

  // ── Bulk-upload user images → appended as gallery images (drag to reorder) ──
  // Auto-named "User-Image-N" so they DON'T match the Mockup/Details/Package
  // convention and therefore land in the gallery (drag order controls position).
  const onUploadImagesPicked = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    setRenderedImages((prev) => {
      const taken = new Set(prev.map((ri) => ri.refName.trim().toLowerCase()));
      let n = prev.length + 1;
      const additions: RenderedImage[] = [];
      for (const file of files) {
        let name = `User-Image-${n}`;
        while (taken.has(name.toLowerCase())) name = `User-Image-${++n}`;
        taken.add(name.toLowerCase());
        n++;
        const url = URL.createObjectURL(file);
        renderedImageUrlsRef.current.push(url);
        additions.push({ refId: `upload-${name}-${url}`, refName: name, url, blob: file, mimeType: file.type || "image/png", saved: false, uploaded: true });
      }
      return [...prev, ...additions];
    });
  }, []);

  // ── Upload user videos → appended to the video block (drag to reorder) ──
  const onUploadVideosPicked = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    setRenderedVideos((prev) => {
      const additions: RenderedVideo[] = files.map((file, i) => {
        const url = URL.createObjectURL(file);
        renderedVideoUrlsRef.current.push(url);
        return { id: `upload-video-${prev.length + i}-${url}`, url, blob: file, label: file.name || `Video ${prev.length + i + 1}`, mimeType: file.type || "video/mp4", saved: false };
      });
      return [...prev, ...additions];
    });
  }, []);

  const removeVideo = useCallback((id: string) => {
    setRenderedVideos((prev) => prev.filter((rv) => rv.id !== id));
  }, []);

  // ── Drag reorder handlers ──
  const handleImageDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setRenderedImages((prev) => {
      const oldIndex = prev.findIndex((ri) => ri.refId === active.id);
      const newIndex = prev.findIndex((ri) => ri.refId === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  const handleVideoDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setRenderedVideos((prev) => {
      const oldIndex = prev.findIndex((rv) => rv.id === active.id);
      const newIndex = prev.findIndex((rv) => rv.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  // Final deploy order preview: gallery image #1, then all videos (2,3,...),
  // then the remaining gallery images. Mirrors the server rule (video block
  // after the 1st image). Details-* / Package-* images get no position — they
  // leave the gallery for a metafield, so numbering skips them entirely.
  // Returns a 1-based gallery position, or null for a metafield image.
  const imagePosition = useCallback(
    (imageIndex: number): number | null => {
      if (isMetafieldImageName(renderedImages[imageIndex]?.refName ?? "")) return null;
      // Count only the gallery images before this one, so a metafield image
      // sitting earlier in the array doesn't consume a slot number.
      let slot = 0;
      for (let i = 0; i <= imageIndex; i++) {
        if (!isMetafieldImageName(renderedImages[i]?.refName ?? "")) slot++;
      }
      if (slot === 1) return 1;
      // After the first image come all videos, then gallery image #2 onward.
      return renderedVideos.length + slot;
    },
    [renderedVideos.length, renderedImages],
  );

  // Build the form payload shared by Deploy and Save. customText/customTextPaid
  // depend on the selected mode; the rest is the current form state verbatim.
  const buildPayload = useCallback(
    (imageUrls: string[], videoUrls: string[]) => {
      const customTextOn = customTextMode !== "none";
      const customTextConfig = customTextOn ? { label: customTextLabel.trim(), example: customTextExample.trim() } : null;

      // Camera pose for the storefront's 2D → 3D swap. Only a reference that
      // opted in by name (Preview-3D) and renders a single full-canvas cue
      // qualifies; composite mockups yield null and stay 2D. Pair it with the
      // uploaded URL of the image it actually produced.
      const urlByRefName = new Map<string, string>();
      renderedImages.forEach((ri, i) => {
        const url = imageUrls[i];
        if (url) urlByRefName.set(ri.refName.trim().toLowerCase(), url);
      });
      const previewPose = buildPreviewPose(groupRefs, urlByRefName);

      return {
        productId: product.id,
        storeId: storeId ?? undefined,
        // The price table used for this deploy. Empty = built-in defaults.
        deployTemplateId: deployTemplateId || null,
        // Recorded per store so reopening on this store restores the same setup.
        imageGroupId: selectedGroupId || null,
        videoTemplateId: selectedTemplateId || null,
        productCode: productCode.trim(),
        title: title.trim(),
        description,
        collections: collectionList.join(", "),
        breadcrumbCollection,
        imageUrls,
        imageNames: renderedImages.map((ri) => ri.refName),
        videoUrl: videoUrls[0] ?? null,
        videoUrls,
        versions,
        wrapType,
        laserShaft,
        customImage,
        customText: customTextMode === "free" ? customTextConfig : null,
        customTextPaid: customTextMode === "paid" ? customTextConfig : null,
        aiHint: aiHint.trim(),
        aiModel,
        manualTags,
        skillIds: selectedSkillIds,
        surfaceSlots: product.surface_slots,
        surfaceImageUrl: product.surface_url ?? null,
        shaftConfig,
        previewPose,
      };
    },
    [
      product.id,
      product.surface_slots,
      product.surface_url,
      shaftConfig,
      groupRefs,
      storeId,
      deployTemplateId,
      selectedGroupId,
      selectedTemplateId,
      productCode,
      title,
      description,
      collectionList,
      breadcrumbCollection,
      renderedImages,
      versions,
      wrapType,
      laserShaft,
      customImage,
      customTextMode,
      customTextLabel,
      customTextExample,
      aiHint,
      aiModel,
      manualTags,
      selectedSkillIds,
    ]
  );

  const handleSaveShaftConfig = useCallback(async (config: ShaftConfig | null) => {
    setDeployError("");
    setSaveMsg("");
    const res = await fetch(`/api/products/${product.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shaft_config: config }),
    });
    const data = (await res.json().catch(() => null)) as Product | { error?: string } | null;
    if (!res.ok) {
      throw new Error((data && "error" in data && data.error) || "Lưu shaft config thất bại");
    }
    const savedConfig = data && "shaft_config" in data ? data.shaft_config ?? config : config;
    setShaftConfig(savedConfig);
    setSaveMsg("Đã lưu shaft config.");
  }, [product.id]);

  // ── Deploy ──
  const handleDeploy = useCallback(async () => {
    const customTextOn = customTextMode !== "none";
    if (!isValidProductCode(productCode, codeFormat)) {
      alert(`Tên sản phẩm phải có mã đúng định dạng ${codeFormatDef.label}. Hãy đổi tên sản phẩm.`);
      return;
    }
    if (!versions.length) {
      alert("Chọn ít nhất 1 phiên bản");
      return;
    }
    if (!wrapType) {
      alert("Chọn Wrap hoặc Wrapless");
      return;
    }
    if (!title.trim()) {
      alert("Nhập tiêu đề sản phẩm");
      return;
    }
    if (!renderedImages.length) {
      alert("Render ảnh mockup trước khi tạo sản phẩm.");
      return;
    }
    if (customTextOn && (!customTextLabel.trim() || !customTextExample.trim())) {
      alert("Custom Text yêu cầu cả 'Custom text label' và 'Custom text example'.");
      return;
    }
    if (product.surface_url?.startsWith("blob:")) {
      alert("Surface mới cần được lưu để có URL public trước khi deploy Shopify.");
      return;
    }
    if ((Array.isArray(product.surface_slots?.slots) ? product.surface_slots.slots.length : 0) > 0 && !product.surface_url) {
      alert("Surface slots cần một surface URL public. Hãy lưu sản phẩm trước khi deploy Shopify.");
      return;
    }

    setDeploying(true);
    setDeployError("");
    setDeployResult(null);
    setSaveMsg("");

    try {
      const { imageUrls, videoUrls } = await uploadAssets();

      const res = await fetch("/api/shopify/create-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(imageUrls, videoUrls)),
      });
      const data = (await res.json()) as DeployResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Tạo sản phẩm thất bại");
      setDeployResult({ ...data, storeName: activeStoreName });
      setConnected(true);
      // Notify the editor so its badge / button / links update immediately.
      onDeploymentChange?.({
        shopify_product_id: data.productId,
        admin_url: data.adminUrl,
        storefront_url: data.storefrontUrl,
        title: data.title,
        created_by: deployment?.created_by ?? null,
        creator_nickname: deployment?.creator_nickname ?? null,
        created_at: deployment?.created_at ?? new Date().toISOString(),
        form_data: deployment?.form_data ?? null,
      });
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setDeploying(false);
    }
  }, [productCode, codeFormat, codeFormatDef, versions, wrapType, title, customTextMode, customTextLabel, customTextExample, product.surface_slots, product.surface_url, renderedImages, uploadAssets, buildPayload, deployment, onDeploymentChange, activeStoreName]);

  // ── Save draft (persist form_data without touching Shopify) ──
  const handleSaveDraft = useCallback(async () => {
    setSaving(true);
    setSaveMsg("");
    setDeployError("");
    try {
      // Save the full snapshot incl. uploaded assets so the gallery restores.
      const { imageUrls, videoUrls } = await uploadAssets();

      const res = await fetch("/api/shopify/save-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(imageUrls, videoUrls)),
      });
      const data = (await res.json()) as { success?: boolean; formData?: ShopifyDeploymentSummary["form_data"]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Lưu nháp thất bại");
      setSaveMsg("Đã lưu nháp.");
      // Update the editor's deployment state so reopening (without a reload)
      // rehydrates from the saved draft. Keep it not-connected (no Shopify id).
      onDeploymentChange?.({
        shopify_product_id: null,
        admin_url: null,
        storefront_url: null,
        title: data.formData?.title ?? null,
        created_by: deployment?.created_by ?? null,
        creator_nickname: deployment?.creator_nickname ?? null,
        created_at: deployment?.created_at ?? new Date().toISOString(),
        form_data: data.formData ?? null,
      });
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setSaving(false);
    }
  }, [uploadAssets, buildPayload, deployment, onDeploymentChange]);

  // ── Close (ask to save the draft first) ──
  // A connected product already persists its form_data on deploy, so closing it
  // loses nothing — close straight away. While still a draft, clicking X risks
  // discarding unsaved work, so confirm whether to save first.
  const handleClose = useCallback(() => {
    if (connected || saving || deploying) {
      onClose();
      return;
    }
    setConfirmCloseOpen(true);
  }, [connected, saving, deploying, onClose]);

  // "Lưu nháp rồi đóng" — save first, then close once the draft is persisted.
  const handleSaveAndClose = useCallback(async () => {
    await handleSaveDraft();
    setConfirmCloseOpen(false);
    onClose();
  }, [handleSaveDraft, onClose]);

  // "Đóng không lưu" — discard and close.
  const handleDiscardAndClose = useCallback(() => {
    setConfirmCloseOpen(false);
    onClose();
  }, [onClose]);

  // ── Manual tag helpers ──
  const addManualTag = useCallback((value: string) => {
    const v = value.trim().toLowerCase();
    if (!v) return;
    setManualTags((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setManualTagInput("");
  }, []);
  const removeManualTag = useCallback((value: string) => {
    setManualTags((prev) => prev.filter((t) => t !== value));
  }, []);

  // ── Delete the live Shopify product (keeps saved form data for re-deploy) ──
  const handleDelete = useCallback(async () => {
    if (!confirm("Xóa sản phẩm khỏi Shopify? Dữ liệu đã nhập sẽ được giữ lại để bạn đăng lại.")) return;
    setDeleting(true);
    setDeployError("");
    try {
      const res = await fetch("/api/shopify/create-product", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        // storeId is required: without it the route falls back to the DEFAULT
        // store and would delete that store's product while another store is
        // selected in the dialog.
        body: JSON.stringify({ productId: product.id, storeId: storeId ?? undefined }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Xóa sản phẩm thất bại");
      // Back to create state — keep all form fields so the user can re-deploy.
      setConnected(false);
      setDeployResult(null);
      // Notify the editor: clear the Shopify link (badge/links disappear), but
      // keep the row's form_data for re-deploy.
      onDeploymentChange?.(deployment ? { ...deployment, shopify_product_id: null, admin_url: null, storefront_url: null } : null);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setDeleting(false);
    }
  }, [product.id, storeId, deployment, onDeploymentChange]);

  const toggleVersion = (v: Version) => {
    setVersions((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  };

  // ── Collections helpers ──
  const addCollection = useCallback((value: string) => {
    const v = value.trim();
    if (!v) return;
    setCollectionList((prev) => (prev.some((c) => c.toLowerCase() === v.toLowerCase()) ? prev : [...prev, v]));
    setCollectionInput("");
  }, []);

  const removeCollection = useCallback((value: string) => {
    setCollectionList((prev) => prev.filter((c) => c !== value));
    // If the removed collection was the breadcrumb pick, reset to "not picked".
    setBreadcrumbCollection((prev) => (prev === value ? null : prev));
  }, []);

  const selectedGroup = groups.find((g) => g.id === selectedGroupId);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  // Auto-generated tags preview (mirrors the server-side builder logic):
  // wrap/wrapless, full product code (nXX-YY), "laser shaft", custom-*, and
  // col_<collection> for each collection. Manual tags are shown separately.
  const codeLower = productCode.trim().toLowerCase();
  const generatedTags = [
    ...(wrapType ? [wrapType] : []),
    ...(codeLower ? [codeLower] : []),
    ...(laserShaft ? ["laser shaft"] : []),
    ...(customImage ? ["custom-upload", "custom-image"] : []),
    ...(customTextMode !== "none" ? ["custom-text"] : []),
    ...collectionList.map((c) => `col_${c.trim()}`),
  ].filter(Boolean);

  // Picker suggestions = saved (DB) + live Shopify collections, merged and
  // deduped by lowercased value. DB entries win so a name saved locally keeps
  // its "db" source; Shopify-only names are tagged "shopify".
  const collectionSuggestions = (() => {
    const byValue = new Map<string, { id: string; value: string; source: "db" | "shopify" }>();
    for (const c of savedCollections) {
      byValue.set(c.value.toLowerCase(), { id: `db-${c.id}`, value: c.value, source: "db" });
    }
    for (const c of shopifyCollections) {
      const lower = c.title.toLowerCase();
      if (!byValue.has(lower)) byValue.set(lower, { id: `shopify-${c.id}`, value: c.title, source: "shopify" });
    }
    const q = collectionInput.trim().toLowerCase();
    return [...byValue.values()]
      .filter((c) => !collectionList.some((sel) => sel.toLowerCase() === c.value.toLowerCase()))
      .filter((c) => !q || c.value.toLowerCase().includes(q))
      .sort((a, b) => a.value.localeCompare(b.value));
  })();

  // Price preview — computed by the SAME function the deploy route uses, from
  // the price table resolved for (brand template x selected store). No prices
  // are hardcoded here, so the preview cannot drift from what gets created.
  const pricedVariants = priceVariants({
    versions,
    laserShaft,
    customImage,
    customTextPaid: customTextMode === "paid",
    pricing: activePricing,
  });

  // `uploadingAssets` is shared by Deploy and Save; scope the deploy button's
  // busy state to an actual deploy (not a concurrent draft save).
  const deployBusy = (uploadingAssets || deploying) && !saving;
  // No in-place update: re-deploying a connected product recreates it fresh
  // on Shopify (the old one is deleted server-side).
  // Button label is the actionable/progress state only — the success
  // confirmation ("Đã tạo / Đã đăng lại thành công") lives in the green panel
  // below, based on what THIS action actually did (deployResult.isUpdate).
  const deployLabel = uploadingAssets
    ? "Đang tải ảnh lên..."
    : deploying
    ? isUpdateMode
      ? "Đang cập nhật sản phẩm..."
      : "Đang tạo sản phẩm..."
    : isUpdateMode
    ? "Cập nhật sản phẩm"
    : "Tạo sản phẩm Shopify";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 bg-[#0a0a0a] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-500/20">
            <ShoppingBag className="h-4 w-4 text-green-400" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-white truncate">{isUpdateMode ? "Đăng lại Shopify" : "Triển khai Shopify"}</h1>
            <p className="text-xs text-white/50 truncate">{product.name}</p>
          </div>
          <div className="ml-2 shrink-0">
            <StoreSwitcher />
          </div>
        </div>

        {/* When connected, show which store + the live Shopify links in the header. */}
        {connected && deployment && (
          <div className="hidden sm:flex items-center gap-3 ml-auto mr-2">
            {activeStoreName && (
              <span className="text-xs text-green-400 font-medium">Đã kết nối {activeStoreName}</span>
            )}
            {deployment.admin_url && (
              <a href={deployment.admin_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300">
                <ExternalLink className="h-3 w-3" /> Shopify Admin
              </a>
            )}
            {deployment.storefront_url && (
              <a href={deployment.storefront_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300">
                <ExternalLink className="h-3 w-3" /> Storefront
              </a>
            )}
          </div>
        )}
        {/* Save the current form as a draft (no Shopify deploy). Sits next to
            the close icon so the user can save before closing. Hidden once the
            product is live — Deploy already re-saves form_data. */}
        {!connected && (
          <Button
            variant="outline"
            onClick={handleSaveDraft}
            disabled={saving || deployBusy || deleting}
            className="ml-auto gap-2 border-white/20 text-white/90 hover:bg-white/5 hover:text-white"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Đang lưu..." : saveMsg ? "Đã lưu nháp" : "Lưu nháp"}
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={handleClose} className={connected ? "text-white/50 hover:text-white" : "ml-2 text-white/50 hover:text-white"}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* Body — two columns */}
      <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-2">
        {/* ── LEFT: Assets + Product config ── */}
        <div className="overflow-y-auto p-6 space-y-6 border-r border-white/10">
          {/* 1. Image group */}
          <Section title="1. Nhóm ảnh mockup">
            <p className="text-[11px] text-white/40 -mt-1">
              Render ảnh từ nhóm hoặc tải ảnh lên. Ảnh tải lên được giữ lại khi render, kéo để đổi thứ tự.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={selectedGroupId || undefined}
                onValueChange={(v) => {
                  setSelectedGroupId(v);
                  // Switching group clears the previously auto-rendered images but
                  // keeps the user's uploads (they persist across group changes).
                  setRenderedImages((prev) => prev.filter((ri) => ri.uploaded));
                }}
                disabled={loadingGroups}
              >
                <SelectTrigger className="flex-1 min-w-[180px] border-white/20 bg-white/5 text-white">
                  <SelectValue placeholder={loadingGroups ? "Đang tải..." : "-- Chọn nhóm ảnh --"} />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name} ({g.referenceIds.length} ảnh){g.createdByName ? ` · ${g.createdByName}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => imageUploadInputRef.current?.click()}
                className="gap-2 border-blue-400/40 bg-blue-500/10 text-blue-100 hover:bg-blue-500/20"
              >
                <Upload className="h-4 w-4" /> Tải ảnh lên
              </Button>
            </div>

            {/* Uploaded images shown even before any group render (upload-from-start).
                Rendered results (below) merge with these into one sortable grid. */}
            {renderedImages.length > 0 && !selectedGroupId && !renderedImages.some((ri) => ri.saved) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/40">{renderedImages.length} ảnh · kéo để đổi thứ tự</span>
                  <button type="button" onClick={() => setImageGridExpanded((p) => !p)} className="text-xs text-blue-400 hover:text-blue-300">
                    {imageGridExpanded ? "Thu nhỏ" : "Mở rộng"}
                  </button>
                </div>
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleImageDragEnd}>
                  <SortableContext items={renderedImages.map((ri) => ri.refId)} strategy={rectSortingStrategy}>
                    <div className={imageGridExpanded ? "grid grid-cols-3 sm:grid-cols-4 gap-2" : "flex gap-2 overflow-x-auto pb-1"}>
                      {renderedImages.map((ri, idx) => (
                        <SortableImageTile
                          key={ri.refId}
                          id={ri.refId}
                          refName={ri.refName}
                          url={ri.url}
                          position={imagePosition(idx)}
                          expanded={imageGridExpanded}
                          onReplace={() => startReplaceImage(ri.refId)}
                          onRemove={() => removeImage(ri.refId)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            )}

            {loadingRefs ? (
              <div className="flex items-center gap-2 text-white/40 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Đang tải refs...
              </div>
            ) : (
              groupRefs.length > 0 && (
                <>
                  {/* Render button */}
                  <Button onClick={handleRenderImages} disabled={renderingImages || !sceneManager} className="gap-2 bg-blue-700 hover:bg-blue-800 text-white">
                    {renderingImages ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Đang render {imageProgress.done}/{imageProgress.total}...
                      </>
                    ) : renderedImages.length > 0 ? (
                      <>
                        <RefreshCw className="h-4 w-4" />
                        Render lại ({groupRefs.length} ảnh)
                      </>
                    ) : (
                      <>
                        <ImageIcon className="h-4 w-4" />
                        Render {groupRefs.length} ảnh mockup
                      </>
                    )}
                  </Button>

                  {/* Progress bar */}
                  {renderingImages && imageProgress.total > 0 && (
                    <div className="w-full bg-white/10 rounded-full h-1.5">
                      <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{ width: `${(imageProgress.done / imageProgress.total) * 100}%` }} />
                    </div>
                  )}

                  {/* Results — draggable, single-line by default, expandable */}
                  {renderedImages.length > 0 ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-white/40">{renderedImages.length} ảnh · kéo để đổi thứ tự</span>
                        <div className="flex items-center gap-3">
                          <button type="button" onClick={() => setAddImageOpen(true)} className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300">
                            <Plus className="h-3 w-3" /> Thêm ảnh
                          </button>
                          <button type="button" onClick={() => setImageGridExpanded((p) => !p)} className="text-xs text-blue-400 hover:text-blue-300">
                            {imageGridExpanded ? "Thu nhỏ" : "Mở rộng"}
                          </button>
                        </div>
                      </div>
                      <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleImageDragEnd}>
                        <SortableContext items={renderedImages.map((ri) => ri.refId)} strategy={rectSortingStrategy}>
                          <div className={imageGridExpanded ? "grid grid-cols-3 sm:grid-cols-4 gap-2" : "flex gap-2 overflow-x-auto pb-1"}>
                            {renderedImages.map((ri, idx) => (
                              <SortableImageTile
                                key={ri.refId}
                                id={ri.refId}
                                refName={ri.refName}
                                url={ri.url}
                                position={imagePosition(idx)}
                                expanded={imageGridExpanded}
                                onReplace={() => startReplaceImage(ri.refId)}
                                onRemove={() => removeImage(ri.refId)}
                              />
                            ))}
                            {/* Pending refs not yet rendered */}
                            {renderingImages &&
                              groupRefs.slice(renderedImages.length).map((ref) => (
                                <div
                                  key={ref.id}
                                  className={`relative rounded-lg overflow-hidden border border-white/10 bg-white/5 flex items-center justify-center ${
                                    imageGridExpanded ? "aspect-[2/3]" : "aspect-square w-20 shrink-0"
                                  }`}
                                >
                                  <Loader2 className="h-6 w-6 text-white/30 animate-spin" />
                                  <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                                    <p className="text-[10px] text-white/40 truncate">{ref.name}</p>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </SortableContext>
                      </DndContext>
                    </div>
                  ) : (
                    !renderingImages && (
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                        {groupRefs.map((ref) => (
                          <div key={ref.id} className="relative aspect-square rounded-lg overflow-hidden border border-white/10 bg-white/5">
                            {ref.thumbUrl ? (
                              <img src={ref.thumbUrl} alt={ref.name} className="w-full h-full object-cover opacity-40" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-white/20 text-xs">No img</div>
                            )}
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="text-[10px] text-white/40">Chưa render</span>
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                              <p className="text-[10px] text-white/60 truncate">{ref.name}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  )}
                </>
              )
            )}

            {/* Saved images restored from a previous deploy — shown when no group
                is selected yet so a reopened product still previews its gallery.
                Picking a group (above) clears these and renders fresh ones. */}
            {!selectedGroupId && renderedImages.some((ri) => ri.saved) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/40">{renderedImages.length} ảnh đã lưu · kéo để đổi thứ tự</span>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setAddImageOpen(true)} className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300">
                      <Plus className="h-3 w-3" /> Thêm ảnh
                    </button>
                    <button type="button" onClick={() => setImageGridExpanded((p) => !p)} className="text-xs text-blue-400 hover:text-blue-300">
                      {imageGridExpanded ? "Thu nhỏ" : "Mở rộng"}
                    </button>
                  </div>
                </div>
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleImageDragEnd}>
                  <SortableContext items={renderedImages.map((ri) => ri.refId)} strategy={rectSortingStrategy}>
                    <div className={imageGridExpanded ? "grid grid-cols-3 sm:grid-cols-4 gap-2" : "flex gap-2 overflow-x-auto pb-1"}>
                      {renderedImages.map((ri, idx) => (
                        <SortableImageTile
                          key={ri.refId}
                          id={ri.refId}
                          refName={ri.refName}
                          url={ri.url}
                          position={imagePosition(idx)}
                          expanded={imageGridExpanded}
                          onReplace={() => startReplaceImage(ri.refId)}
                          onRemove={() => removeImage(ri.refId)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
                <p className="text-[11px] text-white/40">Chọn nhóm ảnh ở trên để render lại, hoặc đăng lại ngay với ảnh đã lưu.</p>
              </div>
            )}
          </Section>

          <Divider />

          {/* 2. Video — rendered templates + user uploads (always placed 2nd,
              then 3rd... right after the first image). */}
          <Section title="2. Video mockup">
            <p className="text-[11px] text-white/40 -mt-1">
              Video luôn nằm ngay sau ảnh đầu tiên (vị trí 2, 3...). Có thể render từ template hoặc tải video lên, kéo để đổi thứ tự.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={selectedTemplateId || undefined}
                onValueChange={(v) => setSelectedTemplateId(v)}
                disabled={loadingTemplates}
              >
                <SelectTrigger className="flex-1 min-w-[180px] border-white/20 bg-white/5 text-white">
                  <SelectValue placeholder={loadingTemplates ? "Đang tải..." : "-- Chọn video template (tùy chọn) --"} />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => videoUploadInputRef.current?.click()}
                className="gap-2 border-purple-400/40 bg-purple-500/10 text-purple-100 hover:bg-purple-500/20"
              >
                <Upload className="h-4 w-4" /> Tải video lên
              </Button>
            </div>

            {selectedTemplateId && (
              <Button onClick={handleRenderVideo} disabled={renderingVideo || !sceneManager} className="gap-2 bg-purple-700 hover:bg-purple-800 text-white">
                {renderingVideo ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Đang render...
                  </>
                ) : (
                  <>
                    <Video className="h-4 w-4" />
                    Render thêm video từ template
                  </>
                )}
              </Button>
            )}

            {/* Live canvas container — ESM canvas is imperatively appended here.
                Must be in the visible DOM so Chrome schedules rAF at full GPU priority. */}
            <div
              ref={canvasContainerRef}
              className={`w-full rounded-lg overflow-hidden bg-black transition-all ${renderingVideo ? "block" : "hidden"}`}
              style={{ aspectRatio: "16/9" }}
            />

            {renderingVideo && (
              <div className="space-y-2">
                <div className="w-full bg-white/10 rounded-full h-2">
                  <div className="bg-purple-500 h-2 rounded-full transition-all duration-300" style={{ width: `${videoProgressPct}%` }} />
                </div>
                {videoProgressLabel && <p className="text-xs text-white/40 text-center">{videoProgressLabel}</p>}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    cancelVideoRef.current = true;
                    activeEsmRef.current?.stopRecording();
                  }}
                  className="w-full gap-2"
                >
                  <XCircle className="h-4 w-4" />
                  Hủy render
                </Button>
              </div>
            )}

            {/* Video list — draggable among themselves. Badges show their final
                deploy position (2,3,...). */}
            {renderedVideos.length > 0 && (
              <div className="space-y-2">
                <span className="text-xs text-white/40">{renderedVideos.length} video · kéo để đổi thứ tự</span>
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleVideoDragEnd}>
                  <SortableContext items={renderedVideos.map((rv) => rv.id)} strategy={rectSortingStrategy}>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {renderedVideos.map((rv, idx) => (
                        <SortableVideoTile
                          key={rv.id}
                          id={rv.id}
                          label={rv.label}
                          url={rv.url}
                          // Videos occupy positions 2,3,... (after the 1st image).
                          position={2 + idx}
                          expanded={false}
                          onRemove={() => removeVideo(rv.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            )}
          </Section>

          <Divider />

          {/* 3. Product config */}
          <Section title="3. Cấu hình sản phẩm">
            <div className="space-y-4">
              {/* Product code is derived silently from the product name (nXX-YY).
                  It's not editable here — to change it, rename the product. */}
              <div>
                <Label className="text-white/70 text-xs mb-2 block">Phiên bản</Label>
                <div className="flex gap-2 flex-wrap">
                  {(["Standard", "Premium", "Pro", "Lux"] as Version[]).map((v) => (
                    <ToggleBtn key={v} active={versions.includes(v)} onClick={() => toggleVersion(v)}>
                      {v}
                    </ToggleBtn>
                  ))}
                </div>
              </div>

              <div>
                <Label className="text-white/70 text-xs mb-2 block">
                  Wrap / Wrapless <span className="text-red-400">*</span>
                </Label>
                <div className="flex gap-2">
                  {(["wrap", "wrapless"] as WrapType[]).map((w) => (
                    <ToggleBtn key={w} active={wrapType === w} onClick={() => setWrapType(w)} color="blue">
                      {w.charAt(0).toUpperCase() + w.slice(1)}
                    </ToggleBtn>
                  ))}
                </div>
              </div>

              <div>
                <Label className="text-white/70 text-xs mb-2 block">Labels</Label>
                <div className="flex gap-2 flex-wrap">
                  <ToggleBtn active={laserShaft} onClick={() => setLaserShaft((p) => !p)} color="purple">
                    Shaft Engraving (+$20)
                  </ToggleBtn>
                  <ToggleBtn active={customImage} onClick={() => setCustomImage((p) => !p)} color="orange">
                    Custom Image (+$20)
                  </ToggleBtn>
                  {/* Two mutually-exclusive custom-text modes: free vs paid (+$20). */}
                  <ToggleBtn active={customTextMode === "paid"} onClick={() => setCustomTextMode((m) => (m === "paid" ? "none" : "paid"))} color="teal">
                    Custom Text (+$20)
                  </ToggleBtn>
                  <ToggleBtn active={customTextMode === "free"} onClick={() => setCustomTextMode((m) => (m === "free" ? "none" : "free"))} color="teal">
                    Custom Text
                  </ToggleBtn>
                </div>
                {laserShaft && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-purple-500/25 bg-purple-500/10 p-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 border-purple-400/40 bg-purple-500/10 text-xs text-purple-100 hover:bg-purple-500/20"
                      onClick={() => setShaftConfigOpen(true)}
                    >
                      <ImageIcon className="mr-1.5 h-3.5 w-3.5" />
                      Shaft preview slot
                    </Button>
                    <span className="text-xs text-purple-200/70">
                      {shaftConfig?.standard?.imageUrl || shaftConfig?.proLux?.imageUrl
                        ? "Configured for Shopify custom.shaft_config"
                        : "Upload Standard and Pro/Lux preview images, then place the text frame"}
                    </span>
                  </div>
                )}
              </div>

              {/* Custom Text fields — required when a custom-text mode is on */}
              {customTextMode !== "none" && (
                <div className="space-y-3 pl-3 border-l-2 border-teal-500/40">
                  <p className="text-[11px] text-teal-300/70">
                    {customTextMode === "paid" ? "Custom Text tính phí (+$20) — cần làm thiết kế thêm." : "Custom Text miễn phí — chỉ thêm vào thiết kế."}
                  </p>
                  <div>
                    <Label className="text-white/70 text-xs mb-1 block">
                      Custom text label <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={customTextLabel}
                      onChange={(e) => setCustomTextLabel(e.target.value)}
                      placeholder="Enter your title/name"
                      className="bg-white/5 border-white/20 text-white placeholder:text-white/30"
                    />
                  </div>
                  <div>
                    <Label className="text-white/70 text-xs mb-1 block">
                      Custom text example <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={customTextExample}
                      onChange={(e) => setCustomTextExample(e.target.value)}
                      placeholder="Example: Daddy, Dad, Michael,..."
                      className="bg-white/5 border-white/20 text-white placeholder:text-white/30"
                    />
                  </div>
                </div>
              )}

              {/* Price table picker — sits with the variant preview it drives.
                  Admins get an inline editor; everyone else just picks. */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <Label className="text-white/70 text-xs">Bảng giá</Label>
                  {canEditPriceTables && (
                    <button
                      type="button"
                      onClick={() => setPriceEditorOpen(true)}
                      className="text-[11px] text-blue-400 hover:text-blue-300"
                    >
                      + Thêm / Sửa bảng giá
                    </button>
                  )}
                </div>
                <Select
                  value={deployTemplateId || undefined}
                  onValueChange={(v) => {
                    // "__none__" is the explicit "no table" pick — Select cannot
                    // use "" as an item value.
                    setDeployTemplateId(v === "__none__" ? "" : v);
                  }}
                >
                  <SelectTrigger className="border-white/20 bg-white/5 text-white">
                    <SelectValue
                      placeholder={loadingPriceTemplates ? "Đang tải..." : "-- Bảng giá mặc định --"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">-- Bảng giá mặc định --</SelectItem>
                    {priceTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                        {t.vendor ? ` · ${t.vendor}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Price preview — from the picked price table */}
              <div className="rounded-lg bg-white/5 border border-white/10 p-3 text-xs text-white/50 space-y-1">
                <div className="flex items-center justify-between mb-2 gap-2">
                  <p className="text-white/30 font-medium">Biến thể sẽ được tạo:</p>
                  <span className="text-[10px] text-white/40 truncate">
                    {priceTemplate?.name ?? "Bảng giá mặc định"}
                  </span>
                </div>
                {versions.length === 0 && <p className="text-yellow-400/60">Chưa chọn phiên bản</p>}
                {pricedVariants.map((pv) => (
                  <p key={`${pv.version}-${pv.laserOption ?? "single"}`}>
                    {pv.version}
                    {pv.laserOption === null ? "" : pv.laserOption === "Yes" ? " / Laser" : " / No Laser"}
                    : ${pv.price}
                    <span className="text-white/25"> (compare_at_price ${pv.compareAtPrice})</span>
                  </p>
                ))}
                {customImage && (
                  <p className="text-orange-400/70">
                    + Custom Image: +${activePricing.modifiers.customImage} trên tất cả biến thể
                  </p>
                )}
                {customTextMode === "paid" && (
                  <p className="text-teal-400/70">
                    + Custom Text: +${activePricing.modifiers.customTextPaid} trên tất cả biến thể
                  </p>
                )}
              </div>

              {/* Tags: auto-generated (read-only) + editable manual tags */}
              <div>
                <Label className="text-white/70 text-xs mb-1 block">Tags (tự động + thêm)</Label>
                <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 min-h-[40px] flex flex-wrap gap-1.5">
                  {generatedTags.length === 0 && manualTags.length === 0 && <span className="text-xs text-white/30">Sẽ tạo từ mã, options và collections...</span>}
                  {generatedTags.map((tag) => (
                    <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-white/10 text-white/70 border border-white/15">
                      {tag}
                    </span>
                  ))}
                  {/* Manual tags — removable chips */}
                  {manualTags.map((tag) => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-500/15 text-blue-200 border border-blue-400/30">
                      {tag}
                      <button type="button" onClick={() => removeManualTag(tag)} className="ml-0.5 rounded-full hover:text-white transition-colors">
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
                <Input
                  value={manualTagInput}
                  onChange={(e) => setManualTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addManualTag(manualTagInput);
                    }
                  }}
                  placeholder="Thêm tag (Enter để thêm) — vd: test, sale..."
                  className="bg-white/5 border-white/20 text-white placeholder:text-white/30 mt-2 h-8 text-sm"
                />
              </div>
            </div>
          </Section>
        </div>

        {/* ── RIGHT: AI content + Deploy ── */}
        <div className="overflow-y-auto p-6 space-y-6">
          {/* 4. AI Hint */}
          <Section title="4. AI Hint (tùy chọn)">
            <textarea
              value={aiHint}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setAiHint(e.target.value)}
              placeholder="Gợi ý chủ đề cho AI: vintage style, warm tone, gift for beginners..."
              rows={2}
              className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
            <div className="flex items-center gap-2 mt-2">
              <label className="text-xs text-white/50 whitespace-nowrap">Model AI:</label>
              <Select value={aiModel} onValueChange={setAiModel}>
                <SelectTrigger className="h-8 w-fit gap-2 border-white/20 bg-white/5 text-xs text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(availableModels.length > 0 ? availableModels : [{ id: "gpt-4o-mini", label: "GPT-4o Mini (Fast)" }]).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-white/30">AI sẽ dùng gợi ý này như chủ đề chính (HIGH PRIORITY)</p>

            {/* Skills — reusable prompt templates prepended to the hint */}
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-white/70 text-xs">
                  Skill (chọn 1) <span className="text-red-400">*</span>
                </Label>
                <button
                  type="button"
                  onClick={() => {
                    setEditingSkill(null);
                    setSkillModalOpen(true);
                  }}
                  className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                >
                  <Plus className="h-3.5 w-3.5" /> Skill mới
                </button>
              </div>
              {skills.length === 0 ? (
                <p className="text-xs text-white/30">Chưa có skill nào. Bấm “Skill mới” để thêm.</p>
              ) : (
                <div className="flex flex-col gap-1 max-h-44 overflow-y-auto pr-1">
                  {skills.map((s) => {
                    const active = selectedSkillIds.includes(s.id);
                    return (
                      <div
                        key={s.id}
                        className={`flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ${
                          active ? "border-teal-500/60 bg-teal-500/10" : "border-white/15 bg-white/5"
                        }`}
                      >
                        <button type="button" onClick={() => toggleSkill(s.id)} className="flex flex-1 items-center gap-2 min-w-0 text-left">
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${active ? "border-teal-500" : "border-white/30"}`}>
                            {active && <span className="h-2 w-2 rounded-full bg-teal-500" />}
                          </span>
                          <span className="text-xs text-white/80 truncate">{s.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSkill(s);
                            setSkillModalOpen(true);
                          }}
                          className="text-[11px] text-white/40 hover:text-white shrink-0"
                        >
                          Sửa
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {selectedSkillIds.length > 0 ? (
                <p className="text-[11px] text-teal-300/70">Skill được chọn — gửi như system prompt (AI tuân thủ chặt chẽ).</p>
              ) : (
                skills.length > 0 && (
                  <p className="text-[11px] text-amber-400/90 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3 shrink-0" /> Bắt buộc chọn 1 Skill trước khi tạo nội dung AI.
                  </p>
                )
              )}
            </div>
          </Section>

          <Divider />

          {/* 5. Generate AI content */}
          <Section title="5. Nội dung AI">
            <div className="flex items-center gap-3">
              <Button onClick={handleGenerateContent} disabled={generatingContent} className="gap-2 bg-purple-600 hover:bg-purple-700 text-white">
                {generatingContent ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {generatingContent ? "Đang tạo..." : contentGenerated ? "Tạo lại" : "Tạo nội dung AI"}
              </Button>
              {contentGenerated && !generatingContent && (
                <span className="flex items-center gap-1 text-xs text-green-400">
                  <Check className="h-3 w-3" /> Đã tạo
                </span>
              )}
            </div>
            {genWarn && (
              <p className={`flex items-center gap-1.5 text-xs mt-1 ${genWarnType === "error" ? "text-red-400" : genWarnType === "trying" ? "text-blue-400" : "text-amber-400"}`}>
                {genWarnType === "trying" && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
                {genWarnType === "warn" && <AlertTriangle className="h-3 w-3 shrink-0" />}
                {genWarnType === "error" && <XCircle className="h-3 w-3 shrink-0" />}
                {genWarn}
              </p>
            )}
          </Section>

          <Divider />

          {/* 6. Content fields */}
          <Section title="6. Nội dung sản phẩm">
            <div className="space-y-4">
              <div>
                <Label className="text-white/70 text-xs mb-1 block">
                  Tiêu đề <span className="text-red-400">*</span>
                </Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Tên sản phẩm..."
                  className="bg-white/5 border-white/20 text-white placeholder:text-white/30"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-white/70 text-xs block">Mô tả sản phẩm</Label>
                  {/* Show expand toggle once content is long enough to overflow the
                      collapsed height (~5 rows / ~250 chars or multi-line). */}
                  {(description.length > 250 || description.split("\n").length > 5) && (
                    <button type="button" onClick={() => setDescExpanded((p) => !p)} className="text-xs text-blue-400 hover:text-blue-300">
                      {descExpanded ? "Thu nhỏ" : "Mở rộng"}
                    </button>
                  )}
                </div>
                <textarea
                  value={description}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
                  placeholder="Mô tả chi tiết về thiết kế, chất liệu..."
                  rows={descExpanded ? 24 : 5}
                  className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-ring resize-y transition-all"
                />
              </div>

              <div className="rounded-lg border border-blue-400/30 bg-blue-500/5 p-3">
                <div className="flex items-center justify-start mb-2 gap-2">
                  <Label className="text-blue-200 text-sm font-semibold block">Collections</Label>
                  {/* + icon → dropdown of saved collections from the DB */}
                  <Popover open={collectionPickerOpen} onOpenChange={setCollectionPickerOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="flex p-2 items-center justify-center rounded-md border border-white/20 bg-white/5 text-white/60 hover:text-white hover:border-white/40 transition-colors"
                        title="Chọn từ collections đã lưu"
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        Chọn danh mục
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-64 p-2 dark:bg-zinc-900 dark:border-white/10">
                      <Input
                        value={collectionInput}
                        onChange={(e) => setCollectionInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addCollection(collectionInput);
                          }
                        }}
                        placeholder="Tìm hoặc thêm mới..."
                        className="bg-white/5 border-white/20 text-white placeholder:text-white/30 h-8 text-sm mb-2"
                        autoFocus
                      />
                      <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
                        {collectionInput.trim() && !collectionSuggestions.some((c) => c.value.toLowerCase() === collectionInput.trim().toLowerCase()) && (
                          <button
                            type="button"
                            onClick={() => addCollection(collectionInput)}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-green-400 hover:bg-white/10 text-left"
                          >
                            <Plus className="h-3.5 w-3.5" /> Thêm “{collectionInput.trim()}”
                          </button>
                        )}
                        {collectionSuggestions.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => addCollection(c.value)}
                            className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-sm text-white/80 hover:bg-white/10 text-left"
                          >
                            <span className="truncate">{c.value}</span>
                            {c.source === "shopify" && (
                              <span className="shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wide bg-green-500/15 text-green-400">Shopify</span>
                            )}
                          </button>
                        ))}
                        {loadingShopifyCollections && (
                          <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-white/30">
                            <Loader2 className="h-3 w-3 animate-spin" /> Đang tải từ Shopify...
                          </p>
                        )}
                        {!collectionInput.trim() && collectionSuggestions.length === 0 && !loadingShopifyCollections && (
                          <p className="px-2 py-1.5 text-xs text-white/30">Chưa có collection nào.</p>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                <Input
                  value={collectionInput}
                  onChange={(e) => setCollectionInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addCollection(collectionInput);
                    }
                  }}
                  placeholder="Nhập rồi Enter, hoặc bấm + để chọn từ danh sách"
                  className="bg-white/5 border-white/20 text-white placeholder:text-white/30"
                />

                {collectionList.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {collectionList.map((c) => (
                      <span key={c} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-white/10 text-white/70 border border-white/20">
                        {c}
                        <button type="button" onClick={() => removeCollection(c)} className="ml-0.5 rounded-full hover:text-white transition-colors">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Breadcrumb collection — pick exactly one of the collections above.
                  This value is written to custom.breadcrumb_collection on deploy so
                  the storefront breadcrumb shows the chosen collection. Default: none. */}
              <div className="rounded-lg border border-purple-400/30 bg-purple-500/5 p-3">
                <div className="flex items-center justify-between mb-2 gap-2">
                  <Label className="text-purple-200 text-sm font-semibold block">Breadcrumb collection</Label>
                  {breadcrumbCollection && (
                    <button type="button" onClick={() => setBreadcrumbCollection(null)} className="text-[11px] text-white/40 hover:text-white/80 transition-colors">
                      Bỏ chọn
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-white/40 mb-2">Chọn 1 collection bên trên để hiển thị trong breadcrumb của sản phẩm.</p>

                {collectionList.length === 0 ? (
                  <p className="text-xs text-white/30">Hãy thêm collection ở trên trước.</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {collectionList.map((c) => {
                      const active = breadcrumbCollection === c;
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setBreadcrumbCollection(active ? null : c)}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border transition-colors ${
                            active ? "bg-purple-500/25 text-purple-100 border-purple-400/60" : "bg-white/5 text-white/60 border-white/15 hover:border-white/35"
                          }`}
                        >
                          {active && <Check className="h-3 w-3" />}
                          {c}
                        </button>
                      );
                    })}
                  </div>
                )}

                {collectionList.length > 0 && !breadcrumbCollection && (
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-300/90">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    Chưa chọn breadcrumb collection — mặc định không cập nhật custom.breadcrumb_collection.
                  </p>
                )}
              </div>
            </div>
          </Section>

          <Divider />

          {/* 7. Deploy */}
          <Section title="7. Triển khai">
            <div className="space-y-3">
              {/* Summary */}
              <div className="rounded-lg bg-white/5 border border-white/10 p-3 text-xs text-white/50 space-y-1">
                <p>
                  <span className="text-white/30">Ảnh mockup:</span>{" "}
                  {renderedImages.length > 0 ? (
                    <span className="text-green-400">{renderedImages.length} ảnh đã render ✓</span>
                  ) : (
                    <span className="text-yellow-400/70">Chưa render</span>
                  )}
                </p>
                <p>
                  <span className="text-white/30">Video:</span>{" "}
                  {renderedVideos.length > 0 ? (
                    <span className="text-green-400">{renderedVideos.length} video (vị trí 2{renderedVideos.length > 1 ? `–${renderedVideos.length + 1}` : ""}) ✓</span>
                  ) : selectedTemplateId ? (
                    <span className="text-yellow-400/70">Chưa render</span>
                  ) : (
                    <span className="text-white/20">Không có</span>
                  )}
                </p>
                <p>
                  <span className="text-white/30">Mã:</span> {productCode || <span className="text-yellow-400/70">Chưa nhập</span>}
                </p>
                <p>
                  <span className="text-white/30">Tiêu đề:</span> {title || <span className="text-yellow-400/70">Chưa nhập</span>}
                </p>
                <p>
                  <span className="text-white/30">Phiên bản:</span> {versions.length ? versions.join(", ") : <span className="text-yellow-400/70">Chưa chọn</span>}
                </p>
                <p>
                  <span className="text-white/30">Wrap:</span> {wrapType || <span className="text-yellow-400/70">Chưa chọn</span>}
                </p>
                {collectionList.length > 0 && (
                  <p>
                    <span className="text-white/30">Collections:</span> {collectionList.join(", ")}
                  </p>
                )}
                {customImage && <p className="text-orange-400/70">Custom Image: ✓ (template_suffix: custom-upload, +$20)</p>}
                {customTextMode === "free" && <p className="text-teal-400/70">Custom Text (miễn phí): ✓ (label: {customTextLabel || "?"})</p>}
                {customTextMode === "paid" && <p className="text-teal-400/70">Custom Text (+$20): ✓ (label: {customTextLabel || "?"})</p>}
              </div>

              {/* Errors */}
              {deployError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-sm text-red-400">{deployError}</p>
                </div>
              )}

              {/* Success */}
              {deployResult && (
                <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 space-y-2">
                  <p className="text-sm font-semibold text-green-400 flex items-center gap-2">
                    <Check className="h-4 w-4" />
                    {deployResult.isUpdate ? "Sản phẩm đã được đăng lại thành công!" : "Sản phẩm đã được tạo thành công!"}
                    {deployResult.storeName && (
                      <span className="font-normal text-green-300/90">→ {deployResult.storeName}</span>
                    )}
                  </p>
                  <p className="text-xs text-white/60">{deployResult.title}</p>
                  <div className="flex gap-2 flex-wrap">
                    <a
                      href={deployResult.adminUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 underline"
                    >
                      <ExternalLink className="h-3 w-3" /> Admin
                    </a>
                    <a
                      href={deployResult.storefrontUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 underline"
                    >
                      <ExternalLink className="h-3 w-3" /> Storefront
                    </a>
                  </div>
                </div>
              )}

              <Button
                onClick={handleDeploy}
                disabled={deployBusy || deleting || saving}
                className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold py-6 text-base"
              >
                {deployBusy ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {deployLabel}
                  </>
                ) : (
                  <>
                    <ShoppingBag className="h-5 w-5" />
                    {deployLabel}
                  </>
                )}
              </Button>

              {/* Delete the live Shopify product (keeps saved data to re-deploy).
                  Temporarily hidden: deploys now update in place (no delete) so
                  ordered products keep their Shopify ID. `false &&` disables the
                  button without removing the wiring. */}
              {connected && canDelete && (
                <Button
                  variant="outline"
                  onClick={handleDelete}
                  disabled={deleting || deployBusy}
                  className="w-full gap-2 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {deleting ? "Đang xóa..." : "Xóa sản phẩm khỏi Shopify"}
                </Button>
              )}

              {deployResult && !isUpdateMode && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setDeployResult(null);
                    setDeployError("");
                  }}
                  className="w-full gap-2 border-white/20 text-white/70 hover:text-white"
                >
                  <RefreshCw className="h-4 w-4" />
                  Tạo sản phẩm mới
                </Button>
              )}
            </div>
          </Section>
        </div>
      </div>

      {/* Price table editor — the same controls as Admin → Bảng giá, so prices
          can be added/fixed mid-deploy without losing the form. */}
      {priceEditorOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-xl border border-white/10 bg-[#0f1115] p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-white">Bảng giá</h3>
              <button
                type="button"
                onClick={() => setPriceEditorOpen(false)}
                className="text-white/50 hover:text-white"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <PriceTablesEditor
              initialSelectedId={deployTemplateId || null}
              onChanged={(selectedId) => {
                // Refresh the picker, and follow the editor's selection so a
                // newly-created table is immediately the one being deployed.
                void reloadPriceTables();
                setDeployTemplateId(selectedId ?? "");
              }}
            />
            <div className="mt-5 flex justify-end">
              <Button
                variant="outline"
                onClick={() => setPriceEditorOpen(false)}
                className="border-white/20 text-white/70 hover:text-white"
              >
                Đóng
              </Button>
            </div>
          </div>
        </div>
      )}

      {skillModalOpen && (
        <SkillModal
          skill={editingSkill}
          onClose={() => {
            setSkillModalOpen(false);
            setEditingSkill(null);
          }}
          onSaved={loadSkills}
          onDeleted={() => {
            loadSkills();
            if (editingSkill) {
              setSelectedSkillIds((prev) => prev.filter((id) => id !== editingSkill.id));
            }
          }}
        />
      )}

      {/* Ask whether to save the draft before closing an unsaved product. */}
      <Dialog open={confirmCloseOpen} onOpenChange={(open) => !saving && setConfirmCloseOpen(open)}>
        <DialogContent className="sm:max-w-md border-white/10 bg-zinc-900 text-white">
          <DialogHeader>
            <DialogTitle>Lưu nháp trước khi đóng?</DialogTitle>
            <DialogDescription className="text-white/60">Bạn có thay đổi chưa lưu. Lưu nháp lại để lần sau mở lên còn nguyên, hoặc đóng mà không lưu.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => setConfirmCloseOpen(false)} disabled={saving} className="text-white/70 hover:text-white">
              Hủy
            </Button>
            <Button variant="outline" onClick={handleDiscardAndClose} disabled={saving} className="border-white/20 text-white/90 hover:bg-white/5 hover:text-white">
              Đóng không lưu
            </Button>
            <Button onClick={handleSaveAndClose} disabled={saving} className="gap-2 bg-green-600 hover:bg-green-700 text-white">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? "Đang lưu..." : "Lưu nháp rồi đóng"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hidden picker used by "Thay ảnh" — replaces the targeted image's bytes
          while keeping its name (so classification/ordering is unchanged). */}
      <input ref={replaceInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onReplaceFilePicked} />

      {/* Hidden pickers for bulk user uploads (images + videos). Both accept
          multiple files and append to the gallery in the current order. */}
      <input ref={imageUploadInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={onUploadImagesPicked} />
      <input ref={videoUploadInputRef} type="file" accept="video/mp4,video/webm,video/quicktime" multiple className="hidden" onChange={onUploadVideosPicked} />

      {/* Add a brand-new image; the user names it to match the sort scheme. */}
      <Dialog
        open={addImageOpen}
        onOpenChange={(open) => {
          setAddImageOpen(open);
          if (!open) setAddImageError("");
        }}
      >
        <DialogContent className="sm:max-w-md border-white/10 bg-zinc-900 text-white">
          <DialogHeader>
            <DialogTitle>Thêm ảnh</DialogTitle>
            <DialogDescription className="text-white/60">Chọn ảnh và đặt tên theo quy ước để khớp thuật toán sắp xếp.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-white/80">Ảnh</Label>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => setAddImageFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-white/70 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-white hover:file:bg-white/20"
              />
              {addImageFile && <img src={URL.createObjectURL(addImageFile)} alt="preview" className="mt-2 h-28 rounded-md object-contain border border-white/10" />}
            </div>
            <div className="space-y-1.5">
              <Label className="text-white/80">Tên ảnh</Label>
              <Input
                value={addImageName}
                onChange={(e) => {
                  setAddImageName(e.target.value);
                  setAddImageError("");
                }}
                placeholder="vd: Mockup-Web-3"
                className={`bg-white/5 text-white ${addImageError ? "border-red-500/60" : "border-white/20"}`}
              />
              {addImageError && (
                <p className="flex items-start gap-1 text-[11px] text-red-400">
                  <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" /> {addImageError}
                </p>
              )}
              <div className="rounded-md bg-white/5 p-2 text-[11px] text-white/50 leading-relaxed">
                <p className="text-white/70 mb-1">Quy ước tên (gallery & metafield):</p>
                <ul className="space-y-0.5">
                  <li>
                    <code className="text-blue-300">Mockup-Web-N</code> — ảnh gallery (N = số thứ tự)
                  </li>
                  <li>
                    <code className="text-blue-300">Mockup-Web-N-Standard</code> / <code className="text-blue-300">-Pro</code> — theo version
                  </li>
                  <li>
                    <code className="text-blue-300">Details-N</code> — metafield chi tiết
                  </li>
                  <li>
                    <code className="text-blue-300">Package-1-Standard</code> / <code className="text-blue-300">-Pro</code>, <code className="text-blue-300">Package-2</code> — ảnh
                    đóng gói
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => setAddImageOpen(false)} className="text-white/70 hover:text-white">
              Hủy
            </Button>
            <Button onClick={confirmAddImage} disabled={!addImageFile || !addImageName.trim()} className="gap-2 bg-green-600 hover:bg-green-700 text-white">
              <Plus className="h-4 w-4" /> Thêm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShaftConfigEditor
        productId={product.id}
        open={shaftConfigOpen}
        onOpenChange={setShaftConfigOpen}
        value={shaftConfig}
        onSave={handleSaveShaftConfig}
      />
    </div>
  );
}
