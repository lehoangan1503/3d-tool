"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CuePreview } from "@/components/editor/cue-preview";
import { LeatherPicker } from "@/components/editor/leather-picker";
import { SurfaceUploader } from "@/components/editor/surface-uploader";
import { ImageExtractor } from "@/components/editor/image-extractor";
import { VideoStudio } from "@/components/editor/video-studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CollapsibleCard } from "@/components/ui/collapsible-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import {
  ArrowLeft,
  Save,
  Sun,
  Moon,
  Loader2,
  Image,
  Palette,
  Info,
  Settings,
  Copy,
  Check,
  Lightbulb,
  Play,
  Pause,
  RotateCcw,
  ZoomIn,
  Move,
  Camera,
  Video,
} from "lucide-react";
import type { Product, ProductConfig, LeatherColor, LeatherTextureType } from "@/types/product";
import { DEFAULT_PRODUCT_CONFIG, configToSettingsJson } from "@/types/product";
import type { SceneManager } from "@/lib/three/scene-manager";
import { uploadToStorage } from "@/lib/supabase/upload";

interface EditorClientProps {
  product: Product;
  initialConfig?: ProductConfig;
}

interface PendingFiles {
  surface: { file: File; preview: string } | null;
  customTexture: { file: File; preview: string } | null;
}

export function EditorClient({ product: initialProduct, initialConfig }: EditorClientProps) {
  const router = useRouter();
  const [product, setProduct] = useState(initialProduct);
  const [config, setConfig] = useState<ProductConfig>(initialConfig || DEFAULT_PRODUCT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isDarkBg, setIsDarkBg] = useState(true);
  const [sceneManager, setSceneManager] = useState<SceneManager | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isAutoRotating, setIsAutoRotating] = useState(true);
  const [mobileControlsExpanded, setMobileControlsExpanded] = useState(false);
  const [sheetDragStart, setSheetDragStart] = useState<number | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFiles>({
    surface: null,
    customTexture: null,
  });
  const [showImageExtractor, setShowImageExtractor] = useState(false);
  const [showVideoExtractor, setShowVideoExtractor] = useState(false);

  const [hdriOptions, setHdriOptions] = useState<Array<{ id: string; label: string }>>([]);

  // Ref to access current config in callbacks
  const configRef = useRef(config);
  configRef.current = config;
  
  // Ref to access current product in callbacks
  const productRef = useRef(product);
  productRef.current = product;

  // Unsaved changes warning
  const { confirmNavigation } = useUnsavedChangesWarning(hasChanges);

  // Load available HDRIs from /public/hdri (via API)
  useEffect(() => {
    let cancelled = false;

    const fallback: Array<{ id: string; label: string }> = [
      { id: "bloem_train_track_clear_2k.hdr", label: "Bloem Train Track Clear 2k" },
      { id: "church_museum_2k.hdr", label: "Church Museum 2k" },
      { id: "church_stairway_2k.hdr", label: "Church Stairway 2k" },
      { id: "ferndale_studio_07_2k.hdr", label: "Ferndale Studio 07 2k" },
    ];

    async function loadHdris() {
      try {
        const res = await fetch("/api/hdri");
        const data = (await res.json()) as { options?: Array<{ id: string; label: string }> };
        const options = Array.isArray(data?.options) ? data.options : [];
        if (!cancelled) {
          setHdriOptions(options.length ? options : fallback);
        }
      } catch {
        if (!cancelled) {
          setHdriOptions(fallback);
        }
      }
    }

    loadHdris();
    return () => {
      cancelled = true;
    };
  }, []);

  // Ensure current selection is present in the list (even if API fails)
  useEffect(() => {
    if (!config.hdriType) return;
    setHdriOptions((prev) => (prev.some((o) => o.id === config.hdriType) ? prev : [{ id: config.hdriType, label: config.hdriType }, ...prev]));
  }, [config.hdriType]);

  const handleSceneReady = useCallback((manager: SceneManager) => {
    console.log("[EditorClient] handleSceneReady called");
    setSceneManager(manager);
    // Apply config to the scene immediately (from DB or defaults)
    // This ensures material values match UI state
    const currentConfig = configRef.current;
    const currentProduct = productRef.current;
    // manager.updateLighting(currentConfig.ambientLight, currentConfig.hemisphereLight);
    manager.updateToneMapping(); // Use original/no tone mapping
    manager.updateHdriExposure(currentConfig.hdriExposure);
    manager.updateHdriEnvironment(currentConfig.hdriType);
    manager.updateHdriRotation(currentConfig.hdriRotationX, currentConfig.hdriRotationY);
    manager.updateClearcoat(currentConfig.clearcoat);
    manager.updateBodyRoughness(currentConfig.bodyRoughness);
    if (currentProduct.type === "leather") {
      manager.updateLeatherConfig({
        roughness: currentConfig.leatherRoughness,
        sheen: currentConfig.leatherSheen,
        normalStrength: currentConfig.normalStrength,
      });
    }
    manager.updateJointConfig({
      roughness: currentConfig.jointRoughness,
      clearcoat: currentConfig.jointClearcoat,
      metalness: currentConfig.jointMetalness,
    });
    console.log("[EditorClient] Initial config applied:", currentConfig);
  }, []);

  // Update 3D scene when config changes
  useEffect(() => {
    if (!sceneManager) {
      console.log("[EditorClient] useEffect: sceneManager not ready");
      return;
    }

    console.log("[EditorClient] Applying config to scene:", config);

    // Update lighting (commented out — using HDRI instead)
    // sceneManager.updateLighting(config.ambientLight, config.hemisphereLight);

    sceneManager.updateToneMapping(); // Use original/no tone mapping

    // Update HDRI exposure
    sceneManager.updateHdriExposure(config.hdriExposure);

    // Update clearcoat (works for both leather and smooth)
    sceneManager.updateClearcoat(config.clearcoat);

    // Update body roughness (for smooth cue, or non-leather parts)
    sceneManager.updateBodyRoughness(config.bodyRoughness);

    // Update leather-specific material config (overrides body roughness for leather parts)
    if (product.type === "leather") {
      sceneManager.updateLeatherConfig({
        roughness: config.leatherRoughness,
        sheen: config.leatherSheen,
        normalStrength: config.normalStrength,
      });
    }

    // Update joint top config
    sceneManager.updateJointConfig({
      roughness: config.jointRoughness,
      clearcoat: config.jointClearcoat,
      metalness: config.jointMetalness,
    });
  }, [sceneManager, config, product.type]);

  // Update HDRI type only when it changes (avoid reloading HDRI on every config edit)
  useEffect(() => {
    if (!sceneManager) return;
    sceneManager.updateHdriEnvironment(config.hdriType);
  }, [sceneManager, config.hdriType]);

  // Update HDRI rotation when direction changes
  useEffect(() => {
    if (!sceneManager) return;
    sceneManager.updateHdriRotation(config.hdriRotationX, config.hdriRotationY);
  }, [sceneManager, config.hdriRotationX, config.hdriRotationY]);

  const updateProduct = (updates: Partial<Product>) => {
    setProduct((prev) => ({ ...prev, ...updates }));
    setHasChanges(true);
  };

  const updateConfig = (updates: Partial<ProductConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
    setHasChanges(true);
  };

  const handleSurfaceFileSelect = useCallback(
    (file: File | null, previewUrl: string) => {
      if (file) {
        setPendingFiles((prev) => ({
          ...prev,
          surface: { file, preview: previewUrl },
        }));
        updateProduct({ surface_url: previewUrl });
      } else {
        setPendingFiles((prev) => ({ ...prev, surface: null }));
        updateProduct({ surface_url: null });
      }
    },
    []
  );

  const handleCustomTextureSelect = useCallback(
    (file: File | null, previewUrl: string) => {
      if (file) {
        setPendingFiles((prev) => ({
          ...prev,
          customTexture: { file, preview: previewUrl },
        }));
        updateProduct({ texture_url: previewUrl });
      } else {
        setPendingFiles((prev) => ({ ...prev, customTexture: null }));
        updateProduct({ texture_url: null });
      }
    },
    []
  );

  const handleSave = async () => {
    setSaving(true);
    setUploading(true);

    try {
      let surfaceUrl = product.surface_url;
      let textureUrl = product.texture_url;

      // Prepare parallel upload tasks
      const uploadTasks: Promise<{ type: "surface" | "texture"; url: string }>[] = [];

      if (pendingFiles.surface) {
        uploadTasks.push(
          uploadToStorage(
            pendingFiles.surface.file,
            product.id,
            "surface",
            product.user_id
          ).then((url) => ({ type: "surface" as const, url }))
        );
      }

      if (pendingFiles.customTexture) {
        uploadTasks.push(
          uploadToStorage(
            pendingFiles.customTexture.file,
            product.id,
            "texture",
            product.user_id
          ).then((url) => ({ type: "texture" as const, url }))
        );
      }

      // Upload files in parallel (direct to Supabase - no Next.js proxy)
      if (uploadTasks.length > 0) {
        const results = await Promise.all(uploadTasks);
        for (const result of results) {
          if (result.type === "surface") {
            surfaceUrl = result.url;
          } else {
            textureUrl = result.url;
          }
        }
      }

      setUploading(false);

      const res = await fetch(`/api/products/${product.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: product.name,
          texture_type: product.texture_type,
          texture_url: textureUrl,
          color: product.color,
          surface_url: surfaceUrl,
          config: configToSettingsJson(config),
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to save");
      }

      // Clear pending files
      setPendingFiles({ surface: null, customTexture: null });
      setHasChanges(false);

      // Update product with uploaded URLs
      setProduct((prev) => ({
        ...prev,
        surface_url: surfaceUrl,
        texture_url: textureUrl,
      }));

      router.refresh();
    } catch (error) {
      console.error("Save error:", error);
      alert("Không thể lưu thay đổi");
    } finally {
      setSaving(false);
      setUploading(false);
    }
  };

  const toggleBackground = () => {
    if (sceneManager) {
      const newState = sceneManager.toggleBackground();
      setIsDarkBg(newState);
    }
  };

  const toggleAutoRotate = () => {
    if (sceneManager) {
      const newState = sceneManager.toggleAutoRotate();
      setIsAutoRotating(newState);
    }
  };

  const handleBackClick = (e: React.MouseEvent) => {
    if (hasChanges) {
      e.preventDefault();
      confirmNavigation(() => router.push("/dashboard"));
    }
  };

  const copyJsonMetadata = async () => {
    // Simplified Shopify metafield format
    const metadata = {
      type: product.type,
      surface_url: product.surface_url || "",
      config: {
        logoUrl: "https://cdn.shopify.com/s/files/1/0728/7314/8553/files/logo.png",
        hdriExposure: config.hdriExposure,
        hdriUrls: [
          "https://cdn.shopify.com/s/files/1/0728/7314/8553/files/church_museum_2k.hdr",
          "https://cdn.shopify.com/s/files/1/0728/7314/8553/files/church_stairway_2k.hdr",
          "https://cdn.shopify.com/s/files/1/0728/7314/8553/files/bloem_train_track_clear_2k.hdr"
        ],
        textureScale: config.textureScale,
        joint: {
          roughness: config.jointRoughness,
          clearcoat: config.jointClearcoat,
          metalness: config.jointMetalness,
        },
      },
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(metadata, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="bg-card/80 backdrop-blur-sm border-b px-2 sm:px-4 py-2 sm:py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <Link href="/dashboard" onClick={handleBackClick}>
            <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8 sm:h-10 sm:w-10">
              <ArrowLeft className="h-4 w-4 sm:h-5 sm:w-5" />
            </Button>
          </Link>
          <div className="min-w-0 flex-1">
            <Input
              value={product.name}
              onChange={(e) => updateProduct({ name: e.target.value })}
              className="font-semibold text-base sm:text-lg border-none shadow-none px-0 h-auto focus-visible:ring-0 bg-transparent truncate"
            />
            <p className="text-xs sm:text-sm text-muted-foreground capitalize">
              {product.type} cơ
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleAutoRotate}
            title={isAutoRotating ? "Tạm dừng tự động xoay" : "Bắt đầu tự động xoay"}
            className="h-8 w-8 sm:h-10 sm:w-10"
          >
            {isAutoRotating ? (
              <Pause className="h-4 w-4 sm:h-5 sm:w-5" />
            ) : (
              <Play className="h-4 w-4 sm:h-5 sm:w-5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleBackground}
            title={isDarkBg ? "Nền sáng" : "Nền tối"}
            className="h-8 w-8 sm:h-10 sm:w-10"
          >
            {isDarkBg ? (
              <Sun className="h-4 w-4 sm:h-5 sm:w-5" />
            ) : (
              <Moon className="h-4 w-4 sm:h-5 sm:w-5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowImageExtractor(true)}
            title="Chụp ảnh"
            className="h-8 w-8 sm:h-10 sm:w-10"
          >
            <Camera className="h-4 w-4 sm:h-5 sm:w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowVideoExtractor(true)}
            title="Quay video"
            className="h-8 w-8 sm:h-10 sm:w-10"
          >
            <Video className="h-4 w-4 sm:h-5 sm:w-5" />
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={saving || !hasChanges}
            size="sm"
            className="h-8 sm:h-10 px-2 sm:px-4 text-xs sm:text-sm"
          >
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin" />
                <span className="hidden sm:inline ml-1">{uploading ? "Đang tải lên..." : "Đang lưu..."}</span>
              </>
            ) : (
              <>
                <Save className="h-3 w-3 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline ml-1">Lưu</span>
              </>
            )}
          </Button>
        </div>
      </header>

      {/* Main content - stack vertically on mobile, side-by-side on larger screens */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0 relative">
        {/* 3D Preview - full height on mobile */}
        <div className="flex-1 relative min-w-0 h-full">
          <CuePreview key={product.id} product={product} config={config} onSceneReady={handleSceneReady} />
        </div>

        {/* Mobile Bottom Sheet Overlay */}
        {mobileControlsExpanded && (
          <div 
            className="lg:hidden fixed inset-0 bg-black/40 z-40 transition-opacity duration-300"
            onClick={() => setMobileControlsExpanded(false)}
            aria-hidden="true"
          />
        )}

        {/* Mobile Bottom Sheet */}
        <div 
          className={`lg:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border rounded-t-2xl shadow-2xl transition-transform duration-300 ease-out z-50 ${
            mobileControlsExpanded ? '' : 'translate-y-[calc(100%-56px)]'
          }`}
          style={{ height: '40vh' }}
        >
          {/* Drag handle */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setMobileControlsExpanded(!mobileControlsExpanded)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setMobileControlsExpanded(!mobileControlsExpanded); }}
            onTouchStart={(e) => {
              setSheetDragStart(e.touches[0].clientY);
            }}
            onTouchMove={(e) => {
              if (sheetDragStart === null) return;
              const currentY = e.touches[0].clientY;
              const diff = currentY - sheetDragStart;
              // Swipe down to close (diff > 0), swipe up to open (diff < 0)
              if (diff > 50 && mobileControlsExpanded) {
                setMobileControlsExpanded(false);
                setSheetDragStart(null);
              } else if (diff < -50 && !mobileControlsExpanded) {
                setMobileControlsExpanded(true);
                setSheetDragStart(null);
              }
            }}
            onTouchEnd={() => setSheetDragStart(null)}
            className="w-full flex items-center justify-center py-4 active:bg-muted/30 transition-colors rounded-t-2xl cursor-pointer touch-none"
            aria-label={mobileControlsExpanded ? "Thu gọn cài đặt" : "Mở rộng cài đặt"}
          >
            <div className="w-12 h-1.5 rounded-full bg-muted-foreground/50" />
          </div>
          
          {/* Scrollable content */}
          <div className="overflow-y-auto px-4 pb-6" style={{ height: 'calc(40vh - 56px)' }}>
            {/* Touch control hints */}
            <div className="flex justify-center gap-4 text-xs text-muted-foreground mb-3 pb-3 border-b border-border">
              <span className="flex items-center gap-1"><RotateCcw className="h-3 w-3" /> Kéo để xoay</span>
              <span className="flex items-center gap-1"><ZoomIn className="h-3 w-3" /> Chụm để thu phóng</span>
              <span className="flex items-center gap-1"><Move className="h-3 w-3" /> Hai ngón để di chuyển</span>
            </div>
            <div className="flex flex-col gap-3">
              {/* Surface Upload */}
              <CollapsibleCard
                title="Bề mặt"
                icon={<Image className="h-4 w-4 text-primary" />}
              >
                <SurfaceUploader
                  productId={product.id}
                  currentUrl={product.surface_url}
                  onFileSelect={handleSurfaceFileSelect}
                  pendingFile={pendingFiles.surface?.file}
                  pendingPreview={pendingFiles.surface?.preview}
                  uploading={uploading && !!pendingFiles.surface}
                />
              </CollapsibleCard>

              {/* HDRI Exposure Control */}
              <CollapsibleCard
                title="Ánh sáng HDRI"
                icon={<Lightbulb className="h-4 w-4 text-primary" />}
              >
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label>Loại HDRI</Label>
                    <Select value={config.hdriType} onValueChange={(v) => updateConfig({ hdriType: v })}>
                      <SelectTrigger id="hdriType-mobile">
                        <SelectValue placeholder="Chọn HDRI" />
                      </SelectTrigger>
                      <SelectContent>
                        {hdriOptions.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="hdriExposure-mobile">Cường độ</Label>
                    <Input
                      id="hdriExposure-mobile"
                      type="number"
                      min={0}
                      max={3}
                      step={0.05}
                      value={config.hdriExposure}
                      onChange={(e) =>
                        updateConfig({
                          hdriExposure: Math.min(3, Math.max(0, parseFloat(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="hdriRotationX-mobile">Hướng X (Dọc)</Label>
                      <span className="text-xs text-muted-foreground">{config.hdriRotationX}°</span>
                    </div>
                    <input
                      id="hdriRotationX-mobile"
                      type="range"
                      min={0}
                      max={360}
                      step={1}
                      value={config.hdriRotationX}
                      onChange={(e) =>
                        updateConfig({ hdriRotationX: parseFloat(e.target.value) })
                      }
                      className="w-full accent-primary"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="hdriRotationY-mobile">Hướng Y (Ngang)</Label>
                      <span className="text-xs text-muted-foreground">{config.hdriRotationY}°</span>
                    </div>
                    <input
                      id="hdriRotationY-mobile"
                      type="range"
                      min={0}
                      max={360}
                      step={1}
                      value={config.hdriRotationY}
                      onChange={(e) =>
                        updateConfig({ hdriRotationY: parseFloat(e.target.value) })
                      }
                      className="w-full accent-primary"
                    />
                  </div>
                </div>
              </CollapsibleCard>

              {/* Lighting & Environment — hidden (using HDRI instead)
              <CollapsibleCard
                title="Lighting & Environment"
                icon={<Lightbulb className="h-4 w-4 text-primary" />}
              >
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="ambientLight-mobile">Ambient Light</Label>
                    <Input
                      id="ambientLight-mobile"
                      type="number"
                      min={0}
                      max={2}
                      step={0.05}
                      value={config.ambientLight}
                      onChange={(e) =>
                        updateConfig({
                          ambientLight: Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="hemisphereLight-mobile">Hemisphere Light</Label>
                    <Input
                      id="hemisphereLight-mobile"
                      type="number"
                      min={0}
                      max={2}
                      step={0.05}
                      value={config.hemisphereLight}
                      onChange={(e) =>
                        updateConfig({
                          hemisphereLight: Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="clearcoat-mobile">Clearcoat</Label>
                    <Input
                      id="clearcoat-mobile"
                      type="number"
                      min={0}
                      max={100}
                      value={config.clearcoat}
                      onChange={(e) =>
                        updateConfig({
                          clearcoat: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="bodyRoughness-mobile">Body Roughness</Label>
                    <Input
                      id="bodyRoughness-mobile"
                      type="number"
                      min={0}
                      max={255}
                      value={config.bodyRoughness}
                      onChange={(e) =>
                        updateConfig({
                          bodyRoughness: Math.min(255, Math.max(0, parseInt(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                </div>
              </CollapsibleCard>
              */}

              {/* Leather Cylinder Config — DISABLED: using original GLB material (may re-enable later)
              <CollapsibleCard
                title="Leather Cylinder"
                icon={<Palette className="h-4 w-4 text-primary" />}
              >
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cylinderRoughness-mobile">Roughness</Label>
                    <Input
                      id="cylinderRoughness-mobile"
                      type="number"
                      min={0}
                      max={255}
                      step={1}
                      value={config.cylinderRoughness}
                      onChange={(e) =>
                        updateConfig({
                          cylinderRoughness: Math.min(255, Math.max(0, parseInt(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cylinderClearcoat-mobile">Clearcoat</Label>
                    <Input
                      id="cylinderClearcoat-mobile"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={config.cylinderClearcoat}
                      onChange={(e) =>
                        updateConfig({
                          cylinderClearcoat: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cylinderMetalness-mobile">Metalness</Label>
                    <Input
                      id="cylinderMetalness-mobile"
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={config.cylinderMetalness}
                      onChange={(e) =>
                        updateConfig({
                          cylinderMetalness: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cylinderColor-mobile">Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        id="cylinderColor-mobile"
                        type="color"
                        value={config.cylinderColor}
                        onChange={(e) => updateConfig({ cylinderColor: e.target.value })}
                        className="w-10 h-10 rounded border cursor-pointer"
                      />
                      <Input
                        type="text"
                        value={config.cylinderColor}
                        onChange={(e) => updateConfig({ cylinderColor: e.target.value })}
                        className="flex-1"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cylinderNormalScale-mobile">Texture Depth</Label>
                    <Input
                      id="cylinderNormalScale-mobile"
                      type="number"
                      min={0}
                      max={10}
                      step={0.1}
                      value={config.cylinderNormalScale}
                      onChange={(e) =>
                        updateConfig({
                          cylinderNormalScale: Math.min(10, Math.max(0, parseFloat(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cylinderSheen-mobile">Sheen</Label>
                    <Input
                      id="cylinderSheen-mobile"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={config.cylinderSheen}
                      onChange={(e) =>
                        updateConfig({
                          cylinderSheen: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cylinderSheenColor-mobile">Sheen Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        id="cylinderSheenColor-mobile"
                        type="color"
                        value={config.cylinderSheenColor}
                        onChange={(e) => updateConfig({ cylinderSheenColor: e.target.value })}
                        className="w-10 h-10 rounded border cursor-pointer"
                      />
                      <Input
                        type="text"
                        value={config.cylinderSheenColor}
                        onChange={(e) => updateConfig({ cylinderSheenColor: e.target.value })}
                        className="flex-1"
                      />
                    </div>
                  </div>
                </div>
              </CollapsibleCard>
              */}

              {/* Joint Top Config */}
              <CollapsibleCard
                title="Khớp đầu"
                icon={<Settings className="h-4 w-4 text-primary" />}
              >
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="jointRoughness-mobile">Độ nhám</Label>
                    <Input
                      id="jointRoughness-mobile"
                      type="number"
                      min={0}
                      max={255}
                      step={1}
                      value={config.jointRoughness}
                      onChange={(e) =>
                        updateConfig({
                          jointRoughness: Math.min(255, Math.max(0, parseInt(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="jointClearcoat-mobile">Độ bóng</Label>
                    <Input
                      id="jointClearcoat-mobile"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={config.jointClearcoat}
                      onChange={(e) =>
                        updateConfig({
                          jointClearcoat: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="jointMetalness-mobile">Độ kim loại</Label>
                    <Input
                      id="jointMetalness-mobile"
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={config.jointMetalness}
                      onChange={(e) =>
                        updateConfig({
                          jointMetalness: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)),
                        })
                      }
                    />
                  </div>
                </div>
              </CollapsibleCard>

              {/* TEMP: Leather options disabled - ver2 model has baked-in leather */}
              {/* {product.type === "leather" && (
                <>
                  <CollapsibleCard
                    title="Leather Options"
                    icon={<Palette className="h-4 w-4 text-primary" />}
                  >
                    <LeatherPicker
                      textureType={product.texture_type || "crocodile"}
                      color={product.color || "black"}
                      onTextureChange={(texture) =>
                        updateProduct({ texture_type: texture })
                      }
                      onColorChange={(color) => updateProduct({ color })}
                      onCustomTextureSelect={handleCustomTextureSelect}
                      customTexturePending={pendingFiles.customTexture?.file}
                      customTexturePreview={pendingFiles.customTexture?.preview}
                      uploading={uploading && !!pendingFiles.customTexture}
                    />
                  </CollapsibleCard>

                  <CollapsibleCard
                    title="Material Settings"
                    icon={<Settings className="h-4 w-4 text-primary" />}
                  >
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="leatherRoughness-mobile">Roughness</Label>
                        <Input
                          id="leatherRoughness-mobile"
                          type="number"
                          min={0}
                          max={255}
                          value={config.leatherRoughness}
                          onChange={(e) =>
                            updateConfig({
                              leatherRoughness: Math.min(255, Math.max(0, parseInt(e.target.value) || 0)),
                            })
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="normalStrength-mobile">Normal Strength</Label>
                        <Input
                          id="normalStrength-mobile"
                          type="number"
                          min={0}
                          max={10}
                          step={0.1}
                          value={config.normalStrength}
                          onChange={(e) =>
                            updateConfig({
                              normalStrength: Math.min(10, Math.max(0, parseFloat(e.target.value) || 0)),
                            })
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="textureScale-mobile">Texture Scale</Label>
                        <Input
                          id="textureScale-mobile"
                          type="number"
                          min={1}
                          max={8}
                          value={config.textureScale}
                          onChange={(e) =>
                            updateConfig({
                              textureScale: Math.min(8, Math.max(1, parseInt(e.target.value) || 1)),
                            })
                          }
                        />
                      </div>
                    </div>
                  </CollapsibleCard>
                </>
              )} */}
            </div>
          </div>
        </div>

        {/* Desktop Sidebar */}
        <div className="hidden lg:flex lg:w-80 shrink-0 bg-card border-l overflow-y-auto flex-col">
          <div className="p-4 flex flex-col gap-4">
            {/* 3D Controls */}
            <CollapsibleCard
              title="Điều khiển 3D"
              icon={<Info className="h-4 w-4 text-primary" />}
              defaultExpanded={true}
            >
              <div className="text-sm text-muted-foreground">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span>Xoay</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs bg-background px-2 py-0.5 rounded">
                        Click trái + kéo (ngang: quay, dọc: nghiêng)
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={toggleAutoRotate}
                        className="h-7 px-2"
                        title={isAutoRotating ? "Tạm dừng tự động xoay" : "Bắt đầu tự động xoay"}
                      >
                        {isAutoRotating ? (
                          <Pause className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Thu phóng</span>
                    <span className="text-xs bg-background px-2 py-0.5 rounded">
                      Con lăn chuột
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Di chuyển</span>
                    <span className="text-xs bg-background px-2 py-0.5 rounded">
                      Click phải + kéo
                    </span>
                  </div>
                </div>
              </div>
            </CollapsibleCard>

            {/* Surface Upload */}
            <CollapsibleCard
              title="Bề mặt"
              icon={<Image className="h-4 w-4 text-primary" />}
            >
              <SurfaceUploader
                productId={product.id}
                currentUrl={product.surface_url}
                onFileSelect={handleSurfaceFileSelect}
                pendingFile={pendingFiles.surface?.file}
                pendingPreview={pendingFiles.surface?.preview}
                uploading={uploading && !!pendingFiles.surface}
              />
            </CollapsibleCard>

            {/* HDRI Exposure Control */}
            <CollapsibleCard
              title="Ánh sáng HDRI"
              icon={<Lightbulb className="h-4 w-4 text-primary" />}
            >
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label>Loại HDRI</Label>
                  <Select value={config.hdriType} onValueChange={(v) => updateConfig({ hdriType: v })}>
                    <SelectTrigger id="hdriType">
                      <SelectValue placeholder="Chọn HDRI" />
                    </SelectTrigger>
                    <SelectContent>
                      {hdriOptions.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="hdriExposure">Cường độ</Label>
                  <Input
                    id="hdriExposure"
                    type="number"
                    min={0}
                    max={3}
                    step={0.05}
                    value={config.hdriExposure}
                    onChange={(e) =>
                      updateConfig({
                        hdriExposure: Math.min(3, Math.max(0, parseFloat(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 3 (default: 1.0)</p>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="hdriRotationX">Hướng X (Dọc)</Label>
                    <span className="text-xs text-muted-foreground">{config.hdriRotationX}°</span>
                  </div>
                  <input
                    id="hdriRotationX"
                    type="range"
                    min={0}
                    max={360}
                    step={1}
                    value={config.hdriRotationX}
                    onChange={(e) =>
                      updateConfig({ hdriRotationX: parseFloat(e.target.value) })
                    }
                    className="w-full accent-primary"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="hdriRotationY">Hướng Y (Ngang)</Label>
                    <span className="text-xs text-muted-foreground">{config.hdriRotationY}°</span>
                  </div>
                  <input
                    id="hdriRotationY"
                    type="range"
                    min={0}
                    max={360}
                    step={1}
                    value={config.hdriRotationY}
                    onChange={(e) =>
                      updateConfig({ hdriRotationY: parseFloat(e.target.value) })
                    }
                    className="w-full accent-primary"
                  />
                </div>
              </div>
            </CollapsibleCard>

            {/* Lighting & Environment — hidden (using HDRI instead)
            <CollapsibleCard
              title="Lighting & Environment"
              icon={<Lightbulb className="h-4 w-4 text-primary" />}
            >
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ambientLight">Ambient Light</Label>
                  <Input
                    id="ambientLight"
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    value={config.ambientLight}
                    onChange={(e) =>
                      updateConfig({
                        ambientLight: Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 2 (default: 0.55)</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hemisphereLight">Hemisphere Light</Label>
                  <Input
                    id="hemisphereLight"
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    value={config.hemisphereLight}
                    onChange={(e) =>
                      updateConfig({
                        hemisphereLight: Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 2 (default: 0.4)</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="clearcoat">Clearcoat</Label>
                  <Input
                    id="clearcoat"
                    type="number"
                    min={0}
                    max={100}
                    value={config.clearcoat}
                    onChange={(e) =>
                      updateConfig({
                        clearcoat: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">Độ chi tiết - 0 to 100 (default: 5)</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="bodyRoughness">Body Roughness</Label>
                  <Input
                    id="bodyRoughness"
                    type="number"
                    min={0}
                    max={255}
                    value={config.bodyRoughness}
                    onChange={(e) =>
                      updateConfig({
                        bodyRoughness: Math.min(255, Math.max(0, parseInt(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">Độ bóng thân gậy - 0 to 255 (default: 50)</p>
                </div>
              </div>
            </CollapsibleCard>
            */}

            {/* Leather Cylinder Config — DISABLED: using original GLB material (may re-enable later)
            <CollapsibleCard
              title="Leather Cylinder"
              icon={<Palette className="h-4 w-4 text-primary" />}
            >
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cylinderRoughness">Roughness</Label>
                  <Input
                    id="cylinderRoughness"
                    type="number"
                    min={0}
                    max={255}
                    step={1}
                    value={config.cylinderRoughness}
                    onChange={(e) =>
                      updateConfig({
                        cylinderRoughness: Math.min(255, Math.max(0, parseInt(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 255 (default: 102)</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cylinderClearcoat">Clearcoat</Label>
                  <Input
                    id="cylinderClearcoat"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={config.cylinderClearcoat}
                    onChange={(e) =>
                      updateConfig({
                        cylinderClearcoat: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 100 (default: 10)</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cylinderMetalness">Metalness</Label>
                  <Input
                    id="cylinderMetalness"
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={config.cylinderMetalness}
                    onChange={(e) =>
                      updateConfig({
                        cylinderMetalness: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 1 (default: 0)</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cylinderColor">Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      id="cylinderColor"
                      type="color"
                      value={config.cylinderColor}
                      onChange={(e) => updateConfig({ cylinderColor: e.target.value })}
                      className="w-10 h-10 rounded border cursor-pointer"
                    />
                    <Input
                      type="text"
                      value={config.cylinderColor}
                      onChange={(e) => updateConfig({ cylinderColor: e.target.value })}
                      className="flex-1"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">Hex color (default: #1A1A1A)</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cylinderNormalScale">Texture Depth</Label>
                  <Input
                    id="cylinderNormalScale"
                    type="number"
                    min={0}
                    max={10}
                    step={0.1}
                    value={config.cylinderNormalScale}
                    onChange={(e) =>
                      updateConfig({
                        cylinderNormalScale: Math.min(10, Math.max(0, parseFloat(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 10 (default: 1.0) — Normal map intensity</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cylinderSheen">Sheen</Label>
                  <Input
                    id="cylinderSheen"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={config.cylinderSheen}
                    onChange={(e) =>
                      updateConfig({
                        cylinderSheen: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 100 (default: 0) — Leather sheen highlight</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cylinderSheenColor">Sheen Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      id="cylinderSheenColor"
                      type="color"
                      value={config.cylinderSheenColor}
                      onChange={(e) => updateConfig({ cylinderSheenColor: e.target.value })}
                      className="w-10 h-10 rounded border cursor-pointer"
                    />
                    <Input
                      type="text"
                      value={config.cylinderSheenColor}
                      onChange={(e) => updateConfig({ cylinderSheenColor: e.target.value })}
                      className="flex-1"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">Hex color (default: #FFFFFF)</p>
                </div>
              </div>
            </CollapsibleCard>
            */}

            {/* Joint Top Config */}
            <CollapsibleCard
              title="Khớp đầu"
              icon={<Settings className="h-4 w-4 text-primary" />}
            >
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="jointRoughness">Độ nhám</Label>
                  <Input
                    id="jointRoughness"
                    type="number"
                    min={0}
                    max={255}
                    step={1}
                    value={config.jointRoughness}
                    onChange={(e) =>
                      updateConfig({
                        jointRoughness: Math.min(255, Math.max(0, parseInt(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 255 (default: 255)</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="jointClearcoat">Độ bóng</Label>
                  <Input
                    id="jointClearcoat"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={config.jointClearcoat}
                    onChange={(e) =>
                      updateConfig({
                        jointClearcoat: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 100 (default: 0)</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="jointMetalness">Độ kim loại</Label>
                  <Input
                    id="jointMetalness"
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={config.jointMetalness}
                    onChange={(e) =>
                      updateConfig({
                        jointMetalness: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">0 - 1 (default: 1)</p>
                </div>
              </div>
            </CollapsibleCard>

            {/* TEMP: Leather options disabled - ver2 model has baked-in leather */}
            {/* {product.type === "leather" && (
              <>
                <CollapsibleCard
                  title="Leather Options"
                  icon={<Palette className="h-4 w-4 text-primary" />}
                >
                  <LeatherPicker
                    textureType={product.texture_type || "crocodile"}
                    color={product.color || "black"}
                    onTextureChange={(texture) =>
                      updateProduct({ texture_type: texture })
                    }
                    onColorChange={(color) => updateProduct({ color })}
                    onCustomTextureSelect={handleCustomTextureSelect}
                    customTexturePending={pendingFiles.customTexture?.file}
                    customTexturePreview={pendingFiles.customTexture?.preview}
                    uploading={uploading && !!pendingFiles.customTexture}
                  />
                </CollapsibleCard>

                <CollapsibleCard
                  title="Material Settings"
                  icon={<Settings className="h-4 w-4 text-primary" />}
                >
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="leatherRoughness">Roughness</Label>
                      <Input
                        id="leatherRoughness"
                        type="number"
                        min={0}
                        max={255}
                        value={config.leatherRoughness}
                        onChange={(e) =>
                          updateConfig({
                            leatherRoughness: Math.min(255, Math.max(0, parseInt(e.target.value) || 0)),
                          })
                        }
                      />
                      <p className="text-xs text-muted-foreground">Độ bóng mượt của gậy - 0 to 255 (default: 120)</p>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="normalStrength">Normal Strength</Label>
                      <Input
                        id="normalStrength"
                        type="number"
                        min={0}
                        max={10}
                        step={0.1}
                        value={config.normalStrength}
                        onChange={(e) =>
                          updateConfig({
                            normalStrength: Math.min(10, Math.max(0, parseFloat(e.target.value) || 0)),
                          })
                        }
                      />
                      <p className="text-xs text-muted-foreground">Mật độ vân da sần sùi - 0 to 10 (default: 3.0)</p>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="textureScale">Texture Scale</Label>
                      <Input
                        id="textureScale"
                        type="number"
                        min={1}
                        max={8}
                        value={config.textureScale}
                        onChange={(e) =>
                          updateConfig({
                            textureScale: Math.min(8, Math.max(1, parseInt(e.target.value) || 1)),
                          })
                        }
                      />
                      <p className="text-xs text-muted-foreground">Độ chi tiết vân da - 1 to 8 (1=lớn, 8=nhỏ & dày đặc)</p>
                    </div>
                  </div>
                </CollapsibleCard>
              </>
            )} */}

            {/* Copy JSON Metadata */}
            <CollapsibleCard
              title="Xuất"
              icon={<Copy className="h-4 w-4 text-primary" />}
            >
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Sao chép toàn bộ cấu hình dưới dạng JSON để tích hợp metafield Shopify.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyJsonMetadata}
                  className="w-full"
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4" />
                      Đã sao chép!
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      Sao chép JSON Metadata
                    </>
                  )}
                </Button>
              </div>
            </CollapsibleCard>
          </div>
        </div>
      </div>

      {/* Extractor Dialogs */}
      <ImageExtractor
        sceneManager={sceneManager}
        productName={product.name}
        open={showImageExtractor}
        onClose={() => setShowImageExtractor(false)}
      />
      <VideoStudio
        sceneManager={sceneManager}
        productName={product.name}
        productId={product.id}
        open={showVideoExtractor}
        onClose={() => setShowVideoExtractor(false)}
      />
    </div>
  );
}
