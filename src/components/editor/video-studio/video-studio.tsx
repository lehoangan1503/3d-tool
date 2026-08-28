"use client";

import * as THREE from "three";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Video,
  Download,
  Square,
  Loader2,
  AlertCircle,
  RotateCcw,
  Eye,
  Camera,
  ChevronDown,
  ChevronUp,
  Box,
  Move,
  Maximize2,
  Sun,
  Image as ImageIcon,
  Sparkles,
  Undo2,
  Redo2,
  Save,
  RefreshCw,
  Lightbulb,
  Plus,
  Trash2,
  Film,
  Clapperboard,
} from "lucide-react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager, HDRI_OPTIONS_FALLBACK } from "@/lib/three/extractor-scene-manager";
import type { VideoStudioConfig, CameraKeyframe, CameraPathConfig, CameraShapeParams, CameraWaypoint, CueHdriConfig, VideoRatio, CornerFillConfig, LogoBackdropConfig, SceneBackgroundConfig } from "@/types/video-studio";
import { DEFAULT_CORNER_FILL, DEFAULT_LOGO_BACKDROP, DEFAULT_SCENE_BACKGROUND, loadGlobalLogoBackdrop, saveGlobalLogoBackdrop } from "@/types/video-studio";
import type { StudioEnvironmentAsset, StudioEnvironmentConfig } from "@/types/studio-environment";
import { normalizeEnvironmentConfig } from "@/types/studio-environment";
import { EnvironmentPanel } from "./environment-panel";
import {
  DEFAULT_STUDIO_CONFIG,
  DEFAULT_STUDIO_CONFIG_V2,
  DEFAULT_CUE_HDRI,
  DEFAULT_CAMERA_PATH,
  MAX_CAMERA_WAYPOINTS,
  VIDEO_QUALITY_PRESETS,
  VIDEO_RATIO_PRESETS,
  getRecordingDimensions,
  ensureFullConfig,
  migrateVideoStudioConfig,
  computeVideoDuration,
  isCameraFixed,
} from "@/types/video-studio";
import { createDefaultHdriLayer, STUDIO_WHITE_HDRI } from "@/types/extractor";
import {
  applyWaypointsEuler,
  cameraKeyframeLookingAt,
  getWaypointsCenter,
  getWaypointsRadius,
  insertWaypointOnLongestSegment,
  regenerateShape,
  rotateWaypoints,
  scaleWaypoints,
  translateWaypoints,
  trimPathToSpan,
} from "@/lib/three/camera-path";
import { CameraControlsPanel } from "./camera-controls-panel";
import { CueSetupPanel } from "./cue-setup-panel";
import { BackgroundPanel } from "./background-panel";
import { LogoBackdropPanel } from "./logo-backdrop-panel";
import { StudioTemplateSelector, type StudioTemplateSelectorHandle } from "./studio-template-selector";
import { SceneViewControls, type SelectionInfo } from "./scene-view-controls";

/** Inline editable number field for transform values */
function TransformInput({ label, value, onChange, suffix = "" }: { label: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  const [localValue, setLocalValue] = useState<string | null>(null);

  // Sync external value only when not actively editing
  const displayValue = localValue !== null ? localValue : parseFloat(value.toFixed(2)).toString();

  const commit = (str: string) => {
    setLocalValue(null);
    const v = parseFloat(str);
    if (!isNaN(v)) onChange(v);
    else onChange(0);
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground w-3 shrink-0">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={displayValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
        }}
        className="h-6 w-full rounded border border-border/50 bg-muted/30 px-1.5 text-xs font-mono tabular-nums text-foreground outline-none focus:border-blue-500/50"
      />
      {suffix && <span className="text-[10px] text-muted-foreground shrink-0">{suffix}</span>}
    </div>
  );
}

/** Overlay that dims the area outside the active recording crop while showing a clear border. */
function RatioGuideOverlay({ ratio }: { ratio: VideoRatio }) {
  const preset = VIDEO_RATIO_PRESETS.find((r) => r.id === ratio) ?? VIDEO_RATIO_PRESETS[0];
  const ratioAspect = preset.width / preset.height;
  // Use CSS to achieve letterbox/pillarbox via a transparent "window" on the container.
  // The outer div fills the preview container; the inner rect is the active recording area.
  return (
    <div className="absolute inset-0 pointer-events-none z-20" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          // Compute active area via CSS custom properties — we use aspect-ratio trick:
          // The active region is max-width/height fitting both the container and the ratio.
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Semi-transparent overlay using clip-path to reveal only the active area */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            // Mask: transparent hole where the active area is
            WebkitMaskImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100%25' height='100%25'><rect width='100%25' height='100%25' fill='white'/><rect id='h' fill='black'/></svg>")`,
          }}
        />
        {/* Active frame border */}
        <div
          style={{
            aspectRatio: `${ratioAspect}`,
            maxWidth: "100%",
            maxHeight: "100%",
            width: `min(100%, calc(100vh * ${ratioAspect}))`,
            border: "2px solid rgba(255,255,255,0.6)",
            boxSizing: "border-box",
            position: "relative",
          }}
        >
          {/* Corner marks */}
          {[
            { top: 0, left: 0 },
            { top: 0, right: 0 },
            { bottom: 0, left: 0 },
            { bottom: 0, right: 0 },
          ].map((pos, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                width: 14,
                height: 14,
                ...pos,
                border: "2px solid white",
                borderTopWidth: pos.bottom !== undefined ? 0 : 2,
                borderBottomWidth: pos.top !== undefined ? 0 : 2,
                borderLeftWidth: pos.right !== undefined ? 0 : 2,
                borderRightWidth: pos.left !== undefined ? 0 : 2,
              }}
            />
          ))}
          {/* Ratio label */}
          <span
            style={{
              position: "absolute",
              bottom: 6,
              right: 8,
              fontSize: 10,
              color: "rgba(255,255,255,0.7)",
              fontFamily: "monospace",
              background: "rgba(0,0,0,0.4)",
              padding: "1px 5px",
              borderRadius: 3,
            }}
          >
            {ratio}
          </span>
        </div>
      </div>
    </div>
  );
}

interface VideoStudioProps {
  sceneManager: SceneManager | null;
  productName: string;
  productId: string;
  onClose: () => void;
  open: boolean;
  /**
   * "v1" (default) keeps the original studio: a flat wall + table plane with a
   * composited background image. "v2" replaces that fake set with a real 3D space —
   * a 360 degree HDRI (optionally ground-projected) or a loaded GLB room.
   *
   * Everything else — cue model, cue HDRI, camera path, recording — is shared, so the
   * two variants differ only in what surrounds the cue.
   */
  variant?: "v1" | "v2";
  /**
   * The product's current "Logo khắc laser" (`config.logoId`). The big logo plate follows
   * it when set to "auto", so the plate matches whatever is engraved on the cue without
   * the user having to pick anything.
   */
  productLogoId?: string | null;
}

const SELECTION_LABELS_VN: Record<string, string> = {
  camera: "Camera",
  cue: "Mô hình",
  wall: "Tường",
  table: "Bàn",
  wallFrame: "Khung tường",
  tableFrame: "Khung bàn",
  hdriLight: "Đèn",
};

const MODE_LABELS_VN: Record<string, string> = {
  translate: "Di chuyển",
  rotate: "Xoay",
  scale: "Tỷ lệ",
};

export function VideoStudio({ sceneManager, productName, productId, onClose, open, variant = "v1", productLogoId }: VideoStudioProps) {
  const isV2 = variant === "v2";
  const [config, setConfig] = useState<VideoStudioConfig>(() =>
    structuredClone(isV2 ? DEFAULT_STUDIO_CONFIG_V2 : DEFAULT_STUDIO_CONFIG)
  );
  /** V2 only — HDRI / room files the user added this session (object URLs). */
  const [userEnvAssets, setUserEnvAssets] = useState<StudioEnvironmentAsset[]>([]);
  /** V2 only — why the last environment load failed (bad file, 404, unsupported codec). */
  const [envLoadError, setEnvLoadError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [viewMode, setViewMode] = useState<"scene" | "camera">("camera");
  const [cameraSnapshot, setCameraSnapshot] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<"editor" | "video">("editor");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo>({ type: null });
  const [transformValues, setTransformValues] = useState<{
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
  } | null>(null);
  const [transformMode, setTransformMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [hotkeyAxis, setHotkeyAxis] = useState<"x" | "y" | "z" | null>(null);
  // Captured positions for display — only update on "Đặt" click, never from config changes
  /** Whole-curve selection: green highlight + drags move every waypoint together. */
  const [selectAllActive, setSelectAllActive] = useState(false);
  /**
   * Waypoints as they were when the current R-drag began. The rotate callback receives an
   * ABSOLUTE angle each mouse-move, so it must rebuild from this snapshot rather than
   * compounding rotations — otherwise the curve creeps and never returns on cancel.
   */
  const rotateSnapshotRef = useRef<CameraWaypoint[] | null>(null);
  const [capturedStart, setCapturedStart] = useState<CameraKeyframe | null>(null);
  const [capturedEnd, setCapturedEnd] = useState<CameraKeyframe | null>(null);
  // Track which section was auto-opened by selection (so we can close it on deselect)
  const autoExpandedSectionRef = useRef<string | null>(null);

  // Undo/redo history — seed with initial config so first undo always has a target
  const configHistoryRef = useRef<VideoStudioConfig[]>([structuredClone(config)]);
  const configFutureRef = useRef<VideoStudioConfig[]>([]);
  const isUndoRedoRef = useRef(false);
  const isDraggingRef = useRef(false);
  const historyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const viewModeRef = useRef<"scene" | "camera">("camera");
  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoUrlRef = useRef<string | null>(null);
  const blobUrlsRef = useRef<string[]>([]);
  const sceneViewControlsRef = useRef<SceneViewControls | null>(null);
  const sceneViewLoopRef = useRef<{ stop: () => void; start: () => void } | null>(null);
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const templateSelectorRef = useRef<StudioTemplateSelectorHandle>(null);
  /** When true, the next rebuildScene will skip setCameraFromKeyframe so camera stays at current position */
  const preserveCameraOnNextRebuildRef = useRef(false);
  // Ref to throttle setProgress calls during recording — avoids a React re-render
  // on every rAF tick (60fps). We update state at most once per 100ms (≤10 updates/s).
  const lastProgressUpdateRef = useRef<number>(0);

  // Flag shared with the sceneViewAnimate loop to pause controls.update() during
  // recording. Avoids a competing rAF callback doing layout/transform work.
  const isRecordingRef = useRef(false);

  // The SceneViewControls drag callback is created once at mount, so it must read
  // select-all through a ref — a captured state value would always be stale.
  const selectAllActiveRef = useRef(false);
  useEffect(() => {
    selectAllActiveRef.current = selectAllActive;
  }, [selectAllActive]);

  // Keep a ref to config so SceneViewControls callback always reads latest
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
    // Always cancel pending debounce first — prevents stale timer from
    // clearing the redo stack after undo/redo fires
    if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current);
    // Debounced history push: batch rapid changes (sliders) into one entry
    if (!isUndoRedoRef.current && !isDraggingRef.current) {
      historyDebounceRef.current = setTimeout(() => {
        historyDebounceRef.current = null;
        configHistoryRef.current = [...configHistoryRef.current.slice(-4), configRef.current];
        configFutureRef.current = [];
      }, 600);
    }
    isUndoRedoRef.current = false;
  }, [config]);

  const undo = useCallback(() => {
    if (configHistoryRef.current.length <= 1) return;
    const current = configHistoryRef.current.pop()!;
    configFutureRef.current.push(current);
    const prev = configHistoryRef.current[configHistoryRef.current.length - 1];
    if (prev) {
      isUndoRedoRef.current = true;
      setConfig(structuredClone(prev));
    }
  }, []);

  const redo = useCallback(() => {
    if (configFutureRef.current.length === 0) return;
    const next = configFutureRef.current.pop()!;
    isUndoRedoRef.current = true;
    configHistoryRef.current.push(next);
    setConfig(structuredClone(next));
  }, []);

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

  // Minimap: register/unregister the canvas with ESM (it handles rendering internally).
  // Re-runs on videoRatio change so the ESM picks up the resized canvas immediately.
  useEffect(() => {
    const esm = extractorRef.current;
    const canvas = minimapCanvasRef.current;
    if (!open || viewMode !== "scene" || !esm || !canvas) {
      esm?.setMinimapCanvas(null);
      return;
    }
    esm.setMinimapCanvas(canvas);
    return () => esm.setMinimapCanvas(null);
  }, [open, viewMode, config.videoRatio]);

  const updateConfig = useCallback(<K extends keyof VideoStudioConfig>(key: K, value: VideoStudioConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  /**
   * Corner fillet settings, with defaults filled in.
   *
   * Templates saved before the fillet was configurable have no `cornerFill` block; merging
   * over the defaults reproduces their previous look (enabled, 0.8 radius) rather than
   * dropping the cove out of an existing scene.
   */
  const cornerFill: CornerFillConfig = useMemo(
    () => ({ ...DEFAULT_CORNER_FILL, ...config.cornerFill }),
    [config.cornerFill]
  );

  const updateCornerFill = useCallback((patch: Partial<CornerFillConfig>) => {
    setConfig((prev) => ({
      ...prev,
      cornerFill: { ...DEFAULT_CORNER_FILL, ...prev.cornerFill, ...patch },
    }));
  }, []);

  /**
   * Colour of the empty space around the wall/table set, with the legacy default filled in.
   * Templates saved before it existed keep the old hardcoded #1a1a1a.
   */
  const sceneBackground: SceneBackgroundConfig = useMemo(
    () => ({ ...DEFAULT_SCENE_BACKGROUND, ...config.sceneBackground }),
    [config.sceneBackground]
  );

  const updateSceneBackground = useCallback((next: SceneBackgroundConfig) => {
    setConfig((prev) => ({ ...prev, sceneBackground: next }));
  }, []);

  /** Giant camera-locked logo plate behind the cue, with defaults filled in. */
  const logoBackdrop: LogoBackdropConfig = useMemo(
    () => ({ ...DEFAULT_LOGO_BACKDROP, ...config.logoBackdrop }),
    [config.logoBackdrop]
  );

  /**
   * Patch the logo plate and persist it GLOBALLY.
   *
   * The plate is branding rather than scene composition, so it is shared by every template
   * instead of being stored per-template — see loadGlobalLogoBackdrop.
   */
  const updateLogoBackdrop = useCallback((patch: Partial<LogoBackdropConfig>) => {
    setConfig((prev) => {
      const next = { ...DEFAULT_LOGO_BACKDROP, ...prev.logoBackdrop, ...patch };
      saveGlobalLogoBackdrop(next);
      return { ...prev, logoBackdrop: next };
    });
  }, []);

  /**
   * Patch the V2 environment block.
   *
   * Normalises first so a template saved before a field existed still merges cleanly
   * instead of writing `undefined` into a nested object the renderer reads.
   */
  const updateEnvironment = useCallback((patch: Partial<StudioEnvironmentConfig>) => {
    setConfig((prev) => ({
      ...prev,
      environment: { ...normalizeEnvironmentConfig(prev.environment), ...patch },
    }));
  }, []);

  /**
   * Camera-view minimap dimensions derived from the selected video ratio, so the
   * preview box always shows the true recording frame (a 9:16 export previews tall
   * and narrow, not letterboxed inside a 16:9 box).
   *
   * The sidebar is 320px wide, so width is capped at 288px (w-80 minus p-4 padding)
   * and height at 320px — portrait ratios shrink in width rather than growing tall
   * enough to push the controls below the fold.
   */
  const minimapSize = useMemo(() => {
    const MAX_W = 288;
    const MAX_H = 320;
    const ratio = config.videoRatio ?? "16:9";
    const preset = VIDEO_RATIO_PRESETS.find((r) => r.id === ratio) ?? VIDEO_RATIO_PRESETS[0];
    const aspect = preset.width / preset.height;

    // Fit the box inside the MAX_W x MAX_H envelope while preserving the aspect
    let cssW = MAX_W;
    let cssH = Math.round(cssW / aspect);
    if (cssH > MAX_H) {
      cssH = MAX_H;
      cssW = Math.round(cssH * aspect);
    }

    // Backing store at 2x for crisp rendering on HiDPI displays
    return {
      cssWidth: cssW,
      width: cssW * 2,
      height: cssH * 2,
    };
  }, [config.videoRatio]);

  const toggleSection = useCallback((id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * Un-transformed curve geometry that the panel's absolute rotation/scale fields are
   * applied to. Rotation and scale in that panel are absolute values, not deltas, so
   * re-applying must start from a fixed base — otherwise typing 90 twice keeps rotating.
   * Captured when whole-curve selection is turned on.
   */
  const curveBaseRef = useRef<{ waypoints: CameraWaypoint[]; radius: number } | null>(null);

  /**
   * Re-capture the curve base + reset the panel to 0°/1.
   *
   * Any regeneration (preset switch, size slider) replaces the waypoints, which makes the
   * previous snapshot stale — applying an absolute rotation against it would spring the
   * curve back to the old geometry.
   */
  const rebaseCurveTransform = useCallback((waypoints: CameraWaypoint[]) => {
    if (!selectAllActiveRef.current || waypoints.length === 0) return;
    const center = getWaypointsCenter(waypoints);
    curveBaseRef.current = {
      waypoints: waypoints.map((w) => ({ ...w })),
      radius: getWaypointsRadius(waypoints, center),
    };
    setTransformValues({
      position: { x: center.x, y: center.y, z: center.z },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
  }, []);

  /**
   * Apply the transform panel's values to the whole curve:
   *   position — move the centroid there (translates every point)
   *   rotation — absolute Euler about the centroid, rebuilt from the base snapshot
   *   scale    — uniform size about the centroid, relative to the base radius
   */
  const applyCurveTransform = useCallback(
    (values: {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number };
      scale: { x: number; y: number; z: number };
    }) => {
      const extractor = extractorRef.current;
      const path = configRef.current.cameraPath;
      if (!extractor || !path || path.waypoints.length === 0) return;

      const base = curveBaseRef.current;
      if (!base) return;
      const baseCenter = getWaypointsCenter(base.waypoints);

      // 1. Absolute rotation about the base centroid.
      let next = applyWaypointsEuler(base.waypoints, baseCenter, {
        x: THREE.MathUtils.degToRad(values.rotation.x),
        y: THREE.MathUtils.degToRad(values.rotation.y),
        z: THREE.MathUtils.degToRad(values.rotation.z),
      });

      // 2. Uniform scale. The three fields are kept in lockstep because a non-uniform
      //    scale of a path is a shear the shape presets cannot round-trip; the average
      //    lets any of the three inputs drive it.
      const factor = (values.scale.x + values.scale.y + values.scale.z) / 3;
      if (Math.abs(factor - 1) > 1e-6) {
        next = scaleWaypoints(next, baseCenter, Math.max(0.01, factor));
      }

      // 3. Translate so the centroid lands on the requested position.
      const cur = getWaypointsCenter(next);
      next = translateWaypoints(
        next,
        values.position.x - cur.x,
        values.position.y - cur.y,
        values.position.z - cur.z
      );

      setConfig((prev) => ({
        ...prev,
        cameraPath: { ...(prev.cameraPath ?? DEFAULT_CAMERA_PATH), waypoints: next },
      }));
      extractor.applyCameraWaypointPositions(next);
      extractor.refreshCameraPathLineFromGizmos({
        ...configRef.current,
        cameraPath: { ...path, waypoints: next },
      });
    },
    []
  );

  const applyTransformValue = useCallback(
    (axis: "x" | "y" | "z", prop: "position" | "rotation" | "scale", value: number) => {
      if (!transformValues || !sceneViewControlsRef.current) return;
      const newValues = structuredClone(transformValues);
      newValues[prop][axis] = value;
      setTransformValues(newValues);

      // Whole-curve editing: the fields describe the CURVE (centroid position, absolute
      // rotation about it, uniform size), not the one marker the gizmo happens to hold.
      // Editing that marker would move a single point and leave the panel lying.
      if (selectAllActiveRef.current) {
        applyCurveTransform(newValues);
        return;
      }

      const pos = new THREE.Vector3(newValues.position.x, newValues.position.y, newValues.position.z);
      const rot = new THREE.Euler(THREE.MathUtils.degToRad(newValues.rotation.x), THREE.MathUtils.degToRad(newValues.rotation.y), THREE.MathUtils.degToRad(newValues.rotation.z));
      const scl = new THREE.Vector3(newValues.scale.x, newValues.scale.y, newValues.scale.z);
      sceneViewControlsRef.current.applyTransform(pos, rot, scl);
    },
    // applyCurveTransform is declared below and is stable (useCallback with no deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transformValues]
  );

  /** Resize canvas to fill the container naturally; studio camera gets correct video-ratio aspect */
  const resizePreviewCanvas = useCallback(() => {
    const extractor = extractorRef.current;
    const container = previewContainerRef.current;
    if (!extractor || !container) return;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    if (!containerW || !containerH) return;

    const ratio = configRef.current.videoRatio ?? "16:9";
    const preset = VIDEO_RATIO_PRESETS.find((r) => r.id === ratio) ?? VIDEO_RATIO_PRESETS[0];
    const targetAspect = preset.width / preset.height;
    const canvas = extractor.getCanvas();

    if (viewModeRef.current === "camera") {
      // Camera preview: render at exact video-ratio dimensions so there is no stretch.
      // Compute the largest rect that fits inside the container at the target aspect ratio.
      const containerAspect = containerW / containerH;
      let renderW: number, renderH: number;
      if (targetAspect <= containerAspect) {
        // Target is taller (portrait) → constrain by height, pillarbox the sides
        renderH = containerH;
        renderW = Math.max(1, Math.round(containerH * targetAspect));
      } else {
        // Target is wider (landscape) → constrain by width, letterbox top/bottom
        renderW = containerW;
        renderH = Math.max(1, Math.round(containerW / targetAspect));
      }
      // resize() sets renderer size AND camera.aspect = renderW/renderH = targetAspect ✓
      extractor.resize(renderW, renderH);
      // Center the canvas inside the container; the surrounding bg-black acts as letter/pillarbox.
      if (canvas) {
        canvas.style.width = `${renderW}px`;
        canvas.style.height = `${renderH}px`;
        canvas.style.position = "absolute";
        canvas.style.left = "50%";
        canvas.style.top = "50%";
        canvas.style.transform = "translate(-50%, -50%)";
      }
    } else {
      // Scene edit mode: fill the container; set studio camera aspect separately so the
      // camera gizmo/helper is drawn with the correct video-ratio frustum.
      extractor.resize(containerW, containerH);
      extractor.setStudioCameraAspect(targetAspect);
      if (canvas) {
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.position = "";
        canvas.style.left = "";
        canvas.style.top = "";
        canvas.style.transform = "";
      }
    }
  }, []);

  // Setup ExtractorSceneManager when dialog opens
  useEffect(() => {
    if (!open || !sceneManager) return;

    let sceneViewAnimId: number | null = null;
    let isCancelled = false;
    // Capture local refs so cleanup disposes exactly what this effect created,
    // even if the async setup completes after the cleanup runs.
    let localExtractor: ExtractorSceneManager | null = null;
    let localSceneViewControls: SceneViewControls | null = null;

    const setup = async () => {
      sceneManager.pauseAnimation();
      const model = sceneManager.getModelForClone();
      const hdriUrl = sceneManager.getCurrentHdriUrl();
      if (!model) return;

      const extractor = new ExtractorSceneManager();
      localExtractor = extractor;
      extractorRef.current = extractor;

      if (model) await extractor.setModel(model);
      if (isCancelled) {
        extractor.dispose();
        localExtractor = null;
        return;
      }
      if (hdriUrl) {
        try {
          await extractor.loadHDRI(hdriUrl);
        } catch {
          // HDRI load failure is non-critical
        }
      }
      if (isCancelled) {
        extractor.dispose();
        localExtractor = null;
        return;
      }

      const canvas = extractor.getCanvas();
      if (previewContainerRef.current && canvas) {
        canvas.style.display = "block";
        // Remove only any previously-appended canvas — don't use innerHTML="" which
        // would remove React-managed children and cause a "removeChild" reconciler error.
        const existingCanvas = previewContainerRef.current.querySelector("canvas");
        if (existingCanvas) existingCanvas.remove();
        previewContainerRef.current.appendChild(canvas);
        const rect = previewContainerRef.current.getBoundingClientRect();
        const initW = Math.max(rect.width || 800, 1);
        const initH = Math.max(rect.height || Math.round((initW * 9) / 16), 1);
        extractor.resize(initW, initH);
        const ratioId = configRef.current.videoRatio ?? "16:9";
        const ratioPreset = VIDEO_RATIO_PRESETS.find((r) => r.id === ratioId) ?? VIDEO_RATIO_PRESETS[0];
        extractor.setStudioCameraAspect(ratioPreset.width / ratioPreset.height);
        // Initial canvas CSS; resizePreviewCanvas() (called later via rAF) will finalize based on viewMode.
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        extractor.initSceneView();
        const controls = new SceneViewControls(
          extractor,
          canvas,
          (kf: CameraKeyframe) => {
            setConfig((prev) => ({ ...prev, cameraStart: kf }));
          },
          () => configRef.current.cueConfig,
          // Selection change → update selection info + auto-expand transform + matching section
          (info) => {
            setSelectionInfo(info);
            // In whole-curve mode the panel shows curve-level values, set by
            // handleToggleSelectAll. Overwriting them with the marker's own transform would
            // put the marker's emphasis scale and stale rotation into the fields.
            if (info.type === "cameraWaypoint" && selectAllActiveRef.current) return;
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
              // Map selection type → section ID
              const sectionMap: Record<string, string> = {
                cue: "cue",
                camera: "camera",
                wall: "background",
                table: "background",
                wallFrame: "background",
                tableFrame: "background",
                hdriLight: "lights",
                cameraWaypoint: "camera",
              };
              const matchedSection = sectionMap[info.type];
              setExpandedSections((prev) => {
                const next = new Set(prev);
                // Close previously auto-expanded section
                const prevAutoSection = autoExpandedSectionRef.current;
                if (prevAutoSection && prevAutoSection !== matchedSection) {
                  next.delete(prevAutoSection);
                }
                next.add("transform");
                if (matchedSection) next.add(matchedSection);
                return next;
              });
              autoExpandedSectionRef.current = matchedSection ?? null;
            } else {
              setTransformValues(null);
              setHotkeyAxis(null);
              setExpandedSections((prev) => {
                const next = new Set(prev);
                next.delete("transform");
                // Close the section that was auto-expanded by selection
                const prevAutoSection = autoExpandedSectionRef.current;
                if (prevAutoSection) next.delete(prevAutoSection);
                return next;
              });
              autoExpandedSectionRef.current = null;
            }
          },
          // Object transform → sync 3D position back to config
          (info, position, rotation, scale) => {
            if (info.type === "cameraWaypoint" && selectAllActiveRef.current) {
              // Whole-curve drag: report the CURVE's new centroid, keeping rotation/scale as
              // typed. The dragged marker's own transform is not a curve property.
              setTransformValues((prev) => {
                const anchor = configRef.current.cameraPath?.waypoints[info.waypointIndex ?? 0];
                const center = getWaypointsCenter(configRef.current.cameraPath?.waypoints ?? []);
                if (!anchor) return prev;
                return {
                  position: {
                    x: center.x + (position.x - anchor.x),
                    y: center.y + (position.y - anchor.y),
                    z: center.z + (position.z - anchor.z),
                  },
                  rotation: prev?.rotation ?? { x: 0, y: 0, z: 0 },
                  scale: prev?.scale ?? { x: 1, y: 1, z: 1 },
                };
              });
            } else {
            setTransformValues({
              position: { x: position.x, y: position.y, z: position.z },
              rotation: {
                x: THREE.MathUtils.radToDeg(rotation.x),
                y: THREE.MathUtils.radToDeg(rotation.y),
                z: THREE.MathUtils.radToDeg(rotation.z),
              },
              scale: { x: scale.x, y: scale.y, z: scale.z },
            });
            }
            if (info.type === "camera") {
              // Sync recording camera position into config so "Lưu Mẫu" captures the current position.
              // position/rotation come from the camera gizmo, which is about to be synced to the
              // actual recording camera via syncCameraFromGizmo() right after this callback returns.
              setConfig((prev) => ({
                ...prev,
                cameraStart: {
                  x: position.x,
                  y: position.y,
                  z: position.z,
                  rotationX: rotation.x,
                  rotationY: rotation.y,
                  rotationZ: rotation.z,
                },
              }));
            } else if (info.type === "cameraWaypoint") {
              // Write the dragged gizmo position back into the waypoint(s). The path line
              // already followed the pointer live via onCameraPathLiveUpdate; this makes
              // the change durable so it is saved with the template.
              const index = info.waypointIndex;
              if (index !== undefined) {
                setConfig((prev) => {
                  const path = prev.cameraPath;
                  if (!path || !path.waypoints[index]) return prev;
                  // "Select all": the dragged handle's delta shifts the entire curve, so the
                  // shape is preserved and only its placement changes.
                  if (selectAllActiveRef.current) {
                    const anchor = path.waypoints[index];
                    const waypoints = translateWaypoints(
                      path.waypoints,
                      position.x - anchor.x,
                      position.y - anchor.y,
                      position.z - anchor.z
                    );
                    return { ...prev, cameraPath: { ...path, waypoints } };
                  }
                  const waypoints = [...path.waypoints];
                  waypoints[index] = {
                    ...waypoints[index],
                    x: position.x,
                    y: position.y,
                    z: position.z,
                  };
                  return { ...prev, cameraPath: { ...path, waypoints } };
                });
              }
            } else if (info.type === "cue") {
              // Immediately move shadow lights without waiting for the debounced config update
              extractorRef.current?.directUpdateCueShadowPosition(position.x, position.z);
              setConfig((prev) => {
                const instances = [...prev.cueConfig.instances];
                if (instances[0]) {
                  instances[0] = {
                    ...instances[0],
                    positionX: position.x,
                    positionY: position.y,
                    positionZ: position.z,
                    scale: scale.x,
                  };
                }
                return {
                  ...prev,
                  cueConfig: {
                    ...prev.cueConfig,
                    instances,
                    spinX: rotation.x,
                    spinY: rotation.y,
                    spinZ: rotation.z,
                  },
                };
              });
            } else if (info.type === "wallFrame" && info.frameId) {
              setConfig((prev) => {
                const WALL_W = 34,
                  WALL_H = 24,
                  WALL_Y = 10; // must match backdrop position
                const frames = prev.wallSurface.frames.map((f) => {
                  if (f.id !== info.frameId) return f;
                  const obj = info.object as THREE.Mesh;
                  const geo = obj?.geometry as THREE.PlaneGeometry | undefined;
                  const baseW = geo?.parameters?.width ?? f.width * WALL_W;
                  const baseH = geo?.parameters?.height ?? f.height * WALL_H;
                  return {
                    ...f,
                    x: position.x / WALL_W + 0.5,
                    y: 0.5 - (position.y - WALL_Y) / WALL_H,
                    width: Math.max(0.05, (baseW * scale.x) / WALL_W),
                    height: Math.max(0.05, (baseH * scale.y) / WALL_H),
                    rotation: (rotation.z * 180) / Math.PI,
                  };
                });
                return { ...prev, wallSurface: { ...prev.wallSurface, frames } };
              });
            } else if (info.type === "tableFrame" && info.frameId) {
              setConfig((prev) => {
                const TABLE_W = 34,
                  TABLE_D = 12,
                  TABLE_Z = 0.5; // must match tableSurface position
                const frames = prev.tableSurface.frames.map((f) => {
                  if (f.id !== info.frameId) return f;
                  const obj = info.object as THREE.Mesh;
                  const geo = obj?.geometry as THREE.PlaneGeometry | undefined;
                  const baseW = geo?.parameters?.width ?? f.width * TABLE_W;
                  const baseD = geo?.parameters?.height ?? f.height * TABLE_D;
                  return {
                    ...f,
                    x: position.x / TABLE_W + 0.5,
                    y: (position.z - TABLE_Z) / TABLE_D + 0.5,
                    width: Math.max(0.05, (baseW * scale.x) / TABLE_W),
                    height: Math.max(0.05, (baseD * scale.y) / TABLE_D),
                    rotation: (rotation.y * 180) / Math.PI,
                  };
                });
                return { ...prev, tableSurface: { ...prev.tableSurface, frames } };
              });
            } else if (info.type === "hdriLight" && info.layerId != null) {
              const extractor = extractorRef.current;
              if (extractor) {
                const { rotationX: rotX, rotationY: rotY } = extractor.positionToHdriRotation(position);
                // Scale maps to intensity (uniform scale, clamp 0.1–3)
                const avgScale = (scale.x + scale.y + scale.z) / 3;
                const newIntensity = Math.max(0.1, Math.min(3, avgScale));
                setConfig((prev) => {
                  const layers = [...prev.hdriConfig.layers];
                  const idx = layers.findIndex((l) => l.id === info.layerId);
                  if (idx >= 0) {
                    layers[idx] = {
                      ...layers[idx],
                      rotationX: rotX,
                      rotationY: rotY,
                      intensity: newIntensity,
                    };
                  }
                  return { ...prev, hdriConfig: { layers } };
                });
              }
            }
          },
          // Transform mode change (G/R/S keys)
          (mode) => {
            setTransformMode(mode);
            const hs = sceneViewControlsRef.current?.getHotkeyState();
            setHotkeyAxis(hs?.axis ?? null);
          },
          // Drag start: suppress history pushes during drag
          () => {
            isDraggingRef.current = true;
          },
          // Drag end: commit final state to history
          () => {
            isDraggingRef.current = false;
            rotateSnapshotRef.current = null;
            // Re-base the panel: the committed geometry becomes the new zero for absolute
            // rotation/scale, so the fields reset to 0°/1 rather than re-applying the
            // rotation that is already baked into the waypoints.
            if (selectAllActiveRef.current) {
              const wps = configRef.current.cameraPath?.waypoints ?? [];
              if (wps.length > 0) {
                const center = getWaypointsCenter(wps);
                curveBaseRef.current = {
                  waypoints: wps.map((w) => ({ ...w })),
                  radius: getWaypointsRadius(wps, center),
                };
                setTransformValues({
                  position: { x: center.x, y: center.y, z: center.z },
                  rotation: { x: 0, y: 0, z: 0 },
                  scale: { x: 1, y: 1, z: 1 },
                });
              }
            }
            setHotkeyAxis(null);
            if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current);
            configHistoryRef.current = [...configHistoryRef.current.slice(-4), configRef.current];
            configFutureRef.current = [];
          },
          // Camera waypoint drag: re-tessellate the path curve from the live gizmo positions
          // so the orange line tracks the pointer instead of lagging behind the debounced
          // config sync.
          (draggedIndex) => {
            const extractor = extractorRef.current;
            if (!extractor) return;
            // In select-all mode the siblings must follow the dragged handle before the
            // line is re-tessellated, or only one sphere appears to move.
            if (selectAllActiveRef.current && draggedIndex !== undefined) {
              extractor.syncCameraWaypointGroupDrag(configRef.current, draggedIndex);
            }
            extractor.refreshCameraPathLineFromGizmos(configRef.current);
          },
          // Rotate the whole curve around its centroid (R + optional X/Y/Z while
          // "select all" is on).
          (axis, angle) => {
            const path = configRef.current.cameraPath;
            if (!path) return;
            // First move of this drag — snapshot the pre-rotation geometry.
            if (!rotateSnapshotRef.current) {
              rotateSnapshotRef.current = path.waypoints.map((w) => ({ ...w }));
            }
            const base = rotateSnapshotRef.current;
            const center = getWaypointsCenter(base);
            const waypoints = angle === 0 ? base.map((w) => ({ ...w })) : rotateWaypoints(base, center, axis, angle);
            setConfig((prev) => ({
              ...prev,
              cameraPath: { ...(prev.cameraPath ?? DEFAULT_CAMERA_PATH), waypoints },
            }));
            // Mirror the live angle into the transform panel so the two stay in agreement.
            const deg = THREE.MathUtils.radToDeg(angle);
            setTransformValues((prev) => ({
              position: prev?.position ?? { x: center.x, y: center.y, z: center.z },
              rotation: { x: axis === "x" ? deg : 0, y: axis === "y" ? deg : 0, z: axis === "z" ? deg : 0 },
              scale: prev?.scale ?? { x: 1, y: 1, z: 1 },
            }));
            // Move the gizmos + line immediately; the debounced config sync is too slow to
            // track a live drag.
            extractorRef.current?.applyCameraWaypointPositions(waypoints);
            extractorRef.current?.refreshCameraPathLineFromGizmos({
              ...configRef.current,
              cameraPath: { ...path, waypoints },
            });
          },
          () => selectAllActiveRef.current
        );
        localSceneViewControls = controls;
        sceneViewControlsRef.current = controls;

        // V2 places the cue inside a real room, so the V1 wall/table clamp (which pins the
        // cue to z >= -5.5 and y >= -2) no longer describes anything real — drop it.
        if (isV2) controls.setCueBounds(null);

        // Waypoint gizmos are disposed and rebuilt whenever the waypoint count changes.
        // Drop the selection first so TransformControls is never left attached to a
        // disposed mesh (which throws on the next interaction).
        extractor.setCameraWaypointGizmoInvalidatedHandler(() => {
          if (sceneViewControlsRef.current?.getSelection().type === "cameraWaypoint") {
            sceneViewControlsRef.current.deselect();
          }
        });
      }

      if (isCancelled) {
        extractor.dispose();
        localExtractor = null;
        return;
      }
      await extractor.setupStudioFromStudioConfig(config);
      if (isV2) setEnvLoadError(extractor.getRoomEnvironmentError());
      if (isCancelled) {
        extractor.dispose();
        localExtractor = null;
        return;
      }
      extractor.startStudioVideoPreview(config);
      // Apply initial view mode so orbit controls and _cameraPlacementMode are set correctly
      // (the viewMode useEffect fires before extractorRef is set on first mount, so we must
      // initialise the view mode explicitly here after the extractor is ready).
      extractor.setViewMode(viewModeRef.current);
      sceneViewControlsRef.current?.setEnabled(viewModeRef.current === "scene");
      setSceneReady(true);
      // Re-apply correct canvas dimensions after first paint (container may not have had its final
      // layout dimensions at the time of the initial resize above).
      requestAnimationFrame(() => resizePreviewCanvas());

      // Animation loop for scene view controls damping
      const sceneViewAnimate = () => {
        if (!extractorRef.current) return;
        // Pause controls damping during recording — avoids a competing rAF callback
        // doing transform/layout work while the GPU is fully loaded by encoding.
        if (!isRecordingRef.current) {
          sceneViewControlsRef.current?.update();
        }
        sceneViewAnimId = requestAnimationFrame(sceneViewAnimate);
      };
      sceneViewAnimate();
      sceneViewLoopRef.current = {
        stop: () => {
          if (sceneViewAnimId !== null) {
            cancelAnimationFrame(sceneViewAnimId);
            sceneViewAnimId = null;
          }
        },
        start: () => {
          if (sceneViewAnimId === null) sceneViewAnimate();
        },
      };
    };

    setup();

    return () => {
      isCancelled = true;
      setSceneReady(false);
      if (sceneViewAnimId) cancelAnimationFrame(sceneViewAnimId);
      sceneViewLoopRef.current = null;
      // Dispose exactly what this effect instance created — avoids stale-ref issues
      // when the effect re-runs before the async setup completes.
      // Clear before disposing: dispose() tears down the path gizmos, which would
      // otherwise fire the invalidation handler against already-disposed controls.
      localExtractor?.setCameraWaypointGizmoInvalidatedHandler(null);
      localSceneViewControls?.dispose();
      if (sceneViewControlsRef.current === localSceneViewControls) sceneViewControlsRef.current = null;
      localExtractor?.stopVideoPreview();
      localExtractor?.dispose();
      if (extractorRef.current === localExtractor) extractorRef.current = null;
      sceneManager?.resumeAnimation();
    };
    // Only re-run on open/close, not on config changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sceneManager]);

  // ResizeObserver: re-resize canvas when container changes
  useEffect(() => {
    if (!open || !previewContainerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (!isRecordingRef.current) resizePreviewCanvas();
    });
    ro.observe(previewContainerRef.current);
    return () => ro.disconnect();
  }, [open, resizePreviewCanvas]);

  // Re-size when videoRatio changes so camera aspect always matches recording ratio
  useEffect(() => {
    if (!open) return;
    resizePreviewCanvas();
  }, [open, config.videoRatio, resizePreviewCanvas]);

  // Re-size canvas when switching back to editor tab (was hidden with display:none)
  useEffect(() => {
    if (mainTab === "editor" && open) {
      requestAnimationFrame(() => resizePreviewCanvas());
    }
  }, [mainTab, open, resizePreviewCanvas]);

  // Keep viewModeRef in sync so setup() can access the current value
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  // Sync view mode to extractor + enable/disable scene view controls + fix canvas sizing
  useEffect(() => {
    if (!extractorRef.current) return;
    extractorRef.current.setViewMode(viewMode);
    if (sceneViewControlsRef.current) {
      sceneViewControlsRef.current.setEnabled(viewMode === "scene");
    }
    // Re-apply canvas sizing so camera view renders at exact video-ratio dimensions
    // and scene view fills the container.
    requestAnimationFrame(() => resizePreviewCanvas());
  }, [viewMode, resizePreviewCanvas]);

  // The logo plate follows the cue's engraved logo when set to "auto", so the scene
  // manager needs to know which one that is. Pushed before the debounced config sync so
  // the very first plate resolves against the right logo.
  useEffect(() => {
    if (!extractorRef.current || !open) return;
    extractorRef.current.setProductLogoId(productLogoId ?? null);
  }, [productLogoId, open, sceneReady]);

  // The logo plate fits itself to the frame, so it must be re-laid-out whenever the
  // output ratio changes — otherwise a plate authored at 16:9 comes out cropped at 9:16.
  useEffect(() => {
    if (!extractorRef.current || !open) return;
    const preset = VIDEO_RATIO_PRESETS.find((r) => r.id === (config.videoRatio ?? "16:9"))
      ?? VIDEO_RATIO_PRESETS[0];
    extractorRef.current.setLogoBackdropAspect(preset.width / preset.height);
  }, [config.videoRatio, open, sceneReady]);

  // Debounced preview updates on config change
  useEffect(() => {
    if (!extractorRef.current || !open) return;
    if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    updateTimerRef.current = setTimeout(() => {
      extractorRef.current?.updateStudioPreviewConfig(config);
      updateTimerRef.current = null;
    }, 100);
    return () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    };
  }, [config, open]);

  // Rebuild scene for expensive changes (backgrounds, HDRI, shadow, instance count)
  const rebuildScene = useCallback(async () => {
    if (!extractorRef.current) return;
    const preserveCamera = preserveCameraOnNextRebuildRef.current;
    preserveCameraOnNextRebuildRef.current = false;
    setIsRebuilding(true);
    try {
      // Detach TransformControls before clearing scene — prevents
      // "attached 3D object must be a part of the scene graph" error
      sceneViewControlsRef.current?.deselect();
      extractorRef.current.stopVideoPreview();
      await extractorRef.current.setupStudioFromStudioConfig(config);
      if (isV2) setEnvLoadError(extractorRef.current.getRoomEnvironmentError());
      extractorRef.current.startStudioVideoPreview(config, preserveCamera);
    } finally {
      setIsRebuilding(false);
    }
  }, [config]);

  // Extract only the texture-relevant parts of frames (anything that requires a full material rebuild)
  // Position, size, rotation, opacity changes use updateFramePlaneTransforms instead.
  const wallFrameTextureKey = config.wallSurface.frames
    .map((f) =>
      [
        f.id,
        f.enabled ? 1 : 0,
        f.imageUrl ?? "",
        f.backgroundEnabled ? 1 : 0,
        f.backgroundType ?? "",
        f.backgroundColor ?? "",
        f.backgroundOpacity ?? 1,
        f.imageOpacity ?? 1,
        f.type ?? "",
        f.color ?? "",
        f.gradient?.presetId ?? "",
        f.backgroundGradient?.angle ?? 0,
        JSON.stringify(f.backgroundGradient?.colors ?? []),
      ].join(":")
    )
    .join("|");
  const tableFrameTextureKey = config.tableSurface.frames
    .map((f) =>
      [
        f.id,
        f.enabled ? 1 : 0,
        f.imageUrl ?? "",
        f.backgroundEnabled ? 1 : 0,
        f.backgroundType ?? "",
        f.backgroundColor ?? "",
        f.backgroundOpacity ?? 1,
        f.imageOpacity ?? 1,
        f.type ?? "",
        f.color ?? "",
        f.gradient?.presetId ?? "",
        f.backgroundGradient?.angle ?? 0,
        JSON.stringify(f.backgroundGradient?.colors ?? []),
      ].join(":")
    )
    .join("|");

  /**
   * Fields whose change requires reloading the environment asset (and thus a full
   * scene rebuild). Deliberately excludes rotation/intensity/shadow, which are cheap.
   */
  const env = config.environment;
  const environmentReloadKey = env
    ? [
        env.mode,
        env.assetId,
        env.assetUrl,
        env.showBackground ? 1 : 0,
        env.groundProjection.enabled ? 1 : 0,
        env.groundProjection.radius,
        env.lightCueFromEnvironment ? 1 : 0,
      ].join(":")
    : "";

  useEffect(() => {
    if (!extractorRef.current || !open) return;
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(() => {
      rebuildScene();
      rebuildTimerRef.current = null;
    }, 500);
    return () => {
      if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config.wallSurface.texturePreset,
    config.tableSurface.texturePreset,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    wallFrameTextureKey,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    tableFrameTextureKey,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(config.hdriConfig.layers.map((l) => l.hdriType)),
    config.shadow.enabled,
    // The fillet is baked into the shadow receiver + a dedicated mesh at setup time, so
    // every field here needs a scene rebuild rather than a live material tweak.
    cornerFill.enabled,
    cornerFill.radius,
    config.cueConfig.instances.length,
    config.hdriConfig.layers.length,
    config.surfaceLightDisabled,
    // V2: reload the environment only when the asset itself or a structural flag changes.
    // Rotation / intensity / shadow-catcher values are applied live instead (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    environmentReloadKey,
    open,
  ]);

  /**
   * V2 live environment updates.
   *
   * Rotating or brightening the room must not re-decode a multi-megabyte HDRI, so these
   * fields bypass the 500 ms rebuild and mutate the existing scene directly.
   */
  useEffect(() => {
    if (!extractorRef.current || !open || !isV2) return;
    extractorRef.current.updateRoomEnvironment(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    isV2,
    config.environment?.rotationY,
    config.environment?.intensity,
    config.environment?.backgroundIntensity,
    config.environment?.groundProjection.height,
    config.environment?.shadowCatcher.enabled,
    config.environment?.shadowCatcher.height,
    config.environment?.shadowCatcher.opacity,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(config.environment?.roomTransform ?? null),
  ]);

  // Light-weight update: sync frame transforms (position/size/rotation) without full rebuild
  useEffect(() => {
    if (!extractorRef.current || !open) return;
    extractorRef.current.updateFramePlaneTransforms(config);
    // The cove paints itself from a render of the whole wall, so moving or resizing any
    // frame changes what it should show. Repainting one canvas is cheap enough to run on
    // every drag frame — far cheaper than the 500 ms full rebuild this effect exists to avoid.
    extractorRef.current.refreshCornerFillMaterial(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(config.wallSurface.frames.map((f) => [f.id, f.x, f.y, f.width, f.height, f.rotation, f.opacity])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(config.tableSurface.frames.map((f) => [f.id, f.x, f.y, f.width, f.height, f.rotation, f.opacity])),
    open,
  ]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, []);

  const handleSetStart = useCallback(() => {
    const extractor = extractorRef.current;
    if (!extractor) return;
    const kf = extractor.getCameraKeyframeFromPosition();
    setConfig((prev) => ({ ...prev, cameraStart: kf }));
    setCapturedStart(kf);
  }, []);

  const handleSetEnd = useCallback(() => {
    const extractor = extractorRef.current;
    if (!extractor) return;
    const kf = extractor.getCameraKeyframeFromPosition();
    setConfig((prev) => ({ ...prev, cameraEnd: kf }));
    setCapturedEnd(kf);
  }, []);

  // ── Camera path handlers ──────────────────────────────────────────────────

  /** Cue centre — every shape is generated around this, never around the camera. */
  const getCueCenter = useCallback((): THREE.Vector3 => {
    const instances = configRef.current.cueConfig.instances;
    const main = instances.find((i) => i.isMain) ?? instances[0];
    return main
      ? new THREE.Vector3(main.positionX, main.positionY, main.positionZ)
      : new THREE.Vector3(0, 5.5, 0);
  }, []);

  /**
   * Move the recording camera onto a waypoint and aim it per the path's lookMode.
   * This is what makes picking a start point feel direct — the viewport immediately shows
   * the frame the recording will open on.
   */
  const placeCameraAtWaypoint = useCallback(
    (path: CameraPathConfig, index: number) => {
      const extractor = extractorRef.current;
      const wp = path.waypoints[index];
      if (!extractor || !wp) return;
      const kf = cameraKeyframeLookingAt(wp, path.lookMode, getCueCenter());
      extractor.invalidateCameraStartKey();
      extractor.setCameraFromKeyframe(kf);
      setConfig((prev) => ({ ...prev, cameraStart: kf }));
      setCapturedStart(kf);
    },
    [getCueCenter]
  );

  /** Turn curve mode on/off. Turning it on seeds the current shape around the cue. */
  const handlePathEnabledChange = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        extractorRef.current?.setCameraPathSelectAll(false);
        setSelectAllActive(false);
        setConfig((prev) => ({
          ...prev,
          cameraPath: { ...(prev.cameraPath ?? DEFAULT_CAMERA_PATH), enabled: false },
        }));
        return;
      }
      const prevPath = configRef.current.cameraPath ?? DEFAULT_CAMERA_PATH;
      const shaped = regenerateShape(prevPath.shapeId, getCueCenter(), prevPath.shapeParams);
      if (!shaped) return;
      const next: CameraPathConfig = { ...prevPath, ...shaped, enabled: true, mode: "spline" };
      setConfig((prev) => ({ ...prev, cameraPath: next }));
      rebaseCurveTransform(next.waypoints);
      placeCameraAtWaypoint(next, next.startIndex);
    },
    [getCueCenter, placeCameraAtWaypoint, rebaseCurveTransform]
  );

  /** Switch shape. Regenerates the whole curve around the cue at the current size. */
  const handleApplyPathPreset = useCallback(
    (presetId: string) => {
      const prevPath = configRef.current.cameraPath ?? DEFAULT_CAMERA_PATH;
      const shaped = regenerateShape(presetId, getCueCenter(), prevPath.shapeParams);
      if (!shaped) return;
      const next: CameraPathConfig = {
        ...prevPath,
        ...shaped,
        shapeId: presetId,
        enabled: true,
        mode: "spline",
        // A new shape invalidates the old picks — record the whole thing by default.
        startIndex: 0,
        endIndex: Math.max(0, shaped.waypoints.length - 1),
      };
      setConfig((prev) => ({ ...prev, cameraPath: next }));
      rebaseCurveTransform(next.waypoints);
      placeCameraAtWaypoint(next, next.startIndex);
    },
    [getCueCenter, placeCameraAtWaypoint, rebaseCurveTransform]
  );

  const handlePathChange = useCallback((patch: Partial<CameraPathConfig>) => {
    setConfig((prev) => ({
      ...prev,
      cameraPath: { ...(prev.cameraPath ?? DEFAULT_CAMERA_PATH), ...patch },
    }));
  }, []);

  /** Resize the shape — regenerates the curve so sliders reshape it live. */
  const handleShapeParamChange = useCallback(
    (key: keyof CameraShapeParams, value: number) => {
      const prevPath = configRef.current.cameraPath ?? DEFAULT_CAMERA_PATH;
      const shapeParams = { ...prevPath.shapeParams, [key]: value };
      const shaped = regenerateShape(
        prevPath.shapeId,
        getCueCenter(),
        shapeParams,
        prevPath.startIndex,
        prevPath.endIndex
      );
      if (!shaped) return;
      setConfig((prev) => ({
        ...prev,
        cameraPath: { ...prevPath, ...shaped, shapeParams },
      }));
      rebaseCurveTransform(shaped.waypoints);
    },
    [getCueCenter, rebaseCurveTransform]
  );

  /** Pick the span start, and move the camera there so the opening frame is visible. */
  const handleSetStartIndex = useCallback(
    (index: number) => {
      const prevPath = configRef.current.cameraPath ?? DEFAULT_CAMERA_PATH;
      const next: CameraPathConfig = { ...prevPath, startIndex: index };
      setConfig((prev) => ({ ...prev, cameraPath: next }));
      placeCameraAtWaypoint(next, index);
    },
    [placeCameraAtWaypoint]
  );

  const handleSetEndIndex = useCallback(
    (index: number) => {
      const prevPath = configRef.current.cameraPath ?? DEFAULT_CAMERA_PATH;
      const wp = prevPath.waypoints[index];
      if (!wp) return;
      // Keep cameraEnd in step so template saves and the duration read the right endpoint.
      const kf = cameraKeyframeLookingAt(wp, prevPath.lookMode, getCueCenter());
      setConfig((prev) => ({
        ...prev,
        cameraPath: { ...(prev.cameraPath ?? DEFAULT_CAMERA_PATH), endIndex: index },
        cameraEnd: kf,
      }));
      setCapturedEnd(kf);
    },
    [getCueCenter]
  );

  /** Delete every waypoint outside the picked span. */
  const handleTrimToSpan = useCallback(() => {
    setConfig((prev) => {
      const path = prev.cameraPath ?? DEFAULT_CAMERA_PATH;
      return { ...prev, cameraPath: trimPathToSpan(path) };
    });
  }, []);

  const handleAddWaypoint = useCallback(() => {
    setConfig((prev) => {
      const path = prev.cameraPath ?? DEFAULT_CAMERA_PATH;
      if (path.waypoints.length >= MAX_CAMERA_WAYPOINTS) return prev;
      const waypoints = insertWaypointOnLongestSegment(path.waypoints);
      return {
        ...prev,
        cameraPath: {
          ...path,
          waypoints,
          // Inserting shifts indices after the insertion point; keep the span covering
          // the whole curve rather than silently pointing at the wrong points.
          endIndex: Math.max(path.endIndex, waypoints.length - 1),
        },
      };
    });
  }, []);

  const handleRemoveWaypoint = useCallback((id: string) => {
    setConfig((prev) => {
      const path = prev.cameraPath ?? DEFAULT_CAMERA_PATH;
      const waypoints = path.waypoints.filter((w) => w.id !== id);
      const last = Math.max(0, waypoints.length - 1);
      return {
        ...prev,
        cameraPath: {
          ...path,
          waypoints,
          startIndex: Math.min(path.startIndex, last),
          endIndex: Math.min(path.endIndex, last),
          // Fewer than two points can't be travelled — fall back to legacy placement.
          enabled: waypoints.length >= 2 ? path.enabled : false,
        },
      };
    });
  }, []);

  /** Select a waypoint's gizmo in the 3D scene so it can be dragged immediately. */
  const handleFocusWaypoint = useCallback((index: number) => {
    const gizmo = extractorRef.current?.getCameraWaypointGizmos()[index];
    if (gizmo) sceneViewControlsRef.current?.selectObject(gizmo);
  }, []);

  /** Toggle whole-curve selection: green highlight, and drags move every point together. */
  const handleToggleSelectAll = useCallback((active: boolean) => {
    const extractor = extractorRef.current;
    if (!extractor) return;
    extractor.setCameraPathSelectAll(active);
    setSelectAllActive(active);
    // Keep the ref in step immediately — selectObject() below fires the selection callback
    // synchronously, which needs to know we are already in whole-curve mode.
    selectAllActiveRef.current = active;
    if (active) {
      const path = configRef.current.cameraPath;
      const waypoints = path?.waypoints ?? [];
      const center = getWaypointsCenter(waypoints);
      // Snapshot the un-rotated geometry that the panel's absolute rotation/scale apply to.
      curveBaseRef.current = {
        waypoints: waypoints.map((w) => ({ ...w })),
        radius: getWaypointsRadius(waypoints, center),
      };
      // Attach the transform gizmo to the first waypoint; its delta drives the whole curve.
      const first = extractor.getCameraWaypointGizmos()[0];
      if (first) sceneViewControlsRef.current?.selectObject(first);
      // Show CURVE-level values, not the marker's own — the marker's rotation and its
      // start/end emphasis scale are meaningless as curve properties.
      setTransformValues({
        position: { x: center.x, y: center.y, z: center.z },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });
    } else {
      curveBaseRef.current = null;
      sceneViewControlsRef.current?.deselect();
    }
    extractor.updateCameraPathVisuals(configRef.current);
  }, []);

  const handleRecord = async () => {
    if (!extractorRef.current) return;
    if (!capturedStart || !capturedEnd) return;
    setIsRecording(true);
    isRecordingRef.current = true;
    sceneViewLoopRef.current?.stop();
    setError(null);
    setVideoUrl(null);
    sceneViewControlsRef.current?.setEnabled(false);

    // Cancel any pending debounced preview/rebuild updates so they don't
    // interfere with the recording pipeline's own setup.
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
      updateTimerRef.current = null;
    }
    if (rebuildTimerRef.current) {
      clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = null;
    }

    // Force camera view during recording so user sees the camera path animation
    const prevViewMode = viewMode;
    if (viewMode !== "camera") {
      setViewMode("camera");
      extractorRef.current.setViewMode("camera");
    }

    try {
      lastProgressUpdateRef.current = 0;
      // Use captured positions as the authoritative start/end for recording.
      // capturedStart/End are only set by "Đặt" clicks and never corrupted by
      // camera movement, so they are always the correct values.
      const recordConfig = {
        ...config,
        cameraStart: capturedStart ?? config.cameraStart,
        cameraEnd: capturedEnd ?? config.cameraEnd,
      };

      // For fixed cameras, silently persist the current config (including
      // fixedCameraDuration) back to the selected template so "Tải xuống nhiều"
      // can read the correct duration without the user manually clicking "Lưu".
      if (isCameraFixed(recordConfig.cameraStart, recordConfig.cameraEnd, recordConfig.cameraPath)) {
        templateSelectorRef.current?.silentSave();
      }

      const blob = await extractorRef.current.startStudioRecording(recordConfig, (p) => {
        // Throttle React state updates: setProgress at most every 100ms so the
        // component doesn't re-render at 60fps while the GPU is under full load.
        // Always forward the final 100 so the bar completes cleanly.
        const now = performance.now();
        if (p >= 100 || now - lastProgressUpdateRef.current >= 100) {
          lastProgressUpdateRef.current = now;
          setProgress(p);
        }
      });
      const url = URL.createObjectURL(blob);
      blobUrlsRef.current.push(url);
      videoUrlRef.current = url;
      setVideoUrl(url);
      setMainTab("video");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed");
    } finally {
      setIsRecording(false);
      isRecordingRef.current = false;
      sceneViewLoopRef.current?.start();
      // Restore previous view mode
      setViewMode(prevViewMode);
      sceneViewControlsRef.current?.setEnabled(prevViewMode === "scene");
      // Restart preview with correct aspect ratio
      if (extractorRef.current && previewContainerRef.current) {
        resizePreviewCanvas();
        extractorRef.current.startStudioVideoPreview(config);
      }
    }
  };

  const handleStop = () => {
    extractorRef.current?.stopRecording();
    setIsRecording(false);
  };

  const handleDownload = () => {
    if (!videoUrl) return;
    const dims = getRecordingDimensions(config.quality, config.videoRatio ?? "16:9");
    const qualityLabel = `${dims.width}x${dims.height}-${dims.fps}fps`;
    const ratioLabel = (config.videoRatio ?? "16:9").replace(":", "x");
    const safeName = productName
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const a = document.createElement("a");
    a.href = videoUrl;
    a.download = `${safeName}-studio-${ratioLabel}-${qualityLabel}.webm`;
    a.click();
  };

  const handleReset = () => {
    setConfig(structuredClone(isV2 ? DEFAULT_STUDIO_CONFIG_V2 : DEFAULT_STUDIO_CONFIG));
    setVideoUrl(null);
    setError(null);
    templateSelectorRef.current?.resetSelection();
    setCapturedStart(null);
    setCapturedEnd(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!isRecording && !o) onClose();
      }}
    >
      <DialogContent
        className="w-screen h-screen max-w-none rounded-none flex flex-col p-0 gap-0"
        onEscapeKeyDown={(e) => {
          // In scene view, Esc deselects — don't close dialog
          if (viewMode === "scene") {
            e.preventDefault();
            sceneViewControlsRef.current?.deselect();
          }
        }}
      >
        <DialogHeader className="px-6 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-2">
            {/* Left: branding + undo/redo */}
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center gap-2">
                <Video className="h-5 w-5" /> Video Studio
              </div>
              <div className="flex items-center gap-0.5">
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={undo} title="Hoàn tác (Ctrl+Z)">
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={redo} title="Làm lại (Ctrl+Shift+Z)">
                  <Redo2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            {/* Center: main tabs */}
            <div className="flex-1 flex items-center justify-center">
              <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-0.5">
                <Button variant={mainTab === "editor" ? "secondary" : "ghost"} size="sm" className="h-7 text-xs px-3" onClick={() => setMainTab("editor")}>
                  <Clapperboard className="h-3 w-3 mr-1.5" /> Quay phim
                </Button>
                <Button variant={mainTab === "video" ? "secondary" : "ghost"} size="sm" className="h-7 text-xs px-3" onClick={() => setMainTab("video")}>
                  <Film className="h-3 w-3 mr-1.5" /> Video kết quả
                  {videoUrl && <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-primary inline-block" />}
                </Button>
              </div>
            </div>
            {/* Right: view mode toggles + selection badges */}
            {/* All children use invisible (not conditional) so the right section never changes width when switching tabs */}
            <div className="flex items-center gap-1 shrink-0">
              {viewMode === "scene" && selectionInfo.type && (
                <>
                  <span
                    className={`ml-1 text-[11px] font-normal px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-400/40 ${
                      mainTab === "video" ? "invisible pointer-events-none" : ""
                    }`}
                  >
                    {SELECTION_LABELS_VN[selectionInfo.type] ?? selectionInfo.type}
                  </span>
                  <span
                    className={`text-[11px] font-normal px-2 py-0.5 rounded-full border ${mainTab === "video" ? "invisible pointer-events-none" : ""} ${
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
                    {(() => {
                      const label = MODE_LABELS_VN[transformMode] ?? transformMode;
                      return hotkeyAxis ? `${label} (trục ${hotkeyAxis.toUpperCase()})` : label;
                    })()}
                  </span>
                </>
              )}
              <Button
                variant={viewMode === "camera" ? "secondary" : "ghost"}
                size="sm"
                className={`h-7 text-xs ${mainTab === "video" ? "invisible pointer-events-none" : ""}`}
                onClick={() => {
                  if (extractorRef.current) {
                    setCameraSnapshot(extractorRef.current.captureFrame("jpeg"));
                  }
                  setViewMode("camera");
                }}
              >
                <Camera className="h-3 w-3 mr-1" /> Góc nhìn máy quay
              </Button>
              <Button
                variant={viewMode === "scene" ? "secondary" : "ghost"}
                size="sm"
                className={`h-7 text-xs ${mainTab === "video" ? "invisible pointer-events-none" : ""}`}
                onClick={() => {
                  setCameraSnapshot(null);
                  setViewMode("scene");
                }}
              >
                <Eye className="h-3 w-3 mr-1" /> Chỉnh sửa
              </Button>
            </div>
          </DialogTitle>
          <DialogDescription className="sr-only">Tạo video điện ảnh cho {productName}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden relative">
          {/* ====== VIDEO RESULT TAB ====== */}
          {mainTab === "video" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 gap-6 z-10">
              {videoUrl ? (
                <>
                  <video src={videoUrl} controls autoPlay loop className="rounded-xl max-w-2xl w-full max-h-[70vh] object-contain shadow-2xl" />
                  <div className="flex gap-3">
                    <Button variant="outline" onClick={() => setMainTab("editor")}>
                      Tiếp tục chỉnh sửa
                    </Button>
                    <Button onClick={handleDownload}>
                      <Download className="h-4 w-4 mr-2" /> Tải xuống
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-4 text-muted-foreground">
                  <Film className="h-16 w-16 opacity-20" />
                  <p className="text-base font-medium">Chưa có video</p>
                  <p className="text-sm opacity-70">Hãy chỉnh sửa và quay phim để xem kết quả</p>
                  <Button variant="outline" onClick={() => setMainTab("editor")}>
                    <Clapperboard className="h-4 w-4 mr-2" /> Đến chỉnh sửa
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ====== EDITOR TAB (always mounted for WebGL continuity) ====== */}
          <div className={`flex flex-1 overflow-hidden ${mainTab === "video" ? "hidden" : ""}`}>
            {/* Left: Preview */}
            <div className="flex-1 flex flex-col p-4 min-w-0">
              {/* 3D preview canvas — always kept in the DOM so captureStream works during recording */}
              <div ref={previewContainerRef} className={`bg-black rounded-lg overflow-hidden relative flex-1 ${viewMode === "camera" ? "pointer-events-none" : ""}`}>
                <div
                  className={`absolute inset-0 flex items-center justify-center bg-black/40 z-10 transition-opacity duration-500 pointer-events-none ${
                    !sceneReady || isRebuilding ? "opacity-100" : "opacity-0"
                  }`}
                >
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="h-8 w-8 animate-spin text-white/70" />
                    <span className="text-xs text-white/50">{!sceneReady ? "Đang thiết lập cảnh…" : "Đang cập nhật…"}</span>
                  </div>
                </div>

                {/* Recording progress overlay — shown on top of canvas so captureStream still captures frames */}
                {isRecording && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90 z-30 p-8">
                    <Loader2 className="h-12 w-12 animate-spin text-primary/70" />
                    <div className="w-full max-w-md space-y-2">
                      <div className="h-3 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
                      </div>
                      <p className="text-sm text-muted-foreground text-center">
                        {(() => {
                          const total = computeVideoDuration(
                            capturedStart ?? config.cameraStart,
                            capturedEnd ?? config.cameraEnd,
                            config.cameraSpeed,
                            "xyz",
                            isCameraFixed(capturedStart ?? config.cameraStart, capturedEnd ?? config.cameraEnd, config.cameraPath) ? config.fixedCameraDuration : undefined,
                            config.cameraPath
                          );
                          const elapsed = (progress / 100) * total;
                          const fmt = (s: number) => {
                            const m = Math.floor(s / 60);
                            const sec = Math.round(s % 60);
                            return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${s.toFixed(0)}s`;
                          };
                          return `Đang ghi… ${fmt(elapsed)} / ${fmt(total)} (${Math.round(progress)}%)`;
                        })()}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Key hints for scene view */}
              {viewMode === "scene" && !isRecording && (
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground px-1 flex-wrap">
                  <span className="font-mono bg-muted px-1.5 py-0.5 rounded">G</span>
                  <span>Di chuyển</span>
                  <span className="font-mono bg-muted px-1.5 py-0.5 rounded">R</span>
                  <span>Xoay</span>
                  <span className="font-mono bg-muted px-1.5 py-0.5 rounded">S</span>
                  <span>Tỷ lệ</span>
                  <span className="font-mono bg-muted px-1.5 py-0.5 rounded">Esc</span>
                  <span>Bỏ chọn</span>
                  <span className="text-muted-foreground/60">— nhấp để chọn, kéo để xoay quanh</span>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="mt-2 flex items-center gap-2 text-destructive text-sm">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </div>
              )}
            </div>

            {/* Right: Controls */}
            <div className="w-80 shrink-0 border-l border-border flex flex-col">
              {/* Camera minimap — fixed at top (doesn't scroll with controls) */}
              {viewMode === "scene" && (
                <div className="shrink-0 p-4 pb-2 border-b border-border/30">
                  <div
                    className="relative rounded-lg overflow-hidden border border-border/50 bg-black mx-auto"
                    style={{ width: minimapSize.cssWidth }}
                  >
                    <canvas
                      ref={minimapCanvasRef}
                      width={minimapSize.width}
                      height={minimapSize.height}
                      className="w-full h-auto block"
                    />
                    <span className="absolute top-1.5 left-2 text-[9px] text-white/70 font-medium bg-black/40 px-1.5 py-0.5 rounded">Góc nhìn máy quay</span>
                  </div>
                </div>
              )}

              {/* Scrollable controls area */}
              <div className="overflow-y-auto p-4 space-y-3 flex-1">
                {/* Template selector — always visible at top */}
                <StudioTemplateSelector
                  ref={templateSelectorRef}
                  variant={variant}
                  productId={productId}
                  currentConfig={config}
                  onLoadConfig={(c) => {
                    const loaded = migrateVideoStudioConfig(ensureFullConfig(c));
                    // Guarantee the variant's invariant holds regardless of what was stored:
                    // V2 must always have an environment, V1 must never have one. Without this
                    // a mismatched template would leave the studio with no space to render.
                    const migrated: VideoStudioConfig = isV2
                      ? { ...loaded, environment: normalizeEnvironmentConfig(loaded.environment) }
                      : { ...loaded, environment: undefined };
                    // A template carries its own logo look — style tab, colours, neon
                    // treatment — and restoring it is the whole point of saving one. The
                    // global config only fills in fields the template predates, so an older
                    // template still opens with sensible values for settings added since.
                    migrated.logoBackdrop = loaded.logoBackdrop
                      ? { ...DEFAULT_LOGO_BACKDROP, ...loaded.logoBackdrop }
                      : loadGlobalLogoBackdrop();
                    setConfig(migrated);
                    // Invalidate cache so the next updateStudioPreviewConfig applies the template camera
                    extractorRef.current?.invalidateCameraStartKey();
                    // Template already has camera positions — treat them as captured so record is ready
                    setCapturedStart(migrated.cameraStart ?? null);
                    setCapturedEnd(migrated.cameraEnd ?? null);
                  }}
                  onNewTemplate={() => {
                    setConfig({
                      ...structuredClone(isV2 ? DEFAULT_STUDIO_CONFIG_V2 : DEFAULT_STUDIO_CONFIG),
                      logoBackdrop: loadGlobalLogoBackdrop(),
                    });
                    // Fresh template — clear captured so user must set positions manually
                    setCapturedStart(null);
                    setCapturedEnd(null);
                  }}
                />

                {/* Quality — always visible */}
                <div className="flex items-center gap-2 text-xs">
                  <Select value={config.quality} onValueChange={(v) => updateConfig("quality", v as VideoStudioConfig["quality"])}>
                    <SelectTrigger className="h-7 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2k">2K 60fps</SelectItem>
                      <SelectItem value="2k120">2K 120fps</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={config.videoRatio ?? "16:9"} onValueChange={(v) => updateConfig("videoRatio", v as VideoRatio)}>
                    <SelectTrigger className="h-7 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VIDEO_RATIO_PRESETS.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Transform controls — shown when object selected in scene view */}
                {viewMode === "scene" && selectionInfo.type && (
                  <div className="rounded-lg border-2 border-blue-600/60 bg-card/30 overflow-hidden">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                      onClick={() => toggleSection("transform")}
                    >
                      <Move className="h-3.5 w-3.5 text-blue-400" />
                      <span className="text-blue-300">{selectionInfo.type}</span>
                      <span className="flex-1" />
                      {expandedSections.has("transform") ? (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                    {expandedSections.has("transform") && (
                      <div className="px-3 pb-3 pt-2 border-t border-blue-600/30 space-y-3">
                        {/* Mode buttons */}
                        <div className="flex gap-1">
                          <Button
                            variant={transformMode === "translate" ? "secondary" : "ghost"}
                            size="sm"
                            className="flex-1 h-7 text-xs"
                            onClick={() => {
                              sceneViewControlsRef.current?.setTransformMode("translate");
                              setTransformMode("translate");
                            }}
                          >
                            <Move className="h-3 w-3 mr-1" /> Di chuyển
                          </Button>
                          <Button
                            variant={transformMode === "rotate" ? "secondary" : "ghost"}
                            size="sm"
                            className="flex-1 h-7 text-xs"
                            onClick={() => {
                              sceneViewControlsRef.current?.setTransformMode("rotate");
                              setTransformMode("rotate");
                            }}
                          >
                            <RotateCcw className="h-3 w-3 mr-1" /> Xoay
                          </Button>
                          <Button
                            variant={transformMode === "scale" ? "secondary" : "ghost"}
                            size="sm"
                            className="flex-1 h-7 text-xs"
                            onClick={() => {
                              sceneViewControlsRef.current?.setTransformMode("scale");
                              setTransformMode("scale");
                            }}
                          >
                            <Maximize2 className="h-3 w-3 mr-1" /> Tỷ lệ
                          </Button>
                        </div>
                        {/* Editable value inputs */}
                        {transformValues && (
                          <div className="space-y-2">
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
                      </div>
                    )}
                  </div>
                )}

                {/* ---- Dynamic section cards ---- */}
                {(() => {
                  // The active (auto-expanded by selection) section renders first, rest in default order
                  const defaultOrder = ["cue", "camera", "cue-hdri", "lights", "background", "shadow"] as const;
                  const active = autoExpandedSectionRef.current;
                  const ordered = active ? [active, ...defaultOrder.filter((s) => s !== active)] : [...defaultOrder];

                  return ordered.map((sectionId) => {
                    switch (sectionId) {
                      case "cue":
                        return (
                          <div key="cue" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                              onClick={() => toggleSection("cue")}
                            >
                              <Box className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>Thiết lập Cơ</span>
                              <span className="flex-1" />
                              {expandedSections.has("cue") ? (
                                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </button>
                            {expandedSections.has("cue") && (
                              <div className="px-3 pb-3 pt-2 border-t border-border/30">
                                <CueSetupPanel cueConfig={config.cueConfig} onChange={(cueConfig) => updateConfig("cueConfig", cueConfig)} freePositionRange={isV2} />
                              </div>
                            )}
                          </div>
                        );
                      case "camera":
                        return (
                          <div key="camera" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                              onClick={() => toggleSection("camera")}
                            >
                              <Camera className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>Máy quay</span>
                              <span className="flex-1" />
                              {expandedSections.has("camera") ? (
                                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </button>
                            {expandedSections.has("camera") && (
                              <div className="px-3 pb-3 pt-2 border-t border-border/30">
                                <CameraControlsPanel
                                  cameraStart={capturedStart ?? config.cameraStart}
                                  cameraEnd={capturedEnd ?? config.cameraEnd}
                                  cameraPath={config.cameraPath ?? DEFAULT_CAMERA_PATH}
                                  cameraSpeed={config.cameraSpeed}
                                  easing={config.easing}
                                  fixedCameraDuration={config.fixedCameraDuration}
                                  onStartChange={(s) => updateConfig("cameraStart", s)}
                                  onEndChange={(e) => updateConfig("cameraEnd", e)}
                                  onSpeedChange={(s) => updateConfig("cameraSpeed", s)}
                                  onEasingChange={(e) => updateConfig("easing", e)}
                                  onFixedDurationChange={(d) => updateConfig("fixedCameraDuration", d)}
                                  onSetStart={handleSetStart}
                                  onSetEnd={handleSetEnd}
                                  onPathEnabledChange={handlePathEnabledChange}
                                  onApplyPathPreset={handleApplyPathPreset}
                                  onPathChange={handlePathChange}
                                  onShapeParamChange={handleShapeParamChange}
                                  onSetStartIndex={handleSetStartIndex}
                                  onSetEndIndex={handleSetEndIndex}
                                  onTrimToSpan={handleTrimToSpan}
                                  onAddWaypoint={handleAddWaypoint}
                                  onRemoveWaypoint={handleRemoveWaypoint}
                                  onFocusWaypoint={handleFocusWaypoint}
                                  onToggleSelectAll={handleToggleSelectAll}
                                  selectAllActive={selectAllActive}
                                  startPositionSet={capturedStart !== null}
                                  endPositionSet={capturedEnd !== null}
                                />
                              </div>
                            )}
                          </div>
                        );
                      case "background":
                        return (
                          <div key="background" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                              onClick={() => toggleSection("background")}
                            >
                              <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>{isV2 ? "Không gian 3D" : "Nền"}</span>
                              <span className="flex-1" />
                              {expandedSections.has("background") ? (
                                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </button>
                            {expandedSections.has("background") && (
                              <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                                {isV2 ? (
                                  /* V2 has no wall/table planes to style — this picks the
                                     real 3D space the cue is placed inside instead. */
                                  <EnvironmentPanel
                                    config={normalizeEnvironmentConfig(config.environment)}
                                    onChange={updateEnvironment}
                                    userAssets={userEnvAssets}
                                    onAddUserAsset={(asset) => {
                                      // Tracked so the object URL for a multi-megabyte HDRI
                                      // or room model is revoked when the studio unmounts.
                                      blobUrlsRef.current.push(asset.url);
                                      setUserEnvAssets((prev) => [
                                        ...prev.filter((a) => a.id !== asset.id),
                                        asset,
                                      ]);
                                    }}
                                    onRemoveUserAsset={(id) =>
                                      setUserEnvAssets((prev) => prev.filter((a) => a.id !== id))
                                    }
                                    loadError={envLoadError}
                                  />
                                ) : (
                                  <>
                                    <BackgroundPanel
                                      wallSurface={config.wallSurface}
                                      tableSurface={config.tableSurface}
                                      onWallSurfaceChange={(s) => updateConfig("wallSurface", s)}
                                      onTableSurfaceChange={(s) => updateConfig("tableSurface", s)}
                                      sceneBackground={sceneBackground}
                                      onSceneBackgroundChange={updateSceneBackground}
                                      cornerFill={cornerFill}
                                      onCornerFillChange={updateCornerFill}
                                    />
                                    <div className="border-t border-border/40 pt-2.5">
                                      <LogoBackdropPanel
                                        config={logoBackdrop}
                                        onChange={updateLogoBackdrop}
                                        productLogoId={productLogoId}
                                        onCustomUpload={(url) => blobUrlsRef.current.push(url)}
                                      />
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      case "cue-hdri":
                        return (
                          <div key="cue-hdri" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors"
                              onClick={() => toggleSection("cue-hdri")}
                            >
                              <Sun className="h-3.5 w-3.5 text-yellow-400" />
                              <span>HDRI Cơ</span>
                              <span className="flex-1" />
                              {expandedSections.has("cue-hdri") ? (
                                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </button>
                            {expandedSections.has("cue-hdri") && (
                              <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                                <p className="text-[10px] text-muted-foreground">Môi trường HDRI chỉ áp dụng cho cơ (không áp dụng cho bề mặt studio).</p>
                                {/* HDRI Type */}
                                <div className="space-y-0.5">
                                  <Label className="text-[10px] text-muted-foreground">Môi trường</Label>
                                  <Select
                                    value={config.cueHdri?.hdriType ?? DEFAULT_CUE_HDRI.hdriType}
                                    onValueChange={(v) => {
                                      setConfig((prev) => ({
                                        ...prev,
                                        cueHdri: { ...(prev.cueHdri ?? DEFAULT_CUE_HDRI), hdriType: v },
                                      }));
                                    }}
                                  >
                                    <SelectTrigger className="h-6 text-[10px]">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {HDRI_OPTIONS_FALLBACK.filter((h) => h.id !== STUDIO_WHITE_HDRI).map((h) => (
                                        <SelectItem key={h.id} value={h.id}>
                                          {h.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                {/* Rotation Y (Horizontal) */}
                                <div className="space-y-0.5">
                                  <Label className="text-[10px] text-muted-foreground">Ngang — {(config.cueHdri?.rotationY ?? DEFAULT_CUE_HDRI.rotationY).toFixed(0)}°</Label>
                                  <Slider
                                    value={[config.cueHdri?.rotationY ?? DEFAULT_CUE_HDRI.rotationY]}
                                    onValueChange={([v]) => {
                                      setConfig((prev) => ({
                                        ...prev,
                                        cueHdri: { ...(prev.cueHdri ?? DEFAULT_CUE_HDRI), rotationY: v },
                                      }));
                                    }}
                                    min={0}
                                    max={360}
                                    step={1}
                                  />
                                </div>
                                {/* Rotation X (Vertical) */}
                                <div className="space-y-0.5">
                                  <Label className="text-[10px] text-muted-foreground">Dọc — {(config.cueHdri?.rotationX ?? DEFAULT_CUE_HDRI.rotationX).toFixed(0)}°</Label>
                                  <Slider
                                    value={[config.cueHdri?.rotationX ?? DEFAULT_CUE_HDRI.rotationX]}
                                    onValueChange={([v]) => {
                                      setConfig((prev) => ({
                                        ...prev,
                                        cueHdri: { ...(prev.cueHdri ?? DEFAULT_CUE_HDRI), rotationX: v },
                                      }));
                                    }}
                                    min={0}
                                    max={360}
                                    step={1}
                                  />
                                </div>
                                {/* Intensity */}
                                <div className="space-y-0.5">
                                  <Label className="text-[10px] text-muted-foreground">
                                    Cường độ — {((config.cueHdri?.intensity ?? DEFAULT_CUE_HDRI.intensity) * 100).toFixed(0)}%
                                  </Label>
                                  <Slider
                                    value={[config.cueHdri?.intensity ?? DEFAULT_CUE_HDRI.intensity]}
                                    onValueChange={([v]) => {
                                      setConfig((prev) => ({
                                        ...prev,
                                        cueHdri: { ...(prev.cueHdri ?? DEFAULT_CUE_HDRI), intensity: v },
                                      }));
                                    }}
                                    min={0}
                                    max={3}
                                    step={0.05}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      case "lights":
                        return (
                          <div key="lights" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                            <div className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors">
                              <div
                                role="button"
                                tabIndex={0}
                                className="flex items-center gap-2 flex-1 cursor-pointer"
                                onClick={() => toggleSection("lights")}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggleSection("lights");
                                  }
                                }}
                              >
                                <Lightbulb className="h-3.5 w-3.5 text-muted-foreground" />
                                <span>Đèn Studio</span>
                                <span className="ml-1 text-muted-foreground/60">
                                  ({config.hdriConfig.layers.filter((l) => l.enabled !== false).length}/{config.hdriConfig.layers.length})
                                </span>
                              </div>
                              {config.hdriConfig.layers.length < 3 && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-5 w-5 p-0"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const layers = [...config.hdriConfig.layers];
                                    const newLayer = createDefaultHdriLayer();
                                    // Offset rotation for each new layer
                                    newLayer.rotationY = (layers.length * 120) % 360;
                                    newLayer.intensity = 0.5;
                                    layers.push(newLayer);
                                    setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                  }}
                                >
                                  <Plus className="h-3 w-3" />
                                </Button>
                              )}
                              <div
                                role="button"
                                tabIndex={0}
                                className="cursor-pointer"
                                onClick={() => toggleSection("lights")}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggleSection("lights");
                                  }
                                }}
                              >
                                {expandedSections.has("lights") ? (
                                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                              </div>
                            </div>
                            {expandedSections.has("lights") && (
                              <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                                <p className="text-[10px] text-muted-foreground">Đèn studio kiểm soát hướng bóng và ánh sáng bề mặt. Nhấn G để di chuyển, S để thu phóng.</p>
                                {/* Surface light disable toggle */}
                                <label className="flex items-center gap-2 cursor-pointer select-none">
                                  <Checkbox
                                    checked={config.surfaceLightDisabled === true}
                                    onCheckedChange={(checked) => updateConfig("surfaceLightDisabled", checked === true)}
                                    className="h-3 w-3"
                                  />
                                  <span className="text-[10px] text-muted-foreground leading-tight">
                                    Tắt ảnh hưởng đèn lên bề mặt <span className="text-muted-foreground/50">(tường & bàn trắng thuần)</span>
                                  </span>
                                </label>
                                {config.hdriConfig.layers.map((layer, idx) => (
                                  <div key={layer.id} className="rounded-md border border-border/40 bg-background/30 p-2 space-y-2">
                                    {/* Header */}
                                    <div className="flex items-center gap-1.5">
                                      <Checkbox
                                        checked={layer.enabled !== false}
                                        onCheckedChange={(checked) => {
                                          const layers = [...config.hdriConfig.layers];
                                          layers[idx] = { ...layers[idx], enabled: checked === true };
                                          setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                        }}
                                        className="h-3 w-3"
                                      />
                                      <Sun className="h-3 w-3 text-green-400" />
                                      <span className="text-[10px] font-medium flex-1">Đèn Studio {idx + 1}</span>
                                      {config.hdriConfig.layers.length > 1 && (
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                                          onClick={() => {
                                            const layers = config.hdriConfig.layers.filter((_, i) => i !== idx);
                                            setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                          }}
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </Button>
                                      )}
                                    </div>
                                    {/* Studio lights are always Studio White — no HDRI dropdown */}
                                    <div className="space-y-0.5">
                                      <Label className="text-[10px] text-muted-foreground">Môi trường</Label>
                                      <div className="h-6 px-2 flex items-center rounded-md border border-border/40 bg-muted/30 text-[10px] text-muted-foreground">
                                        Studio White
                                      </div>
                                    </div>
                                    {/* Light Color */}
                                    <div className="space-y-0.5">
                                      <Label className="text-[10px] text-muted-foreground">Màu đèn</Label>
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          type="color"
                                          value={layer.lightColor ?? "#ffffff"}
                                          onChange={(e) => {
                                            const layers = [...config.hdriConfig.layers];
                                            layers[idx] = { ...layers[idx], lightColor: e.target.value };
                                            setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                          }}
                                          className="w-6 h-6 rounded cursor-pointer border border-border/50 p-0"
                                        />
                                        <span className="text-[10px] text-muted-foreground font-mono">{(layer.lightColor ?? "#ffffff").toUpperCase()}</span>
                                      </div>
                                    </div>
                                    {/* Intensity */}
                                    <div className="space-y-0.5">
                                      <Label className="text-[10px] text-muted-foreground">Cường độ — {((layer.intensity ?? 1) * 100).toFixed(0)}%</Label>
                                      <Slider
                                        value={[layer.intensity ?? 1]}
                                        onValueChange={([v]) => {
                                          const layers = [...config.hdriConfig.layers];
                                          layers[idx] = { ...layers[idx], intensity: v };
                                          setConfig((prev) => ({ ...prev, hdriConfig: { layers } }));
                                        }}
                                        min={0}
                                        max={3}
                                        step={0.05}
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      case "shadow":
                        return (
                          <div key="shadow" className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
                            <div
                              role="button"
                              tabIndex={0}
                              className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors cursor-pointer"
                              onClick={() => toggleSection("shadow")}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggleSection("shadow");
                                }
                              }}
                            >
                              <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>Bóng</span>
                              <span className="flex-1" />
                              <Checkbox
                                checked={config.shadow.enabled}
                                onCheckedChange={(checked) => {
                                  updateConfig("shadow", {
                                    ...config.shadow,
                                    enabled: checked === true,
                                  });
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="h-3.5 w-3.5"
                              />
                              {expandedSections.has("shadow") ? (
                                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </div>
                            {expandedSections.has("shadow") && config.shadow.enabled && (
                              <div className="px-3 pb-3 pt-2 border-t border-border/30 space-y-3">
                                <div className="space-y-1.5">
                                  <Label className="text-xs text-muted-foreground">Cường độ — {Math.round(config.shadow.intensity * 100)}%</Label>
                                  <Slider
                                    value={[config.shadow.intensity]}
                                    onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, intensity: v })}
                                    min={0}
                                    max={1}
                                    step={0.05}
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs text-muted-foreground">Làm mờ — {config.shadow.blur ?? 3}</Label>
                                  <Slider
                                    value={[config.shadow.blur ?? 3]}
                                    onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, blur: v })}
                                    min={0}
                                    max={10}
                                    step={0.5}
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs text-muted-foreground">Độ mềm — {((config.shadow.softness ?? 0.45) * 100).toFixed(0)}%</Label>
                                  <Slider
                                    value={[config.shadow.softness ?? 0.45]}
                                    onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, softness: v })}
                                    min={0}
                                    max={1}
                                    step={0.05}
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs text-muted-foreground">Bù X — {(config.shadow.offsetX ?? 0).toFixed(1)}</Label>
                                  <Slider
                                    value={[config.shadow.offsetX ?? 0]}
                                    onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, offsetX: v })}
                                    min={-5}
                                    max={5}
                                    step={0.2}
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs text-muted-foreground">Bù Y — {(config.shadow.offsetY ?? 0).toFixed(1)}</Label>
                                  <Slider
                                    value={[config.shadow.offsetY ?? 0]}
                                    onValueChange={([v]) => updateConfig("shadow", { ...config.shadow, offsetY: v })}
                                    min={-5}
                                    max={5}
                                    step={0.2}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      default:
                        return null;
                    }
                  });
                })()}
              </div>
            </div>
          </div>
          {/* end editor tab inner flex */}
        </div>
        {/* end outer relative container */}

        {/* Footer */}
        <DialogFooter className="px-6 py-4 border-t border-border">
          <div className="flex items-center gap-2 w-full">
            <Button variant="outline" size="sm" onClick={handleReset} disabled={isRecording}>
              <RotateCcw className="h-4 w-4 mr-1" /> Đặt lại
            </Button>
            <div className="flex-1" />
            {isRecording ? (
              <Button variant="destructive" size="sm" onClick={handleStop}>
                <Square className="h-4 w-4 mr-1" /> Dừng
              </Button>
            ) : videoUrl ? (
              <>
                <Button variant="outline" size="sm" onClick={handleRecord}>
                  <RefreshCw className="h-4 w-4 mr-1" /> Ghi lại
                </Button>
                <Button size="sm" onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-1" /> Tải xuống
                </Button>
              </>
            ) : (
              <>
                {capturedStart && capturedEnd ? (
                  <>
                    {(() => {
                      const sec = computeVideoDuration(
                        capturedStart,
                        capturedEnd,
                        config.cameraSpeed,
                        "xyz",
                        isCameraFixed(capturedStart, capturedEnd, config.cameraPath) ? config.fixedCameraDuration : undefined,
                        config.cameraPath
                      );
                      const m = Math.floor(sec / 60);
                      const s = Math.round(sec % 60);
                      const label = m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${sec.toFixed(1)}s`;
                      return <span className="text-xs text-muted-foreground tabular-nums">{label}</span>;
                    })()}
                    <Button size="sm" onClick={handleRecord}>
                      <Video className="h-4 w-4 mr-1" /> Ghi
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {!capturedStart && !capturedEnd ? "Cần đặt vị trí bắt đầu và kết thúc" : !capturedStart ? "Cần đặt vị trí bắt đầu" : "Cần đặt vị trí kết thúc"}
                  </span>
                )}
              </>
            )}
            <Button variant="outline" size="sm" onClick={() => templateSelectorRef.current?.triggerSave()} disabled={isRecording}>
              <Save className="h-4 w-4 mr-1" /> Lưu Mẫu
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
