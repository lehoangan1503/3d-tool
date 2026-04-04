"use client";

import { useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Video, Gauge } from "lucide-react";
import type { CameraPosition, EasingConfig } from "@/types/video-studio";
import {
  CAMERA_MOVEMENT_PRESETS,
  EASING_PRESETS,
  computeVideoDuration,
} from "@/types/video-studio";

interface CameraControlsPanelProps {
  cameraStart: CameraPosition;
  cameraEnd: CameraPosition;
  cameraSpeed: number;
  easing: EasingConfig;
  onCameraStartChange: (start: CameraPosition) => void;
  onCameraEndChange: (end: CameraPosition) => void;
  onCameraSpeedChange: (speed: number) => void;
  onEasingChange: (easing: EasingConfig) => void;
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

function PositionSection({
  title,
  position,
  onChange,
}: {
  title: string;
  position: CameraPosition;
  onChange: (pos: CameraPosition) => void;
}) {
  const update = useCallback(
    (key: keyof CameraPosition, value: number) => {
      onChange({ ...position, [key]: value });
    },
    [position, onChange],
  );

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium">{title}</Label>
      <PositionSlider
        label="Distance"
        value={position.distance}
        onChange={(v) => update("distance", v)}
        min={0.5}
        max={5}
        step={0.1}
      />
      <PositionSlider
        label="Pan X"
        value={position.panX}
        onChange={(v) => update("panX", v)}
        min={-2}
        max={2}
        step={0.1}
      />
      <PositionSlider
        label="Pan Y"
        value={position.panY}
        onChange={(v) => update("panY", v)}
        min={-2}
        max={2}
        step={0.1}
      />
      <PositionSlider
        label="Dutch Tilt"
        value={position.dutchTilt}
        onChange={(v) => update("dutchTilt", v)}
        min={-45}
        max={45}
        step={1}
        decimals={0}
      />
    </div>
  );
}

export function CameraControlsPanel({
  cameraStart,
  cameraEnd,
  cameraSpeed,
  easing,
  onCameraStartChange,
  onCameraEndChange,
  onCameraSpeedChange,
  onEasingChange,
}: CameraControlsPanelProps) {
  const duration = computeVideoDuration(cameraStart, cameraEnd, cameraSpeed);

  const handlePresetChange = useCallback(
    (presetId: string) => {
      const preset = CAMERA_MOVEMENT_PRESETS.find((p) => p.id === presetId);
      if (preset) {
        onCameraStartChange({ ...preset.start });
        onCameraEndChange({ ...preset.end });
      }
    },
    [onCameraStartChange, onCameraEndChange],
  );

  const handleEasingChange = useCallback(
    (presetId: string) => {
      onEasingChange({ type: "preset", preset: presetId });
    },
    [onEasingChange],
  );

  return (
    <div className="space-y-4">
      {/* Movement Preset */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground flex items-center gap-1">
          <Video className="h-3 w-3" /> Movement Preset
        </Label>
        <Select onValueChange={handlePresetChange}>
          <SelectTrigger className="h-8">
            <SelectValue placeholder="Choose a preset…" />
          </SelectTrigger>
          <SelectContent>
            {CAMERA_MOVEMENT_PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Start Position */}
      <PositionSection
        title="Start Position"
        position={cameraStart}
        onChange={onCameraStartChange}
      />

      {/* End Position */}
      <PositionSection
        title="End Position"
        position={cameraEnd}
        onChange={onCameraEndChange}
      />

      {/* Camera Speed */}
      <PositionSlider
        label="Camera Speed"
        value={cameraSpeed}
        onChange={onCameraSpeedChange}
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
          {duration.toFixed(1)}s
        </span>
      </div>
    </div>
  );
}
