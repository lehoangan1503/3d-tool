"use client";

import * as THREE from "three";
import { useEffect, useRef, useState, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronsUpDown } from "lucide-react";
import { SceneViewControls, type SelectionInfo } from "./video-studio/scene-view-controls";
import type { CueShadowConfig, HdriLayer } from "@/types/extractor";
import { createDefaultHdriLayer, DEFAULT_CUE_SHADOW, STUDIO_WHITE_HDRI } from "@/types/extractor";
import type { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { ExtractorSceneManager as ESMClass, HDRI_OPTIONS_FALLBACK } from "@/lib/three/extractor-scene-manager";
import type { VideoStudioConfig, CameraKeyframe } from "@/types/video-studio";
import { DEFAULT_STUDIO_CONFIG, DEFAULT_CUE_HDRI } from "@/types/video-studio";
import { forceWhiteWalls } from "@/lib/three/studio-helpers";
import { Lightbulb, Move, RotateCcw, Maximize2, Loader2, Download, FileUp, CheckCircle2, XCircle, Eye, EyeOff, Pencil, Trash2, Check, X, Undo2, Redo2, Sun, ChevronDown, ChevronUp, Plus } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ─── Shadow Template type ────────────────────────────────────────────────────
interface ShadowTemplate {
  id: string;
  name: string;
  config: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface ShadowTemplateListResponse {
  items?: ShadowTemplate[];
  unavailable?: boolean;
}

const LOCAL_SHADOW_TEMPLATES_KEY = "cue-shadow-templates-v1";

function parseShadowTemplateList(payload: unknown): { items: ShadowTemplate[] } {
  if (Array.isArray(payload)) return { items: payload as ShadowTemplate[] };
  if (payload && typeof payload === "object") {
    const data = payload as ShadowTemplateListResponse;
    const items = Array.isArray(data.items) ? data.items : [];
    return { items };
  }
  return { items: [] };
}

function loadLocalShadowTemplates(): ShadowTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_SHADOW_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ShadowTemplate[]) : [];
  } catch {
    return [];
  }
}


// ─── Constants ────────────────────────────────────────────────────────────────
const CAPTURE_SIZE = 2048;
const PREVIEW_CANVAS_SIZE = 512;

/** Axis label colors matching Three.js TransformControls (R=X, G=Y, B=Z) */
const AXIS_COLORS: Record<string, string> = { X: "#ff4444", Y: "#44bb44", Z: "#4488ff" };

const MODE_LABELS_VN: Record<string, string> = {
  translate: "Di chuyển",
  rotate: "Xoay",
  scale: "Tỷ lệ",
};

const SELECTION_LABELS_VN: Record<string, string> = {
  camera: "Camera",
  cue: "Mô hình",
  wall: "Tường",
  table: "Bàn",
  wallFrame: "Khung tường",
  tableFrame: "Khung bàn",
  hdriLight: "Đèn",
};

/** Build a white-studio config, restoring from a saved snapshot if available */
function buildWhiteStudioConfig(shadowCfg: CueShadowConfig): VideoStudioConfig {
  if (shadowCfg.studioConfigSnapshot) {
    // Restore from saved snapshot — just sync shadow intensity/blur
    const snap = structuredClone(shadowCfg.studioConfigSnapshot);
    snap.shadow = { ...snap.shadow, intensity: shadowCfg.intensity, blur: shadowCfg.blur };
    // Migrate old snapshots that only have cueHdri (no cueHdriLayers)
    if (!snap.cueHdriLayers || snap.cueHdriLayers.length === 0) {
      const legacy = snap.cueHdri ?? DEFAULT_CUE_HDRI;
      snap.cueHdriLayers = [{
        id: crypto.randomUUID(),
        hdriType: legacy.hdriType,
        rotationX: legacy.rotationX,
        rotationY: legacy.rotationY,
        intensity: legacy.intensity,
        enabled: true,
      }];
    }
    return snap;
  }
  const defaultLayer = createDefaultHdriLayer();
  defaultLayer.rotationY = DEFAULT_CUE_HDRI.rotationY;
  return {
    ...structuredClone(DEFAULT_STUDIO_CONFIG),
    wallSurface: { texturePreset: "white_studio", envMapIntensity: 0, frames: [] },
    tableSurface: { texturePreset: "white_studio", envMapIntensity: 0, frames: [] },
    hdriConfig: { layers: [createDefaultHdriLayer(STUDIO_WHITE_HDRI)] },
    hdriIntensity: 0,
    cueHdri: { ...DEFAULT_CUE_HDRI },
    cueHdriLayers: [defaultLayer],
    shadow: {
      enabled: true,
      intensity: shadowCfg.intensity,
      blur: shadowCfg.blur,
      softness: 0.5,
      offsetX: 0,
      offsetY: 0,
    },
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface TransformValues {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}



// ─── Undo/Redo history entry ──────────────────────────────────────────────────
interface ShadowHistoryEntry {
  studioConfig: VideoStudioConfig;
  intensity: number;
  blur: number;
  wallsTransparent: boolean;
}

interface ShadowSimulateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shadowConfig: CueShadowConfig;
  onConfigChange: (cfg: CueShadowConfig) => void;
  onSave: (cfg: CueShadowConfig) => void;
  extractorRef: React.MutableRefObject<ExtractorSceneManager | null>;
  cueSettings: { phi: number; zoom: number; offsetX: number; offsetY: number; spinY: number };
}

function TransformInput({ label, value, onChange, suffix = "" }: { label: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  const color = AXIS_COLORS[label] ?? undefined;
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-bold w-3 shrink-0" style={color ? { color } : undefined}>
        {label}
      </span>
      <input
        type="number"
        step="0.1"
        value={parseFloat(value.toFixed(2))}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(v);
        }}
        className="h-5 w-full rounded border border-border/50 bg-muted/30 px-1 text-[11px] font-mono tabular-nums text-foreground outline-none focus:border-blue-500/50"
      />
      {suffix && <span className="text-[10px] text-muted-foreground shrink-0">{suffix}</span>}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function ShadowSimulateDialog({ open, onOpenChange, shadowConfig, onConfigChange, onSave, extractorRef, cueSettings }: ShadowSimulateDialogProps) {
  // Local shadow config (edit in-dialog, save on confirm)
  const [localCfg, setLocalCfg] = useState<CueShadowConfig>(() => ({ ...shadowConfig }));
  const localCfgRef = useRef(localCfg);
  useEffect(() => {
    localCfgRef.current = localCfg;
  }, [localCfg]);

  const [sceneReady, setSceneReady] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const didApplyRef = useRef(false);

  const [wallsTransparent, setWallsTransparent] = useState(shadowConfig.wallsTransparent ?? false);

  // Template system
  const [templates, setTemplates] = useState<ShadowTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [showTemplateSaveChoiceDialog, setShowTemplateSaveChoiceDialog] = useState(false);
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false);
  const [showTemplateNameDialog, setShowTemplateNameDialog] = useState(false);
  const [templateNameInput, setTemplateNameInput] = useState("");
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const saveMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Selection & transform display
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo>({ type: null });
  const [transformValues, setTransformValues] = useState<TransformValues | null>(null);
  const [transformMode, setTransformMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [hotkeyAxis, setHotkeyAxis] = useState<"x" | "y" | "z" | null>(null);

  // Undo/redo
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const shadowHistoryRef = useRef<ShadowHistoryEntry[]>([]);
  const shadowFutureRef = useRef<ShadowHistoryEntry[]>([]);
  const isDraggingRef = useRef(false);
  const wallsTransparentRef = useRef(shadowConfig.wallsTransparent ?? false);

  // HDRI Cơ panel — React state mirrors configRef.current.cueHdriLayers for reactive display
  const [cueHdriOpen, setCueHdriOpen] = useState(false);
  const [cueHdriLayersState, setCueHdriLayersState] = useState<HdriLayer[]>(() =>
    buildWhiteStudioConfig(shadowConfig).cueHdriLayers ?? []
  );

  // Refs — studioConfig is a REF (not state) to avoid React re-renders during drag/slider
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const esmRef = useRef<ESMClass | null>(null);
  const sceneViewRef = useRef<SceneViewControls | null>(null);
  const configRef = useRef<VideoStudioConfig>(buildWhiteStudioConfig(shadowConfig));
  const onConfigChangeRef = useRef(onConfigChange);
  useEffect(() => {
    onConfigChangeRef.current = onConfigChange;
  }, [onConfigChange]);
  const configSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ─── Debounced ESM config push (no React state, no re-render) ──────────────
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleConfigUpdate = useCallback(() => {
    if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    updateTimerRef.current = setTimeout(() => {
      esmRef.current?.updateStudioPreviewConfig(configRef.current);
      updateTimerRef.current = null;
    }, 80);
  }, []);

  // Keep wallsTransparentRef in sync for use in snapshot callbacks
  useEffect(() => {
    wallsTransparentRef.current = wallsTransparent;
  }, [wallsTransparent]);

  // ─── Undo/Redo helpers ────────────────────────────────────────────────────
  const updateHistoryState = useCallback(() => {
    setCanUndo(shadowHistoryRef.current.length > 1);
    setCanRedo(shadowFutureRef.current.length > 0);
  }, []);

  const snapshotNow = useCallback((overrides?: Partial<ShadowHistoryEntry>) => {
    const entry: ShadowHistoryEntry = {
      studioConfig: structuredClone(configRef.current),
      intensity: localCfgRef.current.intensity,
      blur: localCfgRef.current.blur,
      wallsTransparent: wallsTransparentRef.current,
      ...overrides,
    };
    shadowHistoryRef.current = [...shadowHistoryRef.current.slice(-49), entry];
    shadowFutureRef.current = [];
    updateHistoryState();
  }, [updateHistoryState]);

  const applyHistoryEntry = useCallback((entry: ShadowHistoryEntry) => {
    configRef.current = structuredClone(entry.studioConfig);
    localCfgRef.current = { ...localCfgRef.current, intensity: entry.intensity, blur: entry.blur };
    setLocalCfg(localCfgRef.current);
    setCueHdriLayersState(configRef.current.cueHdriLayers ?? []);
    wallsTransparentRef.current = entry.wallsTransparent;
    setWallsTransparent(entry.wallsTransparent);
    const esm = esmRef.current;
    if (esm) {
      esm.setWallsVisible(!entry.wallsTransparent);
      esm.setTransparentBackground(entry.wallsTransparent);
      esm.updateStudioPreviewConfig(configRef.current);
      esm.forcePreviewUpdate();
    }
  }, []);

  const undo = useCallback(() => {
    if (shadowHistoryRef.current.length <= 1) return;
    const current = shadowHistoryRef.current[shadowHistoryRef.current.length - 1];
    shadowFutureRef.current = [current, ...shadowFutureRef.current.slice(0, 49)];
    shadowHistoryRef.current = shadowHistoryRef.current.slice(0, -1);
    const prev = shadowHistoryRef.current[shadowHistoryRef.current.length - 1];
    applyHistoryEntry(prev);
    updateHistoryState();
  }, [applyHistoryEntry, updateHistoryState]);

  const redo = useCallback(() => {
    if (shadowFutureRef.current.length === 0) return;
    const next = shadowFutureRef.current[0];
    shadowFutureRef.current = shadowFutureRef.current.slice(1);
    shadowHistoryRef.current = [...shadowHistoryRef.current, next];
    applyHistoryEntry(next);
    updateHistoryState();
  }, [applyHistoryEntry, updateHistoryState]);

  // Ctrl+Z / Ctrl+Shift+Z keyboard handler
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, undo, redo]);

  // Initialize config only on open transition (NOT on every shadowConfig change)
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      didApplyRef.current = false;
      const initCfg = buildWhiteStudioConfig(shadowConfig);
      localCfgRef.current = { ...shadowConfig };
      setLocalCfg(localCfgRef.current);
      configRef.current = initCfg;
      setCueHdriLayersState(initCfg.cueHdriLayers ?? []);
      setSelectionInfo({ type: null });
      setTransformValues(null);
      const initWalls = shadowConfig.wallsTransparent ?? false;
      wallsTransparentRef.current = initWalls;
      setWallsTransparent(initWalls);
      setSelectedTemplateId(null);
      // Seed undo history with the initial state
      shadowHistoryRef.current = [{
        studioConfig: structuredClone(initCfg),
        intensity: shadowConfig.intensity,
        blur: shadowConfig.blur,
        wallsTransparent: initWalls,
      }];
      shadowFutureRef.current = [];
      setCanUndo(false);
      setCanRedo(false);
      isDraggingRef.current = false;
    }
    prevOpenRef.current = open;
  }, [open, shadowConfig]);

  useEffect(() => {
    if (open) return;
    setShowTemplateSaveChoiceDialog(false);
    setShowTemplateNameDialog(false);
    setTemplateNameInput("");
  }, [open]);

  useEffect(() => {
    return () => {
      if (configSyncTimerRef.current) {
        clearTimeout(configSyncTimerRef.current);
        configSyncTimerRef.current = null;
      }
    };
  }, []);

  // ─── Sync shadow sliders → config ref (no state, just ref + push) ──────────
  useEffect(() => {
    const cfg = configRef.current;
    cfg.shadow = { ...cfg.shadow, intensity: localCfg.intensity, blur: localCfg.blur };
    scheduleConfigUpdate();
  }, [localCfg.intensity, localCfg.blur, scheduleConfigUpdate]);

  // ─── Sync transparent walls mode → ESM ─────────────────────────────────────
  useEffect(() => {
    if (!sceneReady || !esmRef.current) return;
    esmRef.current.setWallsVisible(!wallsTransparent);
    esmRef.current.setTransparentBackground(wallsTransparent);
    esmRef.current.forcePreviewUpdate();
  }, [wallsTransparent, sceneReady]);

  const resetShadowPlaneToFollowLight = useCallback((_cfg: VideoStudioConfig): boolean => {
    // Shadow position is driven purely by 3D light angles; no manual override to reset.
    return false;
  }, []);

  // ─── Fetch shadow config templates ──────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadTemplates = async () => {
      try {
        const res = await fetch("/api/shadow-config-templates?limit=100");
        const payload: unknown = res.ok ? await res.json() : null;
        const { items } = parseShadowTemplateList(payload);
        if (cancelled) return;
        setTemplates(res.ok ? items : loadLocalShadowTemplates());
      } catch {
        if (cancelled) return;
        setTemplates(loadLocalShadowTemplates());
      }
    };
    loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ─── Scene Setup ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;

    const sourceEsm = extractorRef.current;
    if (!sourceEsm) return;

    const sourcePreviewWasRunning = sourceEsm.isLivePreviewRunning();
    sourceEsm.stopLivePreview();

    // Minimize source ESM renderer to free GPU memory (1x1 framebuffer)
    const srcCanvas = sourceEsm.getCanvas();
    const srcW = srcCanvas?.width ?? 0;
    const srcH = srcCanvas?.height ?? 0;
    if (srcW > 1 || srcH > 1) sourceEsm.resize(1, 1);

    let sceneViewAnimId: number | null = null;

    const setup = async () => {
      const model = sourceEsm.getModelClone();
      if (!model) return;

      const esm = new ESMClass();
      esmRef.current = esm;

      await esm.setModel(model);

      const hdriUrl = sourceEsm.getCurrentHdriUrl();
      if (hdriUrl) {
        try {
          await esm.loadHDRI(hdriUrl);
        } catch {
          /* non-critical */
        }
      }

      const canvas = esm.getCanvas();
      if (previewContainerRef.current && canvas) {
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.objectFit = "contain";
        previewContainerRef.current.innerHTML = "";
        previewContainerRef.current.appendChild(canvas);
        const rect = previewContainerRef.current.getBoundingClientRect();
        esm.resize(rect.width, rect.height);

        esm.initSceneView();
        sceneViewRef.current = new SceneViewControls(
          esm,
          canvas,
          // Camera change — persist to configRef so updateStudioPreviewConfig won't reset it
          (kf: CameraKeyframe) => {
            configRef.current = { ...configRef.current, cameraStart: { ...kf } };
          },
          () => configRef.current.cueConfig,
          // Selection change
          (info) => {
            setSelectionInfo(info);
            if (info.type && info.object) {
              const obj = info.object;
              setTransformValues({
                position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
                rotation: {
                  x: THREE.MathUtils.radToDeg(obj.rotation.x),
                  y: THREE.MathUtils.radToDeg(obj.rotation.y),
                  z: THREE.MathUtils.radToDeg(obj.rotation.z),
                },
                scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
              });
            } else {
              setTransformValues(null);
              setHotkeyAxis(null);
            }
          },
          // Object transform — update config ref directly (no setState for config!)
          (info, position, rotation, scale) => {
            setTransformValues({
              position: { x: position.x, y: position.y, z: position.z },
              rotation: {
                x: THREE.MathUtils.radToDeg(rotation.x),
                y: THREE.MathUtils.radToDeg(rotation.y),
                z: THREE.MathUtils.radToDeg(rotation.z),
              },
              scale: { x: scale.x, y: scale.y, z: scale.z },
            });

            const cfg = configRef.current;
            if (info.type === "camera") {
              const cfgWithCamera = {
                ...cfg,
                cameraStart: {
                  x: position.x,
                  y: position.y,
                  z: position.z,
                  rotationX: rotation.x,
                  rotationY: rotation.y,
                  rotationZ: rotation.z,
                },
              };
              configRef.current = cfgWithCamera;
              resetShadowPlaneToFollowLight(cfgWithCamera);
              // Don't scheduleConfigUpdate — camera is already moved via gizmo
            } else if (info.type === "cue") {
              const instances = [...cfg.cueConfig.instances];
              if (instances[0]) {
                instances[0] = {
                  ...instances[0],
                  positionX: position.x,
                  positionY: position.y,
                  positionZ: position.z,
                  scale: scale.x,
                };
              }
              configRef.current = {
                ...cfg,
                cueConfig: {
                  ...cfg.cueConfig,
                  instances,
                  spinX: rotation.x,
                  spinY: rotation.y,
                  spinZ: rotation.z,
                },
              };
              scheduleConfigUpdate();
            } else if (info.type === "hdriLight") {
              const ext = esmRef.current;
              if (ext) {
                resetShadowPlaneToFollowLight(cfg);
                const { rotationX: rotX, rotationY: rotY } = ext.positionToHdriRotation(position);
                const avgScale = (scale.x + scale.y + scale.z) / 3;
                const newIntensity = Math.max(0.1, Math.min(3, avgScale));

                // Use the numeric index (stable across config replacements) for the
                // layer lookup.  info.layerId may be stale if the user grabbed the
                // helper before the 80 ms ID-sync from a template load had fired.
                const layers = [...cfg.hdriConfig.layers];
                const layerIdx = (info.layerIndex !== undefined && info.layerIndex < layers.length)
                  ? info.layerIndex
                  : layers.findIndex((l) => l.id === info.layerId);

                // Push shadow-light movement immediately so the cast shadow tracks
                // the helper in real-time instead of waiting for the debounced update.
                ext.directUpdateShadowLight(layerIdx >= 0 ? layerIdx : 0, rotX, rotY, newIntensity);

                if (layerIdx >= 0) {
                  layers[layerIdx] = { ...layers[layerIdx], rotationX: rotX, rotationY: rotY, intensity: newIntensity };
                }
                configRef.current = { ...cfg, hdriConfig: { layers } };
                scheduleConfigUpdate();
              }
            }
          },
          // Transform mode change
          (mode) => {
            setTransformMode(mode);
            const state = sceneViewRef.current?.getHotkeyState();
            setHotkeyAxis(state?.axis ?? null);
          },
          // Drag start: suppress history until drag ends
          () => { isDraggingRef.current = true; },
          // Drag end: push snapshot so user can undo the drag
          () => {
            isDraggingRef.current = false;
            snapshotNow();
          }
        );
        sceneViewRef.current.setEnabled(true);
      }

      const cfg = configRef.current;
      await esm.setupStudioFromStudioConfig(cfg);
      forceWhiteWalls(esm);
      esm.updateStudioPreviewConfig(cfg);
      esm.setViewMode("scene");

      // Connect live preview canvas
      if (previewCanvasRef.current) {
        esm.setPreviewCanvas(previewCanvasRef.current, PREVIEW_CANVAS_SIZE);
      }

      setSceneReady(true);

      // Animation loop — full-rate for smooth OrbitControls damping (mirrors VideoStudio pattern)
      const animate = () => {
        if (!esmRef.current) return;
        sceneViewRef.current?.update();
        esmRef.current.render();
        sceneViewAnimId = requestAnimationFrame(animate);
      };
      sceneViewAnimId = requestAnimationFrame(animate);
    };

    setup();

    return () => {
      setSceneReady(false);
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
        updateTimerRef.current = null;
      }
      if (sceneViewAnimId) cancelAnimationFrame(sceneViewAnimId);
      sceneViewRef.current?.dispose();
      sceneViewRef.current = null;
      esmRef.current?.setPreviewCanvas(null);
      esmRef.current?.dispose();
      esmRef.current = null;

      // Restore source ESM renderer to original size
      const src = extractorRef.current;
      if (src) {
        if (srcW > 1 && srcH > 1) {
          src.resize(srcW, srcH);
        }
        if (sourcePreviewWasRunning && !didApplyRef.current) {
          src.startLivePreview();
        } else {
          src.render();
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, extractorRef, resetShadowPlaneToFollowLight]);

  // ─── Rebuild scene on shadow enabled toggle (rare, expensive) ──────────────
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastShadowEnabled = useRef(configRef.current.shadow.enabled);
  useEffect(() => {
    if (!esmRef.current || !open) return;
    const enabled = configRef.current.shadow.enabled;
    if (enabled === lastShadowEnabled.current) return;
    lastShadowEnabled.current = enabled;

    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(async () => {
      const esm = esmRef.current;
      if (!esm) return;
      sceneViewRef.current?.deselect();
      await esm.setupStudioFromStudioConfig(configRef.current);
      forceWhiteWalls(esm);
      esm.updateStudioPreviewConfig(configRef.current);
      esm.render();
      rebuildTimerRef.current = null;
    }, 500);
    return () => {
      if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    };
  }, [open]);

  // ─── Handlers ──────────────────────────────────────────────────────────────
  const handleSlider = useCallback((field: keyof CueShadowConfig, value: number) => {
    const next = { ...localCfgRef.current, [field]: value };
    localCfgRef.current = next;
    setLocalCfg(next);
    if (configSyncTimerRef.current) clearTimeout(configSyncTimerRef.current);
    configSyncTimerRef.current = setTimeout(() => {
      onConfigChangeRef.current(next);
      configSyncTimerRef.current = null;
    }, 150);
  }, []);

  const syncShadowStateToConfigRef = useCallback(() => {
    const cfg = configRef.current;
    cfg.shadow = {
      ...cfg.shadow,
      intensity: localCfgRef.current.intensity,
      blur: localCfgRef.current.blur,
    };
  }, []);

  /** Update a single cue HDRI layer (live slider/select change) */
  const handleCueHdriLayer = useCallback((idx: number, patch: Partial<HdriLayer>) => {
    const layers = (configRef.current.cueHdriLayers ?? []).map((l, i) =>
      i === idx ? { ...l, ...patch } : l
    );
    configRef.current = { ...configRef.current, cueHdriLayers: layers };
    setCueHdriLayersState(layers);
    scheduleConfigUpdate();
  }, [scheduleConfigUpdate]);

  /** Add a second HDRI layer (max 2) */
  const addCueHdriLayer = useCallback(() => {
    const layers = configRef.current.cueHdriLayers ?? [];
    if (layers.length >= 2) return;
    const newLayer = createDefaultHdriLayer();
    newLayer.rotationY = (layers[0]?.rotationY ?? 0 + 180) % 360;
    newLayer.intensity = 0.5;
    const updated = [...layers, newLayer];
    configRef.current = { ...configRef.current, cueHdriLayers: updated };
    setCueHdriLayersState(updated);
    scheduleConfigUpdate();
    snapshotNow();
  }, [scheduleConfigUpdate, snapshotNow]);

  /** Remove a cue HDRI layer (min 1) */
  const removeCueHdriLayer = useCallback((idx: number) => {
    const layers = configRef.current.cueHdriLayers ?? [];
    if (layers.length <= 1) return;
    const updated = layers.filter((_, i) => i !== idx);
    configRef.current = { ...configRef.current, cueHdriLayers: updated };
    setCueHdriLayersState(updated);
    scheduleConfigUpdate();
    snapshotNow();
  }, [scheduleConfigUpdate, snapshotNow]);

  /** Capture 2048×2048 clean production-camera frame (matches live preview) */
  const captureStudio = useCallback((): string | null => {
    const esm = esmRef.current;
    if (!esm) return null;
    sceneViewRef.current?.deselect();
    return esm.captureCleanFrame(CAPTURE_SIZE, "png", wallsTransparent);
  }, [wallsTransparent]);

  /** "Áp dụng lên gậy": capture → store in config → pass to caller */
  const handleApply = useCallback(async () => {
    if (configSyncTimerRef.current) {
      clearTimeout(configSyncTimerRef.current);
      configSyncTimerRef.current = null;
    }
    setIsSaving(true);
    try {
      syncShadowStateToConfigRef();
      const esm = esmRef.current;
      if (esm) {
        esm.updateStudioPreviewConfig(configRef.current);
        esm.render();
      }
      const dataUrl = captureStudio();
      const finalCfg: CueShadowConfig = {
        ...localCfgRef.current,
        wallsTransparent,
        studioCapture: dataUrl ?? undefined,
        studioConfigSnapshot: structuredClone(configRef.current),
      };
      didApplyRef.current = true;
      onSave(finalCfg);
    } finally {
      setIsSaving(false);
    }
  }, [captureStudio, onSave, wallsTransparent, syncShadowStateToConfigRef]);

  const buildTemplateConfig = useCallback(() => {
    syncShadowStateToConfigRef();
    return {
      intensity: localCfgRef.current.intensity,
      blur: localCfgRef.current.blur,
      studioConfigSnapshot: structuredClone(configRef.current),
    };
  }, [syncShadowStateToConfigRef]);

  const showSaveMsg = useCallback((ok: boolean, text: string) => {
    if (saveMsgTimerRef.current) clearTimeout(saveMsgTimerRef.current);
    setSaveMsg({ ok, text });
    saveMsgTimerRef.current = setTimeout(() => setSaveMsg(null), 3000);
  }, []);

  const refreshTemplateList = useCallback(async () => {
    try {
      const res = await fetch("/api/shadow-config-templates?limit=100");
      const payload: unknown = res.ok ? await res.json() : null;
      const { items } = parseShadowTemplateList(payload);
      setTemplates(res.ok ? items : []);
    } catch {
      // Leave list as-is on network error
    }
  }, []);

  const buildDefaultTemplateName = useCallback(() => `Mẫu bóng ${new Date().toLocaleDateString("vi-VN")}`, []);

  const openSaveNewTemplateDialog = useCallback(() => {
    setShowTemplateSaveChoiceDialog(false);
    setTemplateNameInput(buildDefaultTemplateName());
    setShowTemplateNameDialog(true);
  }, [buildDefaultTemplateName]);

  /** "Lưu cài đặt bóng": open in-app save dialog flow */
  const handleSaveTemplate = useCallback(() => {
    if (selectedTemplateId) {
      setShowTemplateSaveChoiceDialog(true);
      return;
    }
    openSaveNewTemplateDialog();
  }, [openSaveNewTemplateDialog, selectedTemplateId]);

  const handleUpdateSelectedTemplate = useCallback(async () => {
    if (!selectedTemplateId) return;
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (!tpl) return;

    const config = buildTemplateConfig();
    setIsSavingTemplate(true);
    try {
      const updateRes = await fetch(`/api/shadow-config-templates/${selectedTemplateId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (updateRes.ok) {
        await refreshTemplateList();
        showSaveMsg(true, "Đã lưu mẫu bóng");
      } else {
        showSaveMsg(false, "Lưu thất bại");
      }
      setShowTemplateSaveChoiceDialog(false);
    } catch {
      showSaveMsg(false, "Lỗi kết nối");
      setShowTemplateSaveChoiceDialog(false);
    } finally {
      setIsSavingTemplate(false);
    }
  }, [buildTemplateConfig, refreshTemplateList, selectedTemplateId, showSaveMsg, templates]);

  const handleSaveTemplateAsNew = useCallback(async () => {
    const name = templateNameInput.trim();
    if (!name) return;

    const config = buildTemplateConfig();
    setIsSavingTemplate(true);
    try {
      const res = await fetch("/api/shadow-config-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, config }),
      });
      if (res.ok) {
        const created: unknown = await res.json();
        const createdId = typeof created === "object" && created !== null && "id" in created ? String((created as { id: string }).id) : null;
        if (createdId) setSelectedTemplateId(createdId);
        await refreshTemplateList();
        showSaveMsg(true, "Đã lưu mẫu bóng mới");
      } else {
        showSaveMsg(false, "Lưu thất bại");
      }
      setShowTemplateNameDialog(false);
      setTemplateNameInput("");
    } catch {
      showSaveMsg(false, "Lỗi kết nối");
      setShowTemplateNameDialog(false);
    } finally {
      setIsSavingTemplate(false);
    }
  }, [buildTemplateConfig, refreshTemplateList, showSaveMsg, templateNameInput]);

  /** Apply a template to current session */
  const handleApplyTemplate = useCallback(
    (templateId: string) => {
      const tpl = templates.find((t) => t.id === templateId);
      if (!tpl) return;
      setSelectedTemplateId(templateId);

      const cfg = tpl.config as Record<string, unknown>;
      const intensity = typeof cfg.intensity === "number" ? cfg.intensity : localCfgRef.current.intensity;
      const blur = typeof cfg.blur === "number" ? cfg.blur : localCfgRef.current.blur;

      localCfgRef.current = { ...localCfgRef.current, intensity, blur };
      setLocalCfg(localCfgRef.current);

      // If template has a full studio snapshot, restore it
      if (cfg.studioConfigSnapshot && typeof cfg.studioConfigSnapshot === "object") {
        const snap = structuredClone(cfg.studioConfigSnapshot) as VideoStudioConfig;
        snap.shadow = { ...snap.shadow, intensity, blur };
        // Migrate old snapshots without cueHdriLayers
        if (!snap.cueHdriLayers || snap.cueHdriLayers.length === 0) {
          const legacy = snap.cueHdri ?? DEFAULT_CUE_HDRI;
          snap.cueHdriLayers = [{
            id: crypto.randomUUID(),
            hdriType: legacy.hdriType,
            rotationX: legacy.rotationX,
            rotationY: legacy.rotationY,
            intensity: legacy.intensity,
            enabled: true,
          }];
        }
        configRef.current = snap;
        setCueHdriLayersState(snap.cueHdriLayers ?? []);
        scheduleConfigUpdate();
      }

      snapshotNow({ intensity, blur });
    },
    [templates, scheduleConfigUpdate, snapshotNow]
  );

  /** Reset the whole simulator to factory defaults so the user can craft a new shadow template */
  const handleResetSimulator = useCallback(() => {
    const defaults = DEFAULT_CUE_SHADOW;
    localCfgRef.current = { ...localCfgRef.current, intensity: defaults.intensity, blur: defaults.blur };
    setLocalCfg(localCfgRef.current);
    wallsTransparentRef.current = false;
    setWallsTransparent(false);
    setSelectedTemplateId(null);
    const freshConfig = buildWhiteStudioConfig({ ...defaults, enabled: true });
    configRef.current = freshConfig;
    setCueHdriLayersState(freshConfig.cueHdriLayers ?? []);
    if (esmRef.current) {
      esmRef.current.setWallsVisible(true);
      esmRef.current.setTransparentBackground(false);
      esmRef.current.updateStudioPreviewConfig(freshConfig);
      esmRef.current.forcePreviewUpdate();
    }
    snapshotNow({ intensity: defaults.intensity, blur: defaults.blur, wallsTransparent: false });
  }, [snapshotNow]);

  const handleRenameTemplate = useCallback(async (id: string, newName: string) => {
    if (!newName.trim()) return;
    try {
      await fetch(`/api/shadow-config-templates/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      await refreshTemplateList();
    } catch (err) {
      console.error("Failed to rename template", err);
    } finally {
      setRenamingTemplateId(null);
      setRenameInput("");
    }
  }, [refreshTemplateList]);

  const handleDeleteTemplate = useCallback(async (id: string) => {
    try {
      await fetch(`/api/shadow-config-templates/${id}`, { method: "DELETE" });
      if (selectedTemplateId === id) setSelectedTemplateId(null);
      await refreshTemplateList();
    } catch (err) {
      console.error("Failed to delete template", err);
    }
  }, [refreshTemplateList, selectedTemplateId]);

  const applyTransformValue = useCallback(
    (axis: "x" | "y" | "z", prop: "position" | "rotation" | "scale", value: number) => {
      if (!transformValues || !sceneViewRef.current) return;
      const newValues = structuredClone(transformValues);
      newValues[prop][axis] = value;
      setTransformValues(newValues);

      const pos = new THREE.Vector3(newValues.position.x, newValues.position.y, newValues.position.z);
      const rot = new THREE.Euler(THREE.MathUtils.degToRad(newValues.rotation.x), THREE.MathUtils.degToRad(newValues.rotation.y), THREE.MathUtils.degToRad(newValues.rotation.z));
      const scl = new THREE.Vector3(newValues.scale.x, newValues.scale.y, newValues.scale.z);
      sceneViewRef.current.applyTransform(pos, rot, scl);
    },
    [transformValues]
  );

  // ─── Badge text ────────────────────────────────────────────────────────────
  const modeBadgeText = (() => {
    const label = MODE_LABELS_VN[transformMode] ?? transformMode;
    if (hotkeyAxis) return `${label} (trục ${hotkeyAxis.toUpperCase()})`;
    return label;
  })();
  const selectedTemplateName = selectedTemplateId ? templates.find((t) => t.id === selectedTemplateId)?.name : null;

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="w-screen h-screen max-w-none rounded-none flex flex-col p-0 gap-0"
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            sceneViewRef.current?.deselect();
            setHotkeyAxis(null);
          }}
        >
          <DialogHeader className="px-6 pt-4 pb-2">
            <DialogTitle className="flex items-center gap-2 text-base flex-wrap">
              <Lightbulb className="w-4 h-4 text-yellow-400 fill-yellow-400/30" />
              Studio Simulator
              <div className="flex items-center gap-0.5 ml-1">
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={undo} disabled={!canUndo} title="Hoàn tác (Ctrl+Z)">
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={redo} disabled={!canRedo} title="Làm lại (Ctrl+Shift+Z)">
                  <Redo2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {selectionInfo.type && (
                <span className="ml-2 text-[11px] font-normal px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-400/40">
                  {SELECTION_LABELS_VN[selectionInfo.type] ?? selectionInfo.type}
                </span>
              )}
              {selectionInfo.type && (
                <span
                  className={`text-[11px] font-normal px-2 py-0.5 rounded-full border ${
                    hotkeyAxis === "x"
                      ? "bg-red-500/15 text-red-400 border-red-400/40"
                      : hotkeyAxis === "y"
                      ? "bg-green-500/15 text-green-400 border-green-400/40"
                      : hotkeyAxis === "z"
                      ? "bg-blue-500/15 text-blue-400 border-blue-400/40"
                      : transformMode === "translate"
                      ? "bg-emerald-500/15 text-emerald-400 border-emerald-400/40"
                      : transformMode === "rotate"
                      ? "bg-orange-500/15 text-orange-400 border-orange-400/40"
                      : "bg-violet-500/15 text-violet-400 border-violet-400/40"
                  }`}
                >
                  {modeBadgeText}
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">Trình giả lập studio 3D với bóng đổ</DialogDescription>
          </DialogHeader>

          <div className="flex flex-1 overflow-hidden">
            {/* Bên trái: Khung cảnh 3D */}
            <div className="flex-1 flex flex-col p-4 min-w-0">
              <div ref={previewContainerRef} className="flex-1 bg-black rounded-lg overflow-hidden relative">
                <div
                  className={`absolute inset-0 flex items-center justify-center bg-black/40 z-10 transition-opacity duration-500 pointer-events-none ${
                    !sceneReady ? "opacity-100" : "opacity-0"
                  }`}
                >
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="h-8 w-8 animate-spin text-white/70" />
                    <span className="text-xs text-white/50">Đang thiết lập cảnh…</span>
                  </div>
                </div>
              </div>

              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground px-1 flex-wrap">
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">G</span>
                <span>Di chuyển</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">R</span>
                <span>Xoay</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">S</span>
                <span>Tỷ lệ</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">X</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">Y</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">Z</span>
                <span>Khoá trục</span>
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded">Esc</span>
                <span>Bỏ chọn</span>
              </div>
            </div>

            {/* Bên phải: Bảng điều khiển */}
            <div className="w-72 shrink-0 border-l border-border flex flex-col overflow-hidden">
              {/* Xem trước kết quả — live canvas from production camera */}
              <div className="shrink-0 p-3 border-b border-border/50">
                <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Xem trước kết quả {CAPTURE_SIZE}×{CAPTURE_SIZE}
                </Label>
                <div className="relative w-full aspect-square rounded-md border border-border/50 bg-muted/20 overflow-hidden">
                  <canvas ref={previewCanvasRef} width={PREVIEW_CANVAS_SIZE} height={PREVIEW_CANVAS_SIZE} className="w-full h-full" />
                  {!sceneReady && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground/40">
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span className="text-[10px]">Đang tải…</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-4">
                {/* Biến đổi */}
                {selectionInfo.type && transformValues && (
                  <div className="rounded-lg border-2 border-blue-600/60 bg-card/30 p-3 space-y-3">
                    <div className="flex gap-1">
                      <Button
                        variant={transformMode === "translate" ? "secondary" : "ghost"}
                        size="sm"
                        className="flex-1 h-7 text-xs"
                        onClick={() => {
                          sceneViewRef.current?.setTransformMode("translate");
                          setTransformMode("translate");
                          setHotkeyAxis(null);
                        }}
                      >
                        <Move className="h-3 w-3 mr-1" /> Di chuyển
                      </Button>
                      <Button
                        variant={transformMode === "rotate" ? "secondary" : "ghost"}
                        size="sm"
                        className="flex-1 h-7 text-xs"
                        onClick={() => {
                          sceneViewRef.current?.setTransformMode("rotate");
                          setTransformMode("rotate");
                          setHotkeyAxis(null);
                        }}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" /> Xoay
                      </Button>
                      <Button
                        variant={transformMode === "scale" ? "secondary" : "ghost"}
                        size="sm"
                        className="flex-1 h-7 text-xs"
                        onClick={() => {
                          sceneViewRef.current?.setTransformMode("scale");
                          setTransformMode("scale");
                          setHotkeyAxis(null);
                        }}
                      >
                        <Maximize2 className="h-3 w-3 mr-1" /> Tỷ lệ
                      </Button>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Vị trí</Label>
                      <div className="grid grid-cols-3 gap-1.5">
                        <TransformInput label="X" value={transformValues.position.x} onChange={(v) => applyTransformValue("x", "position", v)} />
                        <TransformInput label="Y" value={transformValues.position.y} onChange={(v) => applyTransformValue("y", "position", v)} />
                        <TransformInput label="Z" value={transformValues.position.z} onChange={(v) => applyTransformValue("z", "position", v)} />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Xoay</Label>
                      <div className="grid grid-cols-3 gap-1.5">
                        <TransformInput label="X" value={transformValues.rotation.x} onChange={(v) => applyTransformValue("x", "rotation", v)} suffix="°" />
                        <TransformInput label="Y" value={transformValues.rotation.y} onChange={(v) => applyTransformValue("y", "rotation", v)} suffix="°" />
                        <TransformInput label="Z" value={transformValues.rotation.z} onChange={(v) => applyTransformValue("z", "rotation", v)} suffix="°" />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Tỷ lệ</Label>
                      <div className="grid grid-cols-3 gap-1.5">
                        <TransformInput label="X" value={transformValues.scale.x} onChange={(v) => applyTransformValue("x", "scale", v)} />
                        <TransformInput label="Y" value={transformValues.scale.y} onChange={(v) => applyTransformValue("y", "scale", v)} />
                        <TransformInput label="Z" value={transformValues.scale.z} onChange={(v) => applyTransformValue("z", "scale", v)} />
                      </div>
                    </div>
                  </div>
                )}

                {/* Mẫu bóng đổ */}
                <div className="rounded-lg border border-border/50 bg-card/30 p-3 space-y-2">
                  <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Mẫu bóng đổ</Label>
                  <Popover open={templateDropdownOpen} onOpenChange={setTemplateDropdownOpen}>
                    <PopoverTrigger asChild>
                      <button
                        className="w-full h-8 flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-xs disabled:opacity-50 hover:bg-accent/40 transition-colors"
                        disabled={templates.length === 0}
                      >
                        <span className="truncate text-left flex-1">
                          {selectedTemplateId
                            ? (templates.find((t) => t.id === selectedTemplateId)?.name ?? "Chọn mẫu…")
                            : templates.length > 0 ? "Chọn mẫu…" : "Chưa có mẫu"}
                        </span>
                        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-1" align="start">
                      <div className="max-h-48 overflow-y-auto">
                        {templates.map((t) => (
                          <div
                            key={t.id}
                            className={`group flex items-center gap-1 rounded px-2 py-1.5 ${selectedTemplateId === t.id ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
                          >
                            {renamingTemplateId === t.id ? (
                              <>
                                <Input
                                  className="h-6 text-xs flex-1 py-0 px-1"
                                  value={renameInput}
                                  onChange={(e) => setRenameInput(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleRenameTemplate(t.id, renameInput);
                                    if (e.key === "Escape") { setRenamingTemplateId(null); setRenameInput(""); }
                                  }}
                                  autoFocus
                                />
                                <button
                                  className="shrink-0 text-green-500 hover:text-green-400"
                                  onClick={() => handleRenameTemplate(t.id, renameInput)}
                                  title="Lưu tên"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  className="shrink-0 text-muted-foreground hover:text-foreground"
                                  onClick={() => { setRenamingTemplateId(null); setRenameInput(""); }}
                                  title="Hủy"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </>
                            ) : (
                              <>
                                <span
                                  className="flex-1 text-xs truncate cursor-pointer"
                                  onClick={() => { handleApplyTemplate(t.id); setTemplateDropdownOpen(false); }}
                                  title={t.name}
                                >
                                  {t.name}
                                </span>
                                <button
                                  className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                                  onClick={(e) => { e.stopPropagation(); setRenamingTemplateId(t.id); setRenameInput(t.name); }}
                                  title="Đổi tên"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                                <button
                                  className="shrink-0 opacity-0 group-hover:opacity-100 text-destructive/70 hover:text-destructive transition-opacity"
                                  onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(t.id); }}
                                  title="Xóa"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-7 text-xs gap-1.5"
                    onClick={handleResetSimulator}
                    title="Đặt lại toàn bộ simulator về mặc định để tạo mẫu bóng mới"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Tạo Mẫu Bóng Mới
                  </Button>
                </div>

                {/* HDRI Cơ — multi-layer (max 2) */}
                <div className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                  <div className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium">
                    <button
                      type="button"
                      className="flex flex-1 items-center gap-2 hover:text-foreground transition-colors min-w-0"
                      onClick={() => setCueHdriOpen(v => !v)}
                    >
                      <Sun className="h-3.5 w-3.5 text-yellow-400 shrink-0" />
                      <span>HDRI Cơ</span>
                      <span className="text-[10px] text-muted-foreground ml-1">({cueHdriLayersState.length}/2)</span>
                      <span className="flex-1" />
                      {cueHdriOpen
                        ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                    </button>
                    {cueHdriLayersState.length < 2 && (
                      <button
                        type="button"
                        className="p-0.5 rounded hover:bg-muted/60 transition-colors shrink-0"
                        onClick={addCueHdriLayer}
                        title="Thêm lớp HDRI"
                      >
                        <Plus className="h-3 w-3 text-muted-foreground" />
                      </button>
                    )}
                  </div>
                  {cueHdriOpen && (
                    <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-4">
                      <p className="text-[10px] text-muted-foreground">HDRI chỉ áp dụng cho cơ. Có thể pha trộn tối đa 2 lớp HDRI.</p>
                      {cueHdriLayersState.map((layer, idx) => (
                        <div key={layer.id} className="space-y-2 rounded-md border border-border/40 bg-muted/10 px-2.5 pb-2.5 pt-2">
                          {/* Layer header: enable toggle + label + remove */}
                          <div className="flex items-center gap-2">
                            <Checkbox
                              id={`cue-hdri-layer-${idx}`}
                              checked={layer.enabled}
                              onCheckedChange={(v) => {
                                handleCueHdriLayer(idx, { enabled: !!v });
                                snapshotNow();
                              }}
                              className="h-3.5 w-3.5"
                            />
                            <label htmlFor={`cue-hdri-layer-${idx}`} className="text-[10px] font-medium flex-1 cursor-pointer select-none">
                              Lớp {idx + 1}
                            </label>
                            {cueHdriLayersState.length > 1 && (
                              <button
                                type="button"
                                className="p-0.5 rounded hover:bg-destructive/20 transition-colors"
                                onClick={() => removeCueHdriLayer(idx)}
                                title="Xóa lớp"
                              >
                                <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                              </button>
                            )}
                          </div>
                          {/* HDRI type */}
                          <div className="space-y-0.5">
                            <Label className="text-[10px] text-muted-foreground">Môi trường</Label>
                            <Select
                              value={layer.hdriType}
                              onValueChange={(v) => {
                                handleCueHdriLayer(idx, { hdriType: v });
                                snapshotNow();
                              }}
                            >
                              <SelectTrigger className="h-6 text-[10px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {HDRI_OPTIONS_FALLBACK.filter((h) => h.id !== STUDIO_WHITE_HDRI).map((h) => (
                                  <SelectItem key={h.id} value={h.id} className="text-[10px]">
                                    {h.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {/* Rotation Y */}
                          <div className="space-y-0.5">
                            <Label className="text-[10px] text-muted-foreground">
                              Ngang — {layer.rotationY.toFixed(0)}°
                            </Label>
                            <Slider
                              value={[layer.rotationY]}
                              onValueChange={([v]) => handleCueHdriLayer(idx, { rotationY: v })}
                              onValueCommit={() => snapshotNow()}
                              min={0} max={360} step={1}
                            />
                          </div>
                          {/* Rotation X */}
                          <div className="space-y-0.5">
                            <Label className="text-[10px] text-muted-foreground">
                              Dọc — {layer.rotationX.toFixed(0)}°
                            </Label>
                            <Slider
                              value={[layer.rotationX]}
                              onValueChange={([v]) => handleCueHdriLayer(idx, { rotationX: v })}
                              onValueCommit={() => snapshotNow()}
                              min={0} max={360} step={1}
                            />
                          </div>
                          {/* Intensity */}
                          <div className="space-y-0.5">
                            <Label className="text-[10px] text-muted-foreground">
                              Cường độ — {(layer.intensity * 100).toFixed(0)}%
                            </Label>
                            <Slider
                              value={[layer.intensity]}
                              onValueChange={([v]) => handleCueHdriLayer(idx, { intensity: v })}
                              onValueCommit={() => snapshotNow()}
                              min={0} max={3} step={0.05}
                            />
                          </div>
                        </div>
                      ))}
                      {cueHdriLayersState.length < 2 && (
                        <button
                          type="button"
                          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/60 py-1.5 text-[10px] text-muted-foreground hover:border-border hover:bg-muted/20 transition-colors"
                          onClick={addCueHdriLayer}
                        >
                          <Plus className="h-3 w-3" />
                          Thêm lớp HDRI
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Cài đặt bóng đổ */}
                <div className="rounded-lg border border-border/50 bg-card/30 p-3 space-y-3">
                  <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Cài đặt bóng đổ</Label>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">Cường độ</Label>
                      <span className="text-xs tabular-nums text-muted-foreground">{Math.round(localCfg.intensity * 100)}%</span>
                    </div>
                    <Slider value={[localCfg.intensity]} onValueChange={([v]) => handleSlider("intensity", v)} onValueCommit={() => snapshotNow()} min={0} max={1} step={0.01} />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">Làm mờ</Label>
                      <span className="text-xs tabular-nums text-muted-foreground">{localCfg.blur.toFixed(0)}</span>
                    </div>
                    <Slider value={[localCfg.blur]} onValueChange={([v]) => handleSlider("blur", v)} onValueCommit={() => snapshotNow()} min={0} max={20} step={0.5} />
                  </div>

                  {/* Transparent walls toggle */}
                  <div className="border-t border-border/30 pt-2">
                    <Button
                      variant={wallsTransparent ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-xs w-full gap-1.5"
                      onClick={() => {
                        const newWalls = !wallsTransparentRef.current;
                        setWallsTransparent(newWalls);
                        snapshotNow({ wallsTransparent: newWalls });
                      }}
                    >
                      {wallsTransparent ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      {wallsTransparent ? "Đang ẩn tường / sàn" : "Ẩn tường / sàn (nền trong suốt)"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="px-6 py-3 border-t shrink-0 flex justify-between">
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={handleSaveTemplate} disabled={!sceneReady || isSavingTemplate}>
                {isSavingTemplate ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileUp className="w-4 h-4 mr-2" />}
                Lưu cài đặt bóng
              </Button>
              {saveMsg && (
                <span className={`flex items-center gap-1 text-xs ${saveMsg.ok ? "text-green-500" : "text-destructive"}`}>
                  {saveMsg.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                  {saveMsg.text}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={handleApply} disabled={!sceneReady || isSaving}>
                {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
                Áp dụng lên gậy
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showTemplateSaveChoiceDialog}
        onOpenChange={(nextOpen) => {
          if (!isSavingTemplate) setShowTemplateSaveChoiceDialog(nextOpen);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Lưu cài đặt bóng</DialogTitle>
            <DialogDescription>Chọn cách lưu mẫu bóng hiện tại.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Button className="w-full justify-start" variant="outline" onClick={handleUpdateSelectedTemplate} disabled={isSavingTemplate}>
              {isSavingTemplate ? "Đang lưu..." : `Cập nhật "${selectedTemplateName ?? "Mẫu hiện tại"}"`}
            </Button>
            <Button className="w-full justify-start" variant="outline" onClick={openSaveNewTemplateDialog} disabled={isSavingTemplate}>
              Lưu thành mẫu mới
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTemplateSaveChoiceDialog(false)} disabled={isSavingTemplate}>
              Hủy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showTemplateNameDialog}
        onOpenChange={(nextOpen) => {
          if (!isSavingTemplate) setShowTemplateNameDialog(nextOpen);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Tên mẫu bóng đổ</DialogTitle>
            <DialogDescription className="sr-only">Nhập tên mẫu để lưu cài đặt bóng đổ hiện tại.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="shadow-template-name">Tên mẫu</Label>
            <Input
              id="shadow-template-name"
              value={templateNameInput}
              onChange={(e) => setTemplateNameInput(e.target.value)}
              placeholder="Mẫu bóng của tôi"
              onKeyDown={(e) => {
                if (e.key === "Enter" && templateNameInput.trim()) {
                  void handleSaveTemplateAsNew();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTemplateNameDialog(false)} disabled={isSavingTemplate}>
              Hủy
            </Button>
            <Button
              onClick={() => {
                void handleSaveTemplateAsNew();
              }}
              disabled={!templateNameInput.trim() || isSavingTemplate}
            >
              {isSavingTemplate ? "Đang lưu..." : "Lưu"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
