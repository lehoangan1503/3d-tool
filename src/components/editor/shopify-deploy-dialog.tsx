"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X, Sparkles, ShoppingBag, Loader2, Check, ChevronDown, RefreshCw,
  ExternalLink, Image as ImageIcon, Video, AlertCircle, XCircle, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Product, ShopifyDeploymentSummary } from "@/types/product";
import type { SceneManager } from "@/lib/three/scene-manager";
import type { ExtractorReference, ExtractorReferenceGroup } from "@/types/extractor";
import type { VideoStudioConfig } from "@/types/video-studio";
import { ensureFullConfig, computeVideoDuration, isCameraFixed } from "@/types/video-studio";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { renderReferenceToBlob } from "@/components/editor/image-extractor";
import { uploadBlobToStorage } from "@/lib/supabase/upload";
import { createClient } from "@/lib/supabase/client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface VideoTemplateItem {
  id: string;
  name: string;
  config: VideoStudioConfig;
}

type Version = "Standard" | "Premium" | "Pro";
type WrapType = "wrap" | "wrapless";

interface RenderedImage {
  refId: string;
  refName: string;
  url: string;     // object URL for preview
  blob: Blob;
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
}

interface Props {
  product: Product;
  sceneManager: SceneManager | null;
  deployment?: ShopifyDeploymentSummary | null;
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

function ToggleBtn({
  active, onClick, children, color = "green",
}: {
  active: boolean; onClick: () => void; children: React.ReactNode; color?: string;
}) {
  const colors: Record<string, string> = {
    green:  "bg-green-600 border-green-500",
    blue:   "bg-blue-600 border-blue-500",
    purple: "bg-purple-600 border-purple-500",
    orange: "bg-orange-600 border-orange-500",
    teal:   "bg-teal-600 border-teal-500",
  };
  const active_cls = colors[color] ?? colors.green;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border transition-colors ${
        active
          ? `${active_cls} text-white`
          : "bg-white/5 border-white/20 text-white/60 hover:border-white/40"
      }`}
    >
      {active ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ShopifyDeployDialog({ product, sceneManager, deployment = null, onClose }: Props) {
  const isUpdateMode = Boolean(deployment);
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
  const [renderedImages, setRenderedImages] = useState<RenderedImage[]>([]);
  const [renderingImages, setRenderingImages] = useState(false);
  const [imageProgress, setImageProgress] = useState({ done: 0, total: 0 });
  const [renderedVideoBlob, setRenderedVideoBlob] = useState<Blob | null>(null);
  const [renderedVideoUrl, setRenderedVideoUrl] = useState<string | null>(null);
  const [renderingVideo, setRenderingVideo] = useState(false);
  const [videoProgressPct, setVideoProgressPct] = useState(0);
  const [videoProgressLabel, setVideoProgressLabel] = useState("");
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const cancelVideoRef = useRef(false);
  const activeEsmRef = useRef<ExtractorSceneManager | null>(null);
  const renderedImageUrlsRef = useRef<string[]>([]);

  // ── Product config ──
  const [productCode, setProductCode] = useState("");
  const [versions, setVersions] = useState<Version[]>(["Standard", "Premium"]);
  const [wrapType, setWrapType] = useState<WrapType>("wrap");
  const [laserShaft, setLaserShaft] = useState(false);
  const [customImage, setCustomImage] = useState(false);
  const [customText, setCustomText] = useState(false);
  const [customTextLabel, setCustomTextLabel] = useState("");
  const [customTextExample, setCustomTextExample] = useState("");

  // ── Content ──
  const [aiHint, setAiHint] = useState("");
  const [aiModel, setAiModel] = useState("gpt-5.4-mini");
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const tagsInputRef = useRef<HTMLInputElement>(null);
  const [collections, setCollections] = useState("");
  const [generatingContent, setGeneratingContent] = useState(false);
  const [contentGenerated, setContentGenerated] = useState(false);
  const [genWarn, setGenWarn] = useState("");
  const [genWarnType, setGenWarnType] = useState<"trying" | "warn" | "error">("warn");

  // ── Upload + Deploy ──
  const [uploadingAssets, setUploadingAssets] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [deployError, setDeployError] = useState("");

  // ── Load available AI models ──
  useEffect(() => {
    fetch("/api/shopify/generate-content")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.models?.length) {
          setAvailableModels(data.models);
          // If current model isn't in the list, reset to first available
          setAiModel((cur) => data.models.find((m: { id: string }) => m.id === cur) ? cur : data.models[0].id);
        }
      });
  }, []);

  // ── Load groups ──
  useEffect(() => {
    fetch("/api/extractor-reference-groups")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setGroups(data.items ?? []); })
      .finally(() => setLoadingGroups(false));
  }, []);

  // ── Load templates ──
  useEffect(() => {
    fetch("/api/video-studio-templates?limit=100")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setTemplates(data.items ?? []); })
      .finally(() => setLoadingTemplates(false));
  }, []);

  // ── Load full refs for selected group ──
  useEffect(() => {
    if (!selectedGroupId) { setGroupRefs([]); return; }
    const group = groups.find((g) => g.id === selectedGroupId);
    if (!group?.referenceIds?.length) { setGroupRefs([]); return; }

    setLoadingRefs(true);
    Promise.all(
      group.referenceIds.map((id) =>
        fetch(`/api/extractor-references/${id}`)
          .then((r) => r.ok ? r.json() as Promise<ExtractorReference> : null)
      )
    )
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
        const blob = await renderReferenceToBlob(model, ref);
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
    if (!template?.config) { alert("Template config not found."); return; }

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
      config.cameraStart, config.cameraEnd, config.cameraSpeed, "xyz",
      isCameraFixed(config.cameraStart, config.cameraEnd) ? config.fixedCameraDuration : undefined,
    );
    const fmt = (s: number) => s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

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
        if (cancelVideoRef.current) { esm.stopRecording(); return; }
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

  // ── Generate AI content ──
  const handleGenerateContent = useCallback(async () => {
    if (!renderedImages.length) {
      setGenWarnType("warn");
      setGenWarn("Hãy render ảnh mockup trước để AI phân tích ảnh sản phẩm.");
      return;
    }
    setGenWarn("");
    setGeneratingContent(true);
    try {
      const firstBlob = renderedImages[0].blob;
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((res, rej) => {
        reader.onload = () => res(reader.result as string);
        reader.onerror = rej;
        reader.readAsDataURL(firstBlob);
      });

      const res = await fetch("/api/shopify/generate-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: dataUrl, hint: aiHint.trim() || undefined, model: aiModel }),
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
              type: string; model?: string; phase?: string;
              message?: string; title?: string; description?: string;
              viTitle?: string; viDescription?: string; tags?: string[];
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
              setTagsInput((event.tags ?? []).join(", "));
              setContentGenerated(true);
              setGenWarn("");
            } else if (event.type === "error") {
              setGenWarnType("error");
              setGenWarn(event.message ?? "Lỗi không xác định");
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      setGenWarnType("error");
      setGenWarn(err instanceof Error ? err.message : "Lỗi khi tạo nội dung AI");
    } finally {
      setGeneratingContent(false);
    }
  }, [renderedImages, aiHint, aiModel]);

  // ── Deploy ──
  const handleDeploy = useCallback(async () => {
    if (!productCode.trim()) { alert("Nhập mã sản phẩm (vd: n01-05)"); return; }
    if (!versions.length) { alert("Chọn ít nhất 1 phiên bản"); return; }
    if (!title.trim()) { alert("Nhập tiêu đề sản phẩm"); return; }
    if (!renderedImages.length) { alert("Render ảnh mockup trước khi tạo sản phẩm."); return; }
    if (customText && (!customTextLabel.trim() || !customTextExample.trim())) {
      alert("Custom Text yêu cầu cả 'Custom text label' và 'Custom text example'.");
      return;
    }

    setDeploying(true);
    setDeployError("");
    setDeployResult(null);

    try {
      // Upload rendered images to Supabase storage
      setUploadingAssets(true);
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Bạn cần đăng nhập để tạo sản phẩm.");

      const ts = Date.now();
      const uploadedImageUrls: string[] = [];

      for (let i = 0; i < renderedImages.length; i++) {
        const ri = renderedImages[i];
        const path = `shopify-mockups/${product.id}/${ts}-img-${i}.png`;
        const url = await uploadBlobToStorage(ri.blob, path, "image/png");
        uploadedImageUrls.push(url);
      }

      // Upload video if rendered
      let videoUrl: string | undefined;
      if (renderedVideoBlob) {
        const videoPath = `shopify-mockups/${product.id}/${ts}-video.webm`;
        videoUrl = await uploadBlobToStorage(renderedVideoBlob, videoPath, "video/webm");
      }

      setUploadingAssets(false);

      // Create Shopify product
      const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
      const res = await fetch("/api/shopify/create-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: product.id,
          productCode: productCode.trim(),
          title: title.trim(),
          description,
          collections,
          tags,
          imageUrls: uploadedImageUrls,
          videoUrl,
          versions,
          wrapType,
          laserShaft,
          customImage,
          customText: customText
            ? { label: customTextLabel.trim(), example: customTextExample.trim() }
            : null,
        }),
      });
      const data = await res.json() as DeployResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Tạo sản phẩm thất bại");
      setDeployResult(data);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setUploadingAssets(false);
      setDeploying(false);
    }
  }, [
    product.id, productCode, versions, wrapType, laserShaft, customImage,
    customText, customTextLabel, customTextExample, title, description,
    tagsInput, collections, renderedImages, renderedVideoBlob,
  ]);

  const toggleVersion = (v: Version) => {
    setVersions((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]);
  };

  const selectedGroup = groups.find((g) => g.id === selectedGroupId);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  // Prices preview
  const baseImageAdd = customImage ? 20 : 0;
  const PRICES: Record<string, number> = { Standard: 154.5 + baseImageAdd, Premium: 229.5 + baseImageAdd, Pro: 299.5 + baseImageAdd };

  const deployBusy = uploadingAssets || deploying;
  const deployLabel = uploadingAssets
    ? "Đang tải ảnh lên..."
    : deploying
    ? isUpdateMode
      ? "Đang cập nhật sản phẩm..."
      : "Đang tạo sản phẩm..."
    : deployResult
    ? isUpdateMode
      ? "Đã cập nhật thành công!"
      : "Đã tạo thành công!"
    : isUpdateMode
    ? "Cập nhật sản phẩm Shopify"
    : "Tạo sản phẩm Shopify";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 bg-[#0a0a0a] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/20">
            <ShoppingBag className="h-4 w-4 text-green-400" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white">
              {isUpdateMode ? "Cập nhật Shopify" : "Triển khai Shopify"}
            </h1>
            <p className="text-xs text-white/50">{product.name}</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="text-white/50 hover:text-white">
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* Body — two columns */}
      <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-2">

        {/* ── LEFT: Assets + Product config ── */}
        <div className="overflow-y-auto p-6 space-y-6 border-r border-white/10">

          {/* 1. Image group */}
          <Section title="1. Nhóm ảnh mockup">
            <div className="relative">
              <select
                value={selectedGroupId}
                onChange={(e) => { setSelectedGroupId(e.target.value); setRenderedImages([]); }}
                className="w-full appearance-none rounded-lg border border-white/20 bg-white/5 px-3 py-2 pr-8 text-sm text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                disabled={loadingGroups}
              >
                <option value="">{loadingGroups ? "Đang tải..." : "-- Chọn nhóm ảnh --"}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.referenceIds.length} ảnh){g.createdByName ? ` · ${g.createdByName}` : ""}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-white/40" />
            </div>

            {loadingRefs ? (
              <div className="flex items-center gap-2 text-white/40 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Đang tải refs...
              </div>
            ) : groupRefs.length > 0 && (
              <>
                {/* Render button */}
                <Button
                  onClick={handleRenderImages}
                  disabled={renderingImages || !sceneManager}
                  className="gap-2 bg-blue-700 hover:bg-blue-800 text-white"
                >
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
                    <div
                      className="bg-blue-500 h-1.5 rounded-full transition-all"
                      style={{ width: `${(imageProgress.done / imageProgress.total) * 100}%` }}
                    />
                  </div>
                )}

                {/* Results grid */}
                {renderedImages.length > 0 ? (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {renderedImages.map((ri) => (
                      <div key={ri.refId} className="relative aspect-square rounded-lg overflow-hidden border border-blue-500/40 bg-white/5">
                        <img src={ri.url} alt={ri.refName} className="w-full h-full object-cover" />
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                          <p className="text-[10px] text-white/70 truncate">{ri.refName}</p>
                        </div>
                        <div className="absolute top-1 right-1 h-4 w-4 rounded-full bg-green-500 flex items-center justify-center">
                          <Check className="h-2.5 w-2.5 text-white" />
                        </div>
                      </div>
                    ))}
                    {/* Pending refs not yet rendered */}
                    {renderingImages && groupRefs.slice(renderedImages.length).map((ref) => (
                      <div key={ref.id} className="relative aspect-square rounded-lg overflow-hidden border border-white/10 bg-white/5 flex items-center justify-center">
                        <Loader2 className="h-6 w-6 text-white/30 animate-spin" />
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                          <p className="text-[10px] text-white/40 truncate">{ref.name}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : !renderingImages && (
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
                )}
              </>
            )}
          </Section>

          <Divider />

          {/* 2. Video template */}
          <Section title="2. Video mockup">
            <div className="relative">
              <select
                value={selectedTemplateId}
                onChange={(e) => { setSelectedTemplateId(e.target.value); setRenderedVideoBlob(null); setRenderedVideoUrl(null); }}
                className="w-full appearance-none rounded-lg border border-white/20 bg-white/5 px-3 py-2 pr-8 text-sm text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                disabled={loadingTemplates}
              >
                <option value="">{loadingTemplates ? "Đang tải..." : "-- Chọn video template (tùy chọn) --"}</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-white/40" />
            </div>

            {selectedTemplateId && (
              <Button
                onClick={handleRenderVideo}
                disabled={renderingVideo || !sceneManager}
                className="gap-2 bg-purple-700 hover:bg-purple-800 text-white"
              >
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
                  <div
                    className="bg-purple-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${videoProgressPct}%` }}
                  />
                </div>
                {videoProgressLabel && (
                  <p className="text-xs text-white/40 text-center">{videoProgressLabel}</p>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => { cancelVideoRef.current = true; activeEsmRef.current?.stopRecording(); }}
                  className="w-full gap-2"
                >
                  <XCircle className="h-4 w-4" />
                  Hủy render
                </Button>
              </div>
            )}

            {renderedVideoUrl && !renderingVideo && (
              <div className="rounded-lg overflow-hidden border border-purple-500/40 bg-white/5">
                <video
                  src={renderedVideoUrl}
                  controls
                  loop
                  className="w-full max-h-48 object-contain"
                />
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
              <div>
                <Label className="text-white/70 text-xs mb-1 block">Mã sản phẩm (nXX-YY) <span className="text-red-400">*</span></Label>
                <Input
                  value={productCode}
                  onChange={(e) => setProductCode(e.target.value)}
                  placeholder="n01-05"
                  className="bg-white/5 border-white/20 text-white placeholder:text-white/30 focus:ring-green-500/50"
                />
              </div>

              <div>
                <Label className="text-white/70 text-xs mb-2 block">Phiên bản</Label>
                <div className="flex gap-2 flex-wrap">
                  {(["Standard", "Premium", "Pro"] as Version[]).map((v) => (
                    <ToggleBtn key={v} active={versions.includes(v)} onClick={() => toggleVersion(v)}>
                      {v}
                    </ToggleBtn>
                  ))}
                </div>
              </div>

              <div>
                <Label className="text-white/70 text-xs mb-2 block">Wrap / Wrapless <span className="text-red-400">*</span></Label>
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
                    Laser Shaft (+$20)
                  </ToggleBtn>
                  <ToggleBtn active={customImage} onClick={() => setCustomImage((p) => !p)} color="orange">
                    Custom Image (+$20)
                  </ToggleBtn>
                  <ToggleBtn active={customText} onClick={() => setCustomText((p) => !p)} color="teal">
                    Custom Text
                  </ToggleBtn>
                </div>
              </div>

              {/* Custom Text fields — required when customText is on */}
              {customText && (
                <div className="space-y-3 pl-3 border-l-2 border-teal-500/40">
                  <div>
                    <Label className="text-white/70 text-xs mb-1 block">Custom text label <span className="text-red-400">*</span></Label>
                    <Input
                      value={customTextLabel}
                      onChange={(e) => setCustomTextLabel(e.target.value)}
                      placeholder="Enter your title/name"
                      className="bg-white/5 border-white/20 text-white placeholder:text-white/30"
                    />
                  </div>
                  <div>
                    <Label className="text-white/70 text-xs mb-1 block">Custom text example <span className="text-red-400">*</span></Label>
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
                {(["Standard", "Premium", "Pro"] as Version[]).filter((v) => versions.includes(v)).map((v) => {
                  const base = PRICES[v];
                  if (laserShaft) {
                    return [
                      <p key={`${v}-no`}>{v} / No Laser: ${base}</p>,
                      <p key={`${v}-yes`}>{v} / Laser: ${base + 20}</p>,
                    ];
                  }
                  return <p key={v}>{v}: ${base}</p>;
                })}
                {customImage && <p className="text-orange-400/70">+ Custom Image: +$20 trên tất cả biến thể</p>}
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
              <select
                value={aiModel}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAiModel(e.target.value)}
                className="w-fit rounded-md border border-white/20 bg-white/5 px-2 py-1 text-xs text-white focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {(availableModels.length > 0
                  ? availableModels
                  : [{ id: "gpt-4o-mini", label: "GPT-4o Mini (Fast)" }]
                ).map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-white/30">AI sẽ dùng gợi ý này như chủ đề chính (HIGH PRIORITY)</p>
          </Section>

          <Divider />

          {/* 5. Generate AI content */}
          <Section title="5. Nội dung AI">
            <div className="flex items-center gap-3">
              <Button
                onClick={handleGenerateContent}
                disabled={generatingContent}
                className="gap-2 bg-purple-600 hover:bg-purple-700 text-white"
              >
                {generatingContent ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
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
                {genWarnType === "warn"   && <AlertTriangle className="h-3 w-3 shrink-0" />}
                {genWarnType === "error"  && <XCircle className="h-3 w-3 shrink-0" />}
                {genWarn}
              </p>
            )}
          </Section>

          <Divider />

          {/* 6. Content fields */}
          <Section title="6. Nội dung sản phẩm">
            <div className="space-y-4">
              <div>
                <Label className="text-white/70 text-xs mb-1 block">Tiêu đề <span className="text-red-400">*</span></Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Tên sản phẩm..."
                  className="bg-white/5 border-white/20 text-white placeholder:text-white/30"
                />
              </div>

              <div>
                <Label className="text-white/70 text-xs mb-1 block">Mô tả sản phẩm</Label>
                <textarea
                  value={description}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
                  placeholder="Mô tả chi tiết về thiết kế, chất liệu..."
                  rows={5}
                  className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                />
              </div>

              <div>
                <Label className="text-white/70 text-xs mb-1 block">Tags (cách nhau bằng dấu phẩy)</Label>
                <Input
                  ref={tagsInputRef}
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="floral, blue, gradient, custom-cue"
                  className="bg-white/5 border-white/20 text-white placeholder:text-white/30"
                />
                {tagsInput && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {tagsInput.split(",").map((t) => t.trim()).filter(Boolean).map((tag) => (
                      <span
                        key={tag}
                        onClick={() => {
                          const el = tagsInputRef.current;
                          if (!el) return;
                          const idx = tagsInput.indexOf(tag);
                          if (idx === -1) return;
                          el.focus();
                          el.setSelectionRange(idx, idx + tag.length);
                          el.scrollLeft = Math.max(0, idx * 7);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-white/10 text-white/70 border border-white/20 cursor-pointer hover:bg-white/20 transition-colors"
                      >
                        {tag}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const parts = tagsInput.split(",").map((t) => t.trim()).filter((t) => t !== tag);
                            setTagsInput(parts.join(", "));
                          }}
                          className="ml-0.5 rounded-full hover:text-white transition-colors"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <Label className="text-white/70 text-xs mb-1 block">Collections (cách nhau bằng dấu phẩy)</Label>
                <Input
                  value={collections}
                  onChange={(e) => setCollections(e.target.value)}
                  placeholder="Custom Cue, Special Edition"
                  className="bg-white/5 border-white/20 text-white placeholder:text-white/30"
                />
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
                  {renderedImages.length > 0
                    ? <span className="text-green-400">{renderedImages.length} ảnh đã render ✓</span>
                    : <span className="text-yellow-400/70">Chưa render</span>}
                </p>
                <p>
                  <span className="text-white/30">Video:</span>{" "}
                  {renderedVideoUrl
                    ? <span className="text-green-400">Đã render ✓</span>
                    : selectedTemplateId
                    ? <span className="text-yellow-400/70">Chưa render</span>
                    : <span className="text-white/20">Không chọn</span>}
                </p>
                <p><span className="text-white/30">Mã:</span> {productCode || <span className="text-yellow-400/70">Chưa nhập</span>}</p>
                <p><span className="text-white/30">Tiêu đề:</span> {title || <span className="text-yellow-400/70">Chưa nhập</span>}</p>
                <p><span className="text-white/30">Phiên bản:</span> {versions.length ? versions.join(", ") : <span className="text-yellow-400/70">Chưa chọn</span>}</p>
                <p><span className="text-white/30">Wrap:</span> {wrapType}</p>
                {customImage && <p className="text-orange-400/70">Custom Image: ✓ (template_suffix: custom-upload, +$20)</p>}
                {customText && <p className="text-teal-400/70">Custom Text: ✓ (label: {customTextLabel || "?"})</p>}
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
                    <Check className="h-4 w-4" />{" "}
                    {deployResult.isUpdate
                      ? "Sản phẩm đã được cập nhật thành công!"
                      : "Sản phẩm đã được tạo thành công!"}
                  </p>
                  <p className="text-xs text-white/60">{deployResult.title}</p>
                  <div className="flex gap-2 flex-wrap">
                    <a href={deployResult.adminUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 underline">
                      <ExternalLink className="h-3 w-3" /> Admin
                    </a>
                    <a href={deployResult.storefrontUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 underline">
                      <ExternalLink className="h-3 w-3" /> Storefront
                    </a>
                  </div>
                </div>
              )}

              <Button
                onClick={handleDeploy}
                disabled={deployBusy || !!deployResult}
                className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold py-6 text-base"
              >
                {deployBusy ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {deployLabel}
                  </>
                ) : deployResult ? (
                  <>
                    <Check className="h-5 w-5" />
                    {deployLabel}
                  </>
                ) : (
                  <>
                    <ShoppingBag className="h-5 w-5" />
                    {deployLabel}
                  </>
                )}
              </Button>

              {deployResult && !isUpdateMode && (
                <Button
                  variant="outline"
                  onClick={() => { setDeployResult(null); setDeployError(""); }}
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
    </div>
  );
}
