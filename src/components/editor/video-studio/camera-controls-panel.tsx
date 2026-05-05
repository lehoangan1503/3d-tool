"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Gauge, Crosshair } from "lucide-react";
import type { CameraKeyframe, EasingConfig } from "@/types/video-studio";
import { EASING_PRESETS, computeVideoDuration } from "@/types/video-studio";

interface CameraControlsPanelProps {
  cameraStart: CameraKeyframe;
  cameraEnd: CameraKeyframe;
  cameraSpeed: number;
  easing: EasingConfig;
  onStartChange: (k: CameraKeyframe) => void;
  onEndChange: (k: CameraKeyframe) => void;
  onSpeedChange: (s: number) => void;
  onEasingChange: (e: EasingConfig) => void;
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
  cameraSpeed,
  easing,
  onSpeedChange,
  onEasingChange,
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

      {/* Camera Speed */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Tốc độ camera</Label>
          <span className="text-xs text-muted-foreground tabular-nums">{cameraSpeed.toFixed(2)}</span>
        </div>
        <Slider value={[cameraSpeed]} onValueChange={([v]) => onSpeedChange(v)} min={0.1} max={2} step={0.05} />
      </div>

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

      {/* Computed Duration */}
      <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
        <Label className="text-xs text-muted-foreground">Thời lượng</Label>
        <span className="text-sm font-medium tabular-nums">
          {(() => {
            const sec = computeVideoDuration(cameraStart, cameraEnd, cameraSpeed, "xyz");
            const m = Math.floor(sec / 60);
            const s = Math.round(sec % 60);
            return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${sec.toFixed(1)}s`;
          })()}
        </span>
      </div>
    </div>
  );
}
