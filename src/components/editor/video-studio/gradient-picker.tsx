"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  GRADIENT_PRESETS,
  type GradientCategory,
} from "@/types/video-studio";

interface GradientPickerProps {
  selectedPresetId: string | null;
  onSelect: (presetId: string) => void;
  angle: number;
  onAngleChange: (angle: number) => void;
}

const CATEGORIES: { value: GradientCategory; label: string }[] = [
  { value: "cold", label: "Lạnh" },
  { value: "warm", label: "Ấm" },
  { value: "neutral", label: "Trung tính" },
];

export function GradientPicker({
  selectedPresetId,
  onSelect,
  angle,
  onAngleChange,
}: GradientPickerProps) {
  const [activeCategory, setActiveCategory] =
    useState<GradientCategory>("cold");

  const filtered = GRADIENT_PRESETS.filter(
    (p) => p.category === activeCategory,
  );

  return (
    <div className="space-y-3">
      {/* Category tabs */}
      <div className="flex gap-1 p-1 rounded-lg bg-muted">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.value}
            onClick={() => setActiveCategory(cat.value)}
            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${
              activeCategory === cat.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Gradient swatches grid */}
      <div className="grid grid-cols-5 gap-1.5">
        {filtered.map((preset) => (
          <button
            key={preset.id}
            onClick={() => onSelect(preset.id)}
            title={preset.name}
            className={`h-12 rounded-md transition-shadow ${
              selectedPresetId === preset.id
                ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
                : "hover:ring-1 hover:ring-muted-foreground/40"
            }`}
            style={{
              background: `linear-gradient(${angle}deg, ${preset.colors.join(", ")})`,
            }}
          />
        ))}
      </div>

      {/* Angle slider */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Hướng</Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {angle}°
          </span>
        </div>
        <Slider
          value={[angle]}
          onValueChange={([v]) => onAngleChange(v)}
          min={0}
          max={360}
          step={1}
        />
      </div>
    </div>
  );
}
