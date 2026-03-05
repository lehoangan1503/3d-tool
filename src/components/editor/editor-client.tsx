"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CuePreview } from "@/components/editor/cue-preview";
import { LeatherPicker } from "@/components/editor/leather-picker";
import { SurfaceUploader } from "@/components/editor/surface-uploader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CollapsibleCard } from "@/components/ui/collapsible-card";
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
} from "lucide-react";
import type { Product, ProductConfig, LeatherColor, LeatherTextureType } from "@/types/product";
import { DEFAULT_PRODUCT_CONFIG, configToSettingsJson } from "@/types/product";
import type { SceneManager } from "@/lib/three/scene-manager";

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
  const [pendingFiles, setPendingFiles] = useState<PendingFiles>({
    surface: null,
    customTexture: null,
  });

  // Ref to access current config in callbacks
  const configRef = useRef(config);
  configRef.current = config;
  
  // Ref to access current product in callbacks
  const productRef = useRef(product);
  productRef.current = product;

  // Unsaved changes warning
  const { confirmNavigation } = useUnsavedChangesWarning(hasChanges);

  const handleSceneReady = useCallback((manager: SceneManager) => {
    console.log("[EditorClient] handleSceneReady called");
    setSceneManager(manager);
    // Apply config to the scene immediately (from DB or defaults)
    // This ensures material values match UI state
    const currentConfig = configRef.current;
    const currentProduct = productRef.current;
    manager.updateLighting(currentConfig.ambientLight, currentConfig.hemisphereLight);
    manager.updateClearcoat(currentConfig.clearcoat);
    manager.updateBodyRoughness(currentConfig.bodyRoughness);
    if (currentProduct.type === "leather") {
      manager.updateLeatherConfig({
        roughness: currentConfig.leatherRoughness,
        sheen: currentConfig.leatherSheen,
        normalStrength: currentConfig.normalStrength,
      });
    }
    console.log("[EditorClient] Initial config applied:", currentConfig);
  }, []);

  // Update 3D scene when config changes
  useEffect(() => {
    if (!sceneManager) {
      console.log("[EditorClient] useEffect: sceneManager not ready");
      return;
    }

    console.log("[EditorClient] Applying config to scene:", config);

    // Update lighting
    sceneManager.updateLighting(config.ambientLight, config.hemisphereLight);

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
  }, [sceneManager, config, product.type]);

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

  const uploadFile = async (
    file: File,
    fileType: "surface" | "texture"
  ): Promise<string> => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("productId", product.id);
    formData.append("fileType", fileType);

    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Upload failed");
    }

    const { url } = await res.json();
    return url;
  };

  const handleSave = async () => {
    setSaving(true);
    setUploading(true);

    try {
      let surfaceUrl = product.surface_url;
      let textureUrl = product.texture_url;

      // Upload pending surface file
      if (pendingFiles.surface) {
        surfaceUrl = await uploadFile(pendingFiles.surface.file, "surface");
      }

      // Upload pending custom texture file
      if (pendingFiles.customTexture) {
        textureUrl = await uploadFile(pendingFiles.customTexture.file, "texture");
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
      alert("Failed to save changes");
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
    const metadata = {
      type: product.type,
      surface_url: product.surface_url,
      texture_type: product.texture_type,
      texture_url: product.texture_url,
      color: product.color,
      config: {
        lighting: {
          ambient: config.ambientLight,
          hemisphere: config.hemisphereLight,
          clearcoat: config.clearcoat,
          bodyRoughness: config.bodyRoughness,
        },
        leather: product.type === "leather" ? {
          roughness: config.leatherRoughness,
          sheen: config.leatherSheen,
          normalStrength: config.normalStrength,
        } : undefined,
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
      <header className="bg-card/80 backdrop-blur-sm border-b px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" onClick={handleBackClick}>
            <Button variant="ghost" size="icon" className="shrink-0">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div className="min-w-0">
            <Input
              value={product.name}
              onChange={(e) => updateProduct({ name: e.target.value })}
              className="font-semibold text-lg border-none shadow-none px-0 h-auto focus-visible:ring-0 bg-transparent truncate"
            />
            <p className="text-sm text-muted-foreground capitalize">
              {product.type} cue
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleBackground}
            title={isDarkBg ? "Light background" : "Dark background"}
          >
            {isDarkBg ? (
              <Sun className="h-5 w-5" />
            ) : (
              <Moon className="h-5 w-5" />
            )}
          </Button>
          <Button onClick={handleSave} disabled={saving || !hasChanges}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {uploading ? "Uploading..." : "Saving..."}
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                Save
              </>
            )}
          </Button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* 3D Preview */}
        <div className="flex-1 relative min-w-0">
          <CuePreview key={product.id} product={product} config={config} onSceneReady={handleSceneReady} />
        </div>

        {/* Sidebar */}
        <div className="w-80 shrink-0 bg-card border-l overflow-y-auto">
          <div className="p-4 flex flex-col gap-4">
            {/* 3D Controls - Moved to top */}
            <CollapsibleCard
              title="3D Controls"
              icon={<Info className="h-4 w-4 text-primary" />}
              defaultExpanded={true}
            >
              <div className="text-sm text-muted-foreground">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span>Rotate</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs bg-background px-2 py-0.5 rounded">
                        Left-click + drag
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={toggleAutoRotate}
                        className="h-7 px-2"
                        title={isAutoRotating ? "Pause auto-rotation" : "Start auto-rotation"}
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
                    <span>Zoom</span>
                    <span className="text-xs bg-background px-2 py-0.5 rounded">
                      Scroll wheel
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Pan</span>
                    <span className="text-xs bg-background px-2 py-0.5 rounded">
                      Right-click + drag
                    </span>
                  </div>
                </div>
              </div>
            </CollapsibleCard>

            {/* Surface Upload */}
            <CollapsibleCard
              title="Surface"
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

            {/* Lighting Configuration */}
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

            {/* Leather Material Settings (only for leather type) */}
            {product.type === "leather" && (
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
            )}

            {/* Copy JSON Metadata */}
            <CollapsibleCard
              title="Export"
              icon={<Copy className="h-4 w-4 text-primary" />}
            >
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Copy all configuration as JSON for Shopify metafield integration.
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
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      Copy JSON Metadata
                    </>
                  )}
                </Button>
              </div>
            </CollapsibleCard>
          </div>
        </div>
      </div>
    </div>
  );
}
