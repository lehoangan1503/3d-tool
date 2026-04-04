"use client";

import { useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { RotateCcw, ZoomIn, Move } from "lucide-react";
import type { VideoCuePosition } from "@/types/video-studio";

interface CueSetupPanelProps {
  cuePosition: VideoCuePosition;
  onChange: (pos: VideoCuePosition) => void;
}

export function CueSetupPanel({ cuePosition, onChange }: CueSetupPanelProps) {
  const update = useCallback(
    (key: keyof VideoCuePosition, value: number) => {
      onChange({ ...cuePosition, [key]: value });
    },
    [cuePosition, onChange],
  );

  const spinYDeg = Math.round(cuePosition.spinY * (180 / Math.PI));
  const phiDeg = Math.round(cuePosition.phi * (180 / Math.PI));

  return (
    <div className="space-y-3">
      {/* Spin Y */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground flex items-center gap-1">
            <RotateCcw className="h-3 w-3" /> Spin Y
          </Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {spinYDeg}°
          </span>
        </div>
        <Slider
          value={[spinYDeg]}
          onValueChange={([v]) => update("spinY", v * (Math.PI / 180))}
          min={0}
          max={360}
          step={1}
        />
      </div>

      {/* Camera Angle (phi) */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Camera Angle</Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {phiDeg}°
          </span>
        </div>
        <Slider
          value={[phiDeg]}
          onValueChange={([v]) => update("phi", v * (Math.PI / 180))}
          min={0}
          max={180}
          step={1}
        />
      </div>

      {/* Zoom */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground flex items-center gap-1">
            <ZoomIn className="h-3 w-3" /> Zoom
          </Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {cuePosition.zoom.toFixed(2)}x
          </span>
        </div>
        <Slider
          value={[cuePosition.zoom]}
          onValueChange={([v]) => update("zoom", v)}
          min={0.5}
          max={3}
          step={0.05}
        />
      </div>

      {/* Offset X */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground flex items-center gap-1">
            <Move className="h-3 w-3" /> Offset X
          </Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {cuePosition.offsetX.toFixed(2)}
          </span>
        </div>
        <Slider
          value={[cuePosition.offsetX]}
          onValueChange={([v]) => update("offsetX", v)}
          min={-1}
          max={1}
          step={0.01}
        />
      </div>

      {/* Offset Y */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Offset Y</Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {cuePosition.offsetY.toFixed(2)}
          </span>
        </div>
        <Slider
          value={[cuePosition.offsetY]}
          onValueChange={([v]) => update("offsetY", v)}
          min={-1}
          max={1}
          step={0.01}
        />
      </div>

      {/* Cue Scale */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Cue Scale</Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {cuePosition.cueScale.toFixed(1)}
          </span>
        </div>
        <Slider
          value={[cuePosition.cueScale]}
          onValueChange={([v]) => update("cueScale", v)}
          min={4}
          max={12}
          step={0.5}
        />
      </div>

      {/* Spin Speed */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground flex items-center gap-1">
            <RotateCcw className="h-3 w-3" /> Spin Speed
          </Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {cuePosition.spinSpeed.toFixed(2)}
          </span>
        </div>
        <Slider
          value={[cuePosition.spinSpeed]}
          onValueChange={([v]) => update("spinSpeed", v)}
          min={0}
          max={1}
          step={0.05}
        />
      </div>
    </div>
  );
}
