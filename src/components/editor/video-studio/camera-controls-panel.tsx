"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Video, Gauge, Lock, Unlock, Crosshair } from "lucide-react";
import type {
  CameraKeyframe,
  CameraDirection,
  EasingConfig,
} from "@/types/video-studio";
import {
  CAMERA_DIRECTION_PRESETS,
  EASING_PRESETS,
  computeVideoDuration,
} from "@/types/video-studio";

interface CameraControlsPanelProps {
  cameraDirection: CameraDirection;
  cameraStart: CameraKeyframe;
  cameraEnd: CameraKeyframe;
  cameraSpeed: number;
  lockDistance: boolean;
  easing: EasingConfig;
  onDirectionChange: (d: CameraDirection) => void;
  onStartChange: (k: CameraKeyframe) => void;
  onEndChange: (k: CameraKeyframe) => void;
  onSpeedChange: (s: number) => void;
  onLockDistanceChange: (locked: boolean) => void;
  onEasingChange: (e: EasingConfig) => void;
  onSetStart: () => void;
  onSetEnd: () => void;
}

function PositionSlider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  decimals = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  decimals?: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {value.toFixed(decimals)}
        </span>
      </div>
      <Slider
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        min={min}
        max={max}
        step={step}
      />
    </div>
  );
}

function KeyframeSection({
  title,
  keyframe,
  onChange,
  onSet,
  lockDistance,
  onSiblingDistanceSync,
}: {
  title: string;
  keyframe: CameraKeyframe;
  onChange: (k: CameraKeyframe) => void;
  onSet: () => void;
  lockDistance: boolean;
  onSiblingDistanceSync?: (dist: number) => void;
}) {
  const update = (key: keyof CameraKeyframe, value: number) => {
    const updated = { ...keyframe, [key]: value };
    onChange(updated);
    if (key === "distanceFromCue" && lockDistance && onSiblingDistanceSync) {
      onSiblingDistanceSync(value);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-medium">{title}</Label>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs px-2"
          onClick={onSet}
        >
          <Crosshair className="h-3 w-3 mr-1" /> Set
        </Button>
      </div>
      <PositionSlider
        label="Cue %"
        value={keyframe.cuePercent}
        onChange={(v) => update("cuePercent", v)}
        min={0}
        max={100}
        step={1}
        decimals={0}
      />
      <PositionSlider
        label="Distance"
        value={keyframe.distanceFromCue}
        onChange={(v) => update("distanceFromCue", v)}
        min={0.5}
        max={5}
        step={0.1}
      />
      <PositionSlider
        label="Offset X"
        value={keyframe.offsetX}
        onChange={(v) => update("offsetX", v)}
        min={-2}
        max={2}
        step={0.1}
      />
    </div>
  );
}

export function CameraControlsPanel({
  cameraDirection,
  cameraStart,
  cameraEnd,
  cameraSpeed,
  lockDistance,
  easing,
  onDirectionChange,
  onStartChange,
  onEndChange,
  onSpeedChange,
  onLockDistanceChange,
  onEasingChange,
  onSetStart,
  onSetEnd,
}: CameraControlsPanelProps) {
  const handleEasingChange = useCallback(
    (presetId: string) => {
      onEasingChange({ type: "preset", preset: presetId });
    },
    [onEasingChange],
  );

  return (
    <div className="space-y-4">
      {/* Direction Preset */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground flex items-center gap-1">
          <Video className="h-3 w-3" /> Direction
        </Label>
        <Select
          value={cameraDirection}
          onValueChange={(v) => onDirectionChange(v as CameraDirection)}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CAMERA_DIRECTION_PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} — {p.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Start Position */}
      <KeyframeSection
        title="Start Position"
        keyframe={cameraStart}
        onChange={onStartChange}
        onSet={onSetStart}
        lockDistance={lockDistance}
        onSiblingDistanceSync={(dist) =>
          onEndChange({ ...cameraEnd, distanceFromCue: dist })
        }
      />

      {/* End Position */}
      <KeyframeSection
        title="End Position"
        keyframe={cameraEnd}
        onChange={onEndChange}
        onSet={onSetEnd}
        lockDistance={lockDistance}
        onSiblingDistanceSync={(dist) =>
          onStartChange({ ...cameraStart, distanceFromCue: dist })
        }
      />

      {/* Lock Distance */}
      <Button
        variant={lockDistance ? "secondary" : "outline"}
        size="sm"
        className="h-7 text-xs w-full"
        onClick={() => onLockDistanceChange(!lockDistance)}
      >
        {lockDistance ? (
          <Lock className="h-3 w-3 mr-1" />
        ) : (
          <Unlock className="h-3 w-3 mr-1" />
        )}
        {lockDistance ? "Distance Locked" : "Lock Distance"}
      </Button>

      {/* Camera Speed */}
      <PositionSlider
        label="Camera Speed"
        value={cameraSpeed}
        onChange={onSpeedChange}
        min={0.1}
        max={2}
        step={0.05}
        decimals={2}
      />

      {/* Easing */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground flex items-center gap-1">
          <Gauge className="h-3 w-3" /> Easing
        </Label>
        <Select
          value={easing.type === "preset" ? easing.preset : undefined}
          onValueChange={handleEasingChange}
        >
          <SelectTrigger className="h-8">
            <SelectValue placeholder="Select easing…" />
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
        <Label className="text-xs text-muted-foreground">Duration</Label>
        <span className="text-sm font-medium tabular-nums">
          {computeVideoDuration(cameraStart, cameraEnd, cameraSpeed).toFixed(1)}
          s
        </span>
      </div>
    </div>
  );
}
