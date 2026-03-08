"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { SceneManager, type SurfaceOptions } from "@/lib/three/scene-manager";
import type { Product, ProductConfig } from "@/types/product";
import { MODEL_PATHS } from "@/types/product";
import type { ThreeJSSettings } from "@/types/settings";

interface CuePreviewProps {
  product: Product;
  config?: ProductConfig;
  settings?: ThreeJSSettings;
  onSceneReady?: (manager: SceneManager) => void;
}

export function CuePreview({ product, config, settings, onSceneReady }: CuePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Use state for manager so React properly tracks it
  const [manager, setManager] = useState<SceneManager | null>(null);
  
  // Track the surface key that has been applied to avoid duplicate applies
  const appliedSurfaceKeyRef = useRef<string | null>(null);
  
  // Ref to track current product for use in async callbacks
  const productRef = useRef(product);
  const configRef = useRef(config);
  // Keep ref in sync during render (immediate update)
  productRef.current = product;
  configRef.current = config;
  
  // Helper to create surface key (include textureScale)
  const getSurfaceKey = useCallback((p: Product, c?: ProductConfig) => 
    `${p.surface_url}|${p.color}|${p.texture_type}|${c?.textureScale ?? 1}`, []);
  
  // Helper to create surface options
  const getSurfaceOptions = useCallback((p: Product, c?: ProductConfig): SurfaceOptions => ({
    surfaceUrl: p.surface_url,
    productType: p.type,
    leatherColor: p.color,
    leatherTexture: p.texture_type,
    textureScale: c?.textureScale ?? 1,
  }), []);

  // Initialize scene ONCE on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let localManager: SceneManager | null = null;
    // Capture container for async function (TypeScript narrowing)
    const containerElement = container;

    async function initScene() {
      try {
        setLoading(true);
        setError(null);

        console.log("[CuePreview] Creating SceneManager...");
        
        // Create scene manager
        localManager = new SceneManager(containerElement, settings);
        
        // Check if we were disposed during async operations
        if (disposed) {
          console.log("[CuePreview] Disposed during init, cleaning up");
          localManager.dispose();
          return;
        }

        // Load model based on product type (use ref for latest value)
        const modelPath = MODEL_PATHS[productRef.current.type];
        console.log("[CuePreview] Loading model:", modelPath);
        await localManager.loadModel(modelPath);

        if (disposed) {
          console.log("[CuePreview] Disposed during model load, cleaning up");
          localManager.dispose();
          localManager = null;
          return;
        }

        // Apply default/initial surface (from server-rendered product)
        // Use productRef.current to get the latest product state
        const currentProduct = productRef.current;
        const currentConfig = configRef.current;
        const initialOptions = getSurfaceOptions(currentProduct, currentConfig);
        console.log("[CuePreview] Applying initial surface:", initialOptions);
        await localManager.applySurface(initialOptions);
        appliedSurfaceKeyRef.current = getSurfaceKey(currentProduct, currentConfig);
        console.log("[CuePreview] Initial surface applied, key:", appliedSurfaceKeyRef.current);

        if (disposed) {
          console.log("[CuePreview] Disposed during surface apply, cleaning up");
          localManager.dispose();
          localManager = null;
          return;
        }

        // Set manager state - this triggers re-render and enables surface effect
        setManager(localManager);

        // Notify parent
        console.log("[CuePreview] Scene ready, notifying parent");
        onSceneReady?.(localManager);

        setLoading(false);
      } catch (err) {
        console.error("[CuePreview] Failed to initialize 3D scene:", err);
        if (!disposed) {
          setError(err instanceof Error ? err.message : "Failed to load 3D preview");
          setLoading(false);
        }
      }
    }

    initScene();

    return () => {
      console.log("[CuePreview] Cleanup - disposing manager");
      disposed = true;
      if (localManager) {
        localManager.dispose();
      }
      setManager(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount/unmount

  // Apply surface when manager is ready AND product surface properties change
  useEffect(() => {
    if (!manager) {
      console.log("[CuePreview] Surface effect: manager not ready");
      return;
    }

    const currentKey = getSurfaceKey(product, config);
    const appliedKey = appliedSurfaceKeyRef.current;
    
    console.log("[CuePreview] Surface effect check:", { 
      currentKey, 
      appliedKey, 
      surfaceUrl: product.surface_url,
      textureScale: config?.textureScale,
      hasManager: !!manager 
    });
    
    // Apply if the current surface differs from what's already applied
    if (currentKey !== appliedKey) {
      console.log("[CuePreview] Applying surface change:", product.surface_url, "scale:", config?.textureScale);
      const options = getSurfaceOptions(product, config);
      appliedSurfaceKeyRef.current = currentKey;
      manager.applySurface(options).catch(console.error);
    }
  }, [product.surface_url, product.color, product.texture_type, product.type, config?.textureScale, manager, getSurfaceKey, getSurfaceOptions]);

  const handleRetry = () => {
    if (manager) {
      manager.dispose();
    }
    setManager(null);
    setError(null);
    setLoading(true);
    // Force re-mount by changing key in parent, or trigger re-init
    window.location.reload();
  };

  return (
    <div className="relative w-full h-full touch-none">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ minHeight: "250px" }}
      />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="text-center text-foreground">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-foreground mx-auto mb-4" />
            <p>Loading 3D Preview...</p>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/95">
          <div className="text-center text-foreground p-4">
            <div className="text-4xl mb-4">⚠️</div>
            <p className="text-destructive">{error}</p>
            <button
              onClick={handleRetry}
              className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
