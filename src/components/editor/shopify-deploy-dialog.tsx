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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { Product, ShopifyDeploymentSummary, ShopifyCollection, ShopifySkill } from "@/types/product";
import type { ShopifyLiveCollection } from "@/app/api/shopify/collections/shopify/route";
import type { SceneManager } from "@/lib/three/scene-manager";
import type { ExtractorReference, ExtractorReferenceGroup } from "@/types/extractor";
import type { VideoStudioConfig } from "@/types/video-studio";
import { ensureFullConfig, computeVideoDuration, isCameraFixed } from "@/types/video-studio";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { renderReferenceToBlob } from "@/components/editor/image-extractor";
import { uploadBlobToStorage } from "@/lib/supabase/upload";
import { StoreSwitcher, useStore } from "@/components/shopify/store-switcher";
import { createClient } from "@/lib/supabase/client";
import { parseProductTitle } from "@/lib/shopify/parse-title";
import { getProductCodeFormat, isValidProductCode } from "@/lib/shopify/product-code";

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

/** One rendered-image tile with hover actions to replace or remove it. */
function EditableImageTile({ refName, url, expanded, onReplace, onRemove }: { refName: string; url: string; expanded: boolean; onReplace: () => void; onRemove: () => void }) {
  return (
    <div className={`group relative rounded-lg overflow-hidden border border-blue-500/40 bg-white/5 ${expanded ? "aspect-[2/3]" : "aspect-square w-20 shrink-0"}`}>
      <img src={url} alt={refName} className="w-full h-full object-cover" />
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
        <p className="text-[10px] text-white/70 truncate">{refName}</p>
      </div>
      <div className="absolute top-1 right-1 h-4 w-4 rounded-full bg-green-500 flex items-center justify-center">
        <Check className="h-2.5 w-2.5 text-white" />
      </div>
      {/* Hover actions */}
      <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity">
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

export function ShopifyDeployDialog({ product, sceneManager, deployment: initialDeployment = null, canDelete = false, onDeploymentChange, onClose }: Props) {
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
      })
      .catch(() => {});
    return () => { active = false; };
  }, [storeId, product.id]);
  // ── Data lists ──
  const [groups, setGroups] = useState<ExtractorReferenceGroup[]>([]);
  const [templates, setTemplates] = useState<VideoTemplateItem[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingTemplates, setLoadingTemplates] = useState(true);

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
  const [renderedVideoBlob, setRenderedVideoBlob] = useState<Blob | null>(null);
  // Restore the saved video (already hosted) so it previews on reopen.
  const [renderedVideoUrl, setRenderedVideoUrl] = useState<string | null>(prefill?.videoUrl ?? null);
  const [renderingVideo, setRenderingVideo] = useState(false);
  const [videoProgressPct, setVideoProgressPct] = useState(0);
  const [videoProgressLabel, setVideoProgressLabel] = useState("");
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const cancelVideoRef = useRef(false);
  const activeEsmRef = useRef<ExtractorSceneManager | null>(null);
  const renderedImageUrlsRef = useRef<string[]>([]);
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

  // Cleanup rendered image object URLs on unmount
  useEffect(() => {
    return () => {
      renderedImageUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      if (renderedVideoUrl) URL.revokeObjectURL(renderedVideoUrl);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render images ──
  const handleRenderImages = useCallback(async () => {
    if (!sceneManager || !groupRefs.length) return;

    // Cleanup previous renders
    renderedImageUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    renderedImageUrlsRef.current = [];
    setRenderedImages([]);
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
        const blob = await renderReferenceToBlob(model, ref, undefined, product.surface_url);
        const url = URL.createObjectURL(blob);
        renderedImageUrlsRef.current.push(url);
        results.push({ refId: ref.id, refName: ref.name, url, blob });
        setRenderedImages([...results]);
        setImageProgress({ done: i + 1, total: groupRefs.length });
      } catch (err) {
        console.error(`[ShopifyDeploy] Failed to render ref ${ref.name}:`, err);
        setImageProgress({ done: i + 1, total: groupRefs.length });
      }
    }
    setRenderingImages(false);
  }, [sceneManager, groupRefs]);

  // ── Render video ──
  const handleRenderVideo = useCallback(async () => {
    if (!sceneManager || !selectedTemplateId) return;

    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template?.config) {
      alert("Template config not found.");
      return;
    }

    if (renderedVideoUrl) URL.revokeObjectURL(renderedVideoUrl);
    setRenderedVideoBlob(null);
    setRenderedVideoUrl(null);
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
      isCameraFixed(config.cameraStart, config.cameraEnd) ? config.fixedCameraDuration : undefined
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

      let lastProgressMs = 0;
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
      });

      if (!cancelVideoRef.current) {
        const url = URL.createObjectURL(blob);
        setRenderedVideoBlob(blob);
        setRenderedVideoUrl(url);
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
  }, [sceneManager, selectedTemplateId, templates, renderedVideoUrl]);

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

  // Upload rendered images/video to storage and return their hosted URLs.
  // Reused by both Deploy and Save so the gallery restores either way.
  // Toggles `uploadingAssets` for the shared progress label.
  const uploadAssets = useCallback(async (): Promise<{ imageUrls: string[]; videoUrl?: string }> => {
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

      // Upload video if freshly rendered; otherwise reuse the saved video URL.
      let videoUrl: string | undefined;
      if (renderedVideoBlob) {
        const videoPath = `shopify-mockups/${product.id}/${ts}-video.webm`;
        videoUrl = await uploadBlobToStorage(renderedVideoBlob, videoPath, "video/webm");
      } else if (renderedVideoUrl) {
        videoUrl = renderedVideoUrl;
      }
      return { imageUrls, videoUrl };
    } finally {
      setUploadingAssets(false);
    }
  }, [product.id, renderedImages, renderedVideoBlob, renderedVideoUrl]);

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

  // Build the form payload shared by Deploy and Save. customText/customTextPaid
  // depend on the selected mode; the rest is the current form state verbatim.
  const buildPayload = useCallback(
    (imageUrls: string[], videoUrl?: string) => {
      const customTextOn = customTextMode !== "none";
      const customTextConfig = customTextOn ? { label: customTextLabel.trim(), example: customTextExample.trim() } : null;
      return {
        productId: product.id,
        storeId: storeId ?? undefined,
        productCode: productCode.trim(),
        title: title.trim(),
        description,
        collections: collectionList.join(", "),
        breadcrumbCollection,
        imageUrls,
        imageNames: renderedImages.map((ri) => ri.refName),
        videoUrl,
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
      };
    },
    [
      product.id,
      storeId,
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

    setDeploying(true);
    setDeployError("");
    setDeployResult(null);
    setSaveMsg("");

    try {
      const { imageUrls, videoUrl } = await uploadAssets();

      const res = await fetch("/api/shopify/create-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(imageUrls, videoUrl)),
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
  }, [productCode, codeFormat, codeFormatDef, versions, wrapType, title, customTextMode, customTextLabel, customTextExample, renderedImages, uploadAssets, buildPayload, deployment, onDeploymentChange, activeStoreName]);

  // ── Save draft (persist form_data without touching Shopify) ──
  const handleSaveDraft = useCallback(async () => {
    setSaving(true);
    setSaveMsg("");
    setDeployError("");
    try {
      // Save the full snapshot incl. uploaded assets so the gallery restores.
      const { imageUrls, videoUrl } = await uploadAssets();

      const res = await fetch("/api/shopify/save-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(imageUrls, videoUrl)),
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
        body: JSON.stringify({ productId: product.id }),
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
  }, [product.id, deployment, onDeploymentChange]);

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

  // Prices preview
  const baseImageAdd = customImage ? 20 : 0;
  const textPaidAdd = customTextMode === "paid" ? 20 : 0;
  const PRICES: Record<string, number> = {
    Standard: 154.5 + baseImageAdd + textPaidAdd,
    Premium: 229.5 + baseImageAdd + textPaidAdd,
    Pro: 299.5 + baseImageAdd + textPaidAdd,
    Lux: 399.5 + baseImageAdd + textPaidAdd,
  };

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
            <Select
              value={selectedGroupId || undefined}
              onValueChange={(v) => {
                setSelectedGroupId(v);
                setRenderedImages([]);
              }}
              disabled={loadingGroups}
            >
              <SelectTrigger className="w-full border-white/20 bg-white/5 text-white">
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

                  {/* Results — single-line by default, expandable to full grid */}
                  {renderedImages.length > 0 ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-white/40">{renderedImages.length} ảnh đã render</span>
                        <div className="flex items-center gap-3">
                          <button type="button" onClick={() => setAddImageOpen(true)} className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300">
                            <Plus className="h-3 w-3" /> Thêm ảnh
                          </button>
                          <button type="button" onClick={() => setImageGridExpanded((p) => !p)} className="text-xs text-blue-400 hover:text-blue-300">
                            {imageGridExpanded ? "Thu nhỏ" : "Mở rộng"}
                          </button>
                        </div>
                      </div>
                      <div className={imageGridExpanded ? "grid grid-cols-3 sm:grid-cols-4 gap-2" : "flex gap-2 overflow-x-auto pb-1"}>
                        {renderedImages.map((ri) => (
                          <EditableImageTile
                            key={ri.refId}
                            refName={ri.refName}
                            url={ri.url}
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
                  <span className="text-xs text-white/40">{renderedImages.length} ảnh đã lưu (lần đăng trước)</span>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setAddImageOpen(true)} className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300">
                      <Plus className="h-3 w-3" /> Thêm ảnh
                    </button>
                    <button type="button" onClick={() => setImageGridExpanded((p) => !p)} className="text-xs text-blue-400 hover:text-blue-300">
                      {imageGridExpanded ? "Thu nhỏ" : "Mở rộng"}
                    </button>
                  </div>
                </div>
                <div className={imageGridExpanded ? "grid grid-cols-3 sm:grid-cols-4 gap-2" : "flex gap-2 overflow-x-auto pb-1"}>
                  {renderedImages.map((ri) => (
                    <EditableImageTile
                      key={ri.refId}
                      refName={ri.refName}
                      url={ri.url}
                      expanded={imageGridExpanded}
                      onReplace={() => startReplaceImage(ri.refId)}
                      onRemove={() => removeImage(ri.refId)}
                    />
                  ))}
                </div>
                <p className="text-[11px] text-white/40">Chọn nhóm ảnh ở trên để render lại, hoặc đăng lại ngay với ảnh đã lưu.</p>
              </div>
            )}
          </Section>

          <Divider />

          {/* 2. Video template */}
          <Section title="2. Video mockup">
            <Select
              value={selectedTemplateId || undefined}
              onValueChange={(v) => {
                setSelectedTemplateId(v);
                setRenderedVideoBlob(null);
                setRenderedVideoUrl(null);
              }}
              disabled={loadingTemplates}
            >
              <SelectTrigger className="w-full border-white/20 bg-white/5 text-white">
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

            {selectedTemplateId && (
              <Button onClick={handleRenderVideo} disabled={renderingVideo || !sceneManager} className="gap-2 bg-purple-700 hover:bg-purple-800 text-white">
                {renderingVideo ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Đang render...
                  </>
                ) : renderedVideoUrl ? (
                  <>
                    <RefreshCw className="h-4 w-4" />
                    Render lại video
                  </>
                ) : (
                  <>
                    <Video className="h-4 w-4" />
                    Render video mockup
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

            {renderedVideoUrl && !renderingVideo && (
              <div className="rounded-lg overflow-hidden border border-purple-500/40 bg-white/5">
                <video src={renderedVideoUrl} controls loop className="w-full max-h-48 object-contain" />
                <p className="text-xs text-green-400 px-2 py-1 flex items-center gap-1">
                  <Check className="h-3 w-3" /> Video đã render — sẵn sàng tải lên
                </p>
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

              {/* Price preview */}
              <div className="rounded-lg bg-white/5 border border-white/10 p-3 text-xs text-white/50 space-y-1">
                <p className="text-white/30 font-medium mb-2">Biến thể sẽ được tạo:</p>
                {versions.length === 0 && <p className="text-yellow-400/60">Chưa chọn phiên bản</p>}
                {(["Standard", "Premium", "Pro", "Lux"] as Version[])
                  .filter((v) => versions.includes(v))
                  .map((v) => {
                    const base = PRICES[v];
                    if (laserShaft) {
                      return [
                        <p key={`${v}-no`}>
                          {v} / No Laser: ${base}
                        </p>,
                        <p key={`${v}-yes`}>
                          {v} / Laser: ${base + 20}
                        </p>,
                      ];
                    }
                    return (
                      <p key={v}>
                        {v}: ${base}
                      </p>
                    );
                  })}
                {customImage && <p className="text-orange-400/70">+ Custom Image: +$20 trên tất cả biến thể</p>}
                {customTextMode === "paid" && <p className="text-teal-400/70">+ Custom Text: +$20 trên tất cả biến thể</p>}
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
                  {renderedVideoUrl ? (
                    <span className="text-green-400">Đã render ✓</span>
                  ) : selectedTemplateId ? (
                    <span className="text-yellow-400/70">Chưa render</span>
                  ) : (
                    <span className="text-white/20">Không chọn</span>
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
    </div>
  );
}
