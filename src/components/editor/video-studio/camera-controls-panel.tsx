"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Gauge, Crosshair, Route, Plus, Trash2, Scissors, BoxSelect } from "lucide-react";
import type {
  CameraKeyframe,
  CameraPathConfig,
  CameraCurveType,
  CameraLookMode,
  CameraShapeParams,
  EasingConfig,
} from "@/types/video-studio";
import {
  EASING_PRESETS,
  MAX_CAMERA_WAYPOINTS,
  computeVideoDuration,
  isCameraFixed,
  getCameraPathSpan,
  normalizeLookMode,
  CAMERA_LOOK_MODES,
} from "@/types/video-studio";
import {
  CAMERA_PATH_PRESETS,
  CAMERA_SHAPE_PARAM_META,
  getCameraPathPreset,
} from "@/lib/three/camera-path";

interface CameraControlsPanelProps {
  cameraStart: CameraKeyframe;
  cameraEnd: CameraKeyframe;
  cameraPath: CameraPathConfig;
  cameraSpeed: number;
  easing: EasingConfig;
  fixedCameraDuration?: number;
  /** Turn curve mode on/off. Off = legacy two-button placement. */
  onPathEnabledChange: (enabled: boolean) => void;
  /** Apply a shape preset — regenerates the whole curve around the cue. */
  onApplyPathPreset: (presetId: string) => void;
  onPathChange: (patch: Partial<CameraPathConfig>) => void;
  /** Resize the active shape; regenerates the curve live. */
  onShapeParamChange: (key: keyof CameraShapeParams, value: number) => void;
  /** Pick the recorded span's start; also moves the camera to that point. */
  onSetStartIndex: (index: number) => void;
  onSetEndIndex: (index: number) => void;
  /** Delete every waypoint outside the picked span. */
  onTrimToSpan: () => void;
  /** Insert a point at the midpoint of the longest segment. */
  onAddWaypoint: () => void;
  onRemoveWaypoint: (id: string) => void;
  /** Focus/select a waypoint's gizmo in the 3D scene view. */
  onFocusWaypoint?: (index: number) => void;
  /** Select the whole curve so dragging moves every point together. */
  onToggleSelectAll: (active: boolean) => void;
  selectAllActive?: boolean;
  onStartChange: (k: CameraKeyframe) => void;
  onEndChange: (k: CameraKeyframe) => void;
  onSpeedChange: (s: number) => void;
  onEasingChange: (e: EasingConfig) => void;
  onFixedDurationChange?: (d: number) => void;
  onSetStart: () => void;
  onSetEnd: () => void;
  startPositionSet?: boolean;
  endPositionSet?: boolean;
}

function KeyframeDisplay({ title, keyframe, onSet, positionSet = false }: { title: string; keyframe: CameraKeyframe; onSet: () => void; positionSet?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-medium">{title}</Label>
        <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={onSet}>
          <Crosshair className="h-3 w-3 mr-1" />
          Đặt
        </Button>
      </div>
      {positionSet && (
        <div className="flex gap-3 text-[11px] tabular-nums text-muted-foreground bg-muted/60 rounded px-2 py-1">
          <span>
            X <span className="text-foreground">{keyframe.x.toFixed(2)}</span>
          </span>
          <span>
            Y <span className="text-foreground">{keyframe.y.toFixed(2)}</span>
          </span>
          <span>
            Z <span className="text-foreground">{keyframe.z.toFixed(2)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

export function CameraControlsPanel({
  cameraStart,
  cameraEnd,
  cameraPath,
  cameraSpeed,
  easing,
  fixedCameraDuration = 10,
  onPathEnabledChange,
  onApplyPathPreset,
  onPathChange,
  onShapeParamChange,
  onSetStartIndex,
  onSetEndIndex,
  onTrimToSpan,
  onAddWaypoint,
  onRemoveWaypoint,
  onFocusWaypoint,
  onToggleSelectAll,
  selectAllActive = false,
  onSpeedChange,
  onEasingChange,
  onFixedDurationChange,
  onSetStart,
  onSetEnd,
  startPositionSet,
  endPositionSet,
}: CameraControlsPanelProps) {
  const handleEasingChange = useCallback(
    (presetId: string) => {
      onEasingChange({ type: "preset", preset: presetId });
    },
    [onEasingChange]
  );

  const isFixed = isCameraFixed(cameraStart, cameraEnd, cameraPath);
  const pathEnabled = cameraPath.enabled;
  const activePreset = getCameraPathPreset(cameraPath.shapeId);
  const spanLength = getCameraPathSpan(cameraPath).length;
  const canTrim = pathEnabled && spanLength >= 2 && spanLength < cameraPath.waypoints.length;

  // Which waypoint indices fall inside the recorded span — drives the dimming of rows
  // outside it. Mirrors the wrap-around logic used for the 3D overlay.
  const spanIndices = useMemo(() => {
    const n = cameraPath.waypoints.length;
    const out = new Set<number>();
    if (n === 0) return out;
    const a = Math.max(0, Math.min(n - 1, cameraPath.startIndex));
    const b = Math.max(0, Math.min(n - 1, cameraPath.endIndex));
    if (a === b) { out.add(a); return out; }
    if (a < b) {
      for (let i = a; i <= b; i++) out.add(i);
    } else if (cameraPath.closed) {
      for (let i = a; i < n; i++) out.add(i);
      for (let i = 0; i <= b; i++) out.add(i);
    } else {
      for (let i = b; i <= a; i++) out.add(i);
    }
    return out;
  }, [cameraPath.waypoints.length, cameraPath.startIndex, cameraPath.endIndex, cameraPath.closed]);
  const [localDuration, setLocalDuration] = useState<string | null>(null);

  const commitDuration = (str: string) => {
    setLocalDuration(null);
    const v = parseFloat(str);
    if (!isNaN(v) && onFixedDurationChange) {
      onFixedDurationChange(Math.max(3, Math.min(300, v)));
    }
  };

  return (
    <div className="space-y-4">
      {/* Camera placement hint */}
      <p className="text-[10px] text-muted-foreground bg-muted rounded px-2 py-1.5 leading-relaxed">
        Chuyển sang <span className="font-semibold text-foreground">Chỉnh sửa</span>, di chuyển camera đến vị trí bạn muốn và nhấn{" "}
        <span className="font-semibold text-foreground">&ldquo;Đặt&rdquo;</span> để lưu vị trí điểm đầu và điểm cuối.
      </p>

      {/* Start Position */}
      <KeyframeDisplay title="Vị trí bắt đầu" keyframe={cameraStart} onSet={onSetStart} positionSet={startPositionSet} />

      {/* End Position */}
      <KeyframeDisplay title="Vị trí kết thúc" keyframe={cameraEnd} onSet={onSetEnd} positionSet={endPositionSet} />

      {/* ── Camera path: cue-anchored shape, start/end picked on the curve ── */}
      <div className="space-y-2.5 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium flex items-center gap-1">
            <Route className="h-3 w-3" /> Đường đi camera
          </Label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <span className="text-[10px] text-muted-foreground">
              {pathEnabled ? "Bật" : "Tắt"}
            </span>
            <Checkbox
              checked={pathEnabled}
              onCheckedChange={(checked) => onPathEnabledChange(checked === true)}
            />
          </label>
        </div>

        {!pathEnabled ? (
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Đang chọn điểm bình thường — dùng 2 nút <span className="font-semibold text-foreground">&ldquo;Đặt&rdquo;</span> ở trên.
            Bật để camera chạy theo đường cong quanh cây cue.
          </p>
        ) : (
          <>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Đường cong vẽ quanh cây cue (không phụ thuộc camera). Chọn{" "}
              <span className="text-[#22cc66] font-semibold">điểm bắt đầu</span> và{" "}
              <span className="text-[#ff3355] font-semibold">điểm kết thúc</span> trên đường — camera sẽ nhảy tới điểm bắt đầu.
            </p>

            {/* Shape presets */}
            <div className="grid grid-cols-4 gap-1.5">
              {CAMERA_PATH_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  variant={cameraPath.shapeId === preset.id ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-[11px] px-1"
                  title={preset.description}
                  onClick={() => onApplyPathPreset(preset.id)}
                >
                  {preset.name}
                </Button>
              ))}
            </div>

            {/* Shape size sliders — only the params this shape uses */}
            {activePreset && (
              <div className="space-y-2 rounded-md bg-muted/40 px-2.5 py-2">
                {activePreset.params.map((key) => {
                  const meta = CAMERA_SHAPE_PARAM_META[key];
                  const value = cameraPath.shapeParams[key];
                  return (
                    <div key={key} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] text-muted-foreground">{meta.label}</Label>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {meta.step >= 1 ? value.toFixed(0) : value.toFixed(2)}
                        </span>
                      </div>
                      <Slider
                        value={[value]}
                        onValueChange={([v]) => onShapeParamChange(key, v)}
                        min={meta.min}
                        max={meta.max}
                        step={meta.step}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {/* Select-all: highlight the curve green and move every point together */}
            <Button
              variant={selectAllActive ? "default" : "outline"}
              size="sm"
              className="h-7 w-full text-[11px]"
              onClick={() => onToggleSelectAll(!selectAllActive)}
            >
              <BoxSelect className="h-3 w-3 mr-1" />
              {selectAllActive ? "Đang chọn tất cả — kéo để di chuyển" : "Chọn tất cả"}
            </Button>

            {selectAllActive && (
              <p className="text-[10px] text-muted-foreground bg-muted rounded px-2 py-1.5 leading-relaxed">
                Nhấn <span className="font-semibold text-foreground">R</span> rồi di chuột để quay cả đường cong quanh tâm.
                Thêm <span className="font-semibold text-foreground">X / Y / Z</span> để chọn trục (mặc định Y).
                <span className="font-semibold text-foreground"> Esc</span> để huỷ.
              </p>
            )}

            {/* Waypoint list — click Đầu/Cuối to pick the recorded span */}
            <div className="space-y-1 max-h-52 overflow-y-auto pr-0.5">
              {cameraPath.waypoints.map((wp, index) => {
                const isStart = index === cameraPath.startIndex;
                const isEnd = index === cameraPath.endIndex;
                const inSpan = spanIndices.has(index);
                return (
                  <div
                    key={wp.id}
                    className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] tabular-nums transition-opacity ${
                      inSpan ? "bg-muted/60" : "bg-muted/20 opacity-50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onFocusWaypoint?.(index)}
                      className="w-4 shrink-0 text-center font-medium text-muted-foreground hover:text-foreground"
                      title="Chọn điểm này trong khung 3D"
                    >
                      {index + 1}
                    </button>
                    <span className="flex-1 truncate text-muted-foreground">
                      <span className="text-foreground">{wp.x.toFixed(1)}</span>
                      {" / "}
                      <span className="text-foreground">{wp.y.toFixed(1)}</span>
                      {" / "}
                      <span className="text-foreground">{wp.z.toFixed(1)}</span>
                    </span>
                    <Button
                      variant={isStart ? "default" : "ghost"}
                      size="sm"
                      className={`h-5 px-1.5 text-[10px] shrink-0 ${
                        isStart ? "bg-[#22cc66] hover:bg-[#22cc66]/90 text-black" : ""
                      }`}
                      title="Đặt làm điểm bắt đầu"
                      onClick={() => onSetStartIndex(index)}
                    >
                      Đầu
                    </Button>
                    <Button
                      variant={isEnd ? "default" : "ghost"}
                      size="sm"
                      className={`h-5 px-1.5 text-[10px] shrink-0 ${
                        isEnd ? "bg-[#ff3355] hover:bg-[#ff3355]/90 text-white" : ""
                      }`}
                      title="Đặt làm điểm kết thúc"
                      onClick={() => onSetEndIndex(index)}
                    >
                      Cuối
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 shrink-0 text-destructive hover:text-destructive"
                      title="Xoá điểm"
                      onClick={() => onRemoveWaypoint(wp.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 flex-1 text-[11px]"
                disabled={cameraPath.waypoints.length >= MAX_CAMERA_WAYPOINTS}
                onClick={onAddWaypoint}
              >
                <Plus className="h-3 w-3 mr-1" />
                Thêm điểm ({cameraPath.waypoints.length}/{MAX_CAMERA_WAYPOINTS})
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 flex-1 text-[11px]"
                disabled={!canTrim}
                title="Xoá các điểm ngoài vùng đầu→cuối"
                onClick={onTrimToSpan}
              >
                <Scissors className="h-3 w-3 mr-1" />
                Cắt ngoài vùng
              </Button>
            </div>

            {/* Curve type */}
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Kiểu đường</Label>
              <Select
                value={cameraPath.curveType}
                onValueChange={(v) => onPathChange({ curveType: v as CameraCurveType })}
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="centripetal">Mềm (không tự cắt)</SelectItem>
                  <SelectItem value="chordal">Mềm theo khoảng cách</SelectItem>
                  <SelectItem value="catmullrom">Mềm đều (có độ căng)</SelectItem>
                  <SelectItem value="linear">Gấp khúc (góc nhọn)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {cameraPath.curveType === "catmullrom" && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[11px] text-muted-foreground">Độ căng</Label>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {cameraPath.tension.toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[cameraPath.tension]}
                  onValueChange={([v]) => onPathChange({ tension: v })}
                  min={0}
                  max={1}
                  step={0.05}
                />
              </div>
            )}

            {/* Camera orientation along the path */}
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Hướng camera</Label>
              <Select
                value={normalizeLookMode(cameraPath.lookMode)}
                onValueChange={(v) => onPathChange({ lookMode: v as CameraLookMode })}
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAMERA_LOOK_MODES.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>

      {/* Camera Speed — only relevant when camera actually moves */}
      {!isFixed && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Tốc độ camera</Label>
            <span className="text-xs text-muted-foreground tabular-nums">{cameraSpeed.toFixed(2)}</span>
          </div>
          <Slider value={[cameraSpeed]} onValueChange={([v]) => onSpeedChange(v)} min={0.1} max={2} step={0.05} />
        </div>
      )}

      {/* Easing */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground flex items-center gap-1">
          <Gauge className="h-3 w-3" /> Chuyển động
        </Label>
        <Select value={easing.type === "preset" ? easing.preset : undefined} onValueChange={handleEasingChange}>
          <SelectTrigger className="h-8">
            <SelectValue placeholder="Chọn chuyển động…" />
          </SelectTrigger>
          <SelectContent>
            {EASING_PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} — {p.feel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Duration — editable when fixed camera, computed when moving */}
      <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
        <Label className="text-xs text-muted-foreground">Thời lượng</Label>
        {isFixed ? (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              inputMode="numeric"
              value={localDuration !== null ? localDuration : fixedCameraDuration}
              onChange={(e) => setLocalDuration(e.target.value)}
              onBlur={(e) => commitDuration(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commitDuration((e.target as HTMLInputElement).value); }}
              className="w-16 text-right text-sm font-medium tabular-nums bg-transparent border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-xs text-muted-foreground">s</span>
          </div>
        ) : (
          <span className="text-sm font-medium tabular-nums">
            {(() => {
              const sec = computeVideoDuration(cameraStart, cameraEnd, cameraSpeed, "xyz", undefined, cameraPath);
              const m = Math.floor(sec / 60);
              const s = Math.round(sec % 60);
              return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${sec.toFixed(1)}s`;
            })()}
          </span>
        )}
      </div>
    </div>
  );
}
