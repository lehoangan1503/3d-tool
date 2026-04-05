"use client";

import { useCallback, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  Trash2,
  ChevronDown,
  ChevronUp,
  Palette,
  Image as ImageIcon,
  Droplets,
  ArrowUp,
  ArrowDown,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { GradientPicker } from "./gradient-picker";

import type {
  BackgroundFrame,
  BackgroundFrameType,
} from "@/types/video-studio";
import { GRADIENT_PRESETS } from "@/types/video-studio";

// ─── Constants ───────────────────────────────────────────────────────────────

const TYPE_ICON: Record<BackgroundFrameType, typeof Palette> = {
  color: Palette,
  gradient: Droplets,
  image: ImageIcon,
};

const TYPE_LABEL: Record<BackgroundFrameType, string> = {
  color: "Color",
  gradient: "Gradient",
  image: "Image",
};

const FRAME_TYPES: BackgroundFrameType[] = ["color", "gradient", "image"];

// ─── Swatch helper ───────────────────────────────────────────────────────────

function Swatch({ frame }: { frame: BackgroundFrame }) {
  if (frame.type === "color") {
    return (
      <div
        className="h-4 w-4 shrink-0 rounded border border-border/40"
        style={{ backgroundColor: frame.color }}
      />
    );
  }

  if (frame.type === "gradient" && frame.gradient) {
    const preset = GRADIENT_PRESETS.find(
      (p) => p.id === frame.gradient!.presetId,
    );
    const colors = preset?.colors ?? ["#333", "#666"];
    const angle = frame.gradient.angle ?? preset?.angle ?? 180;
    return (
      <div
        className="h-4 w-4 shrink-0 rounded border border-border/40"
        style={{
          background: `linear-gradient(${angle}deg, ${colors.join(", ")})`,
        }}
      />
    );
  }

  if (frame.type === "image" && frame.imageUrl) {
    return (
      <img
        src={frame.imageUrl}
        alt=""
        className="h-4 w-4 shrink-0 rounded border border-border/40 object-cover"
      />
    );
  }

  return (
    <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border/40 bg-muted/40">
      <ImageIcon className="h-2.5 w-2.5 text-muted-foreground" />
    </div>
  );
}

// ─── FrameControls ───────────────────────────────────────────────────────────

export interface FrameControlsProps {
  frame: BackgroundFrame;
  onChange: (frame: BackgroundFrame) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}

export function FrameControls({
  frame,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: FrameControlsProps) {
  const [expanded, setExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const Icon = TYPE_ICON[frame.type];

  const patch = useCallback(
    (partial: Partial<BackgroundFrame>) =>
      onChange({ ...frame, ...partial } as BackgroundFrame),
    [frame, onChange],
  );

  // ── Image upload via FileReader ──
  const handleImageUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => patch({ imageUrl: reader.result as string });
      reader.readAsDataURL(file);
    },
    [patch],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-card/30">
      {/* ── Header row ── */}
      <div
        className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/30"
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">{TYPE_LABEL[frame.type]}</span>
        <Swatch frame={frame} />

        <div className="flex-1" />

        {/* Visibility toggle */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={(e) => {
            e.stopPropagation();
            patch({ enabled: !frame.enabled });
          }}
        >
          {frame.enabled ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </Button>

        {/* Expand / collapse */}
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}

        {/* Move up */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={isFirst}
          onClick={(e) => {
            e.stopPropagation();
            onMoveUp();
          }}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>

        {/* Move down */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={isLast}
          onClick={(e) => {
            e.stopPropagation();
            onMoveDown();
          }}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>

        {/* Delete */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-destructive/70 hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── Expanded section ── */}
      {expanded && (
        <div className="space-y-3 border-t border-border/30 px-3 pb-3 pt-3">
          {/* Type toggle */}
          <div className="grid grid-cols-3 gap-1">
            {FRAME_TYPES.map((t) => {
              const TIcon = TYPE_ICON[t];
              return (
                <Button
                  key={t}
                  variant={frame.type === t ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() =>
                    patch({
                      type: t,
                      ...(t === "gradient" && !frame.gradient
                        ? {
                            gradient: {
                              presetId: GRADIENT_PRESETS[0].id,
                              angle: GRADIENT_PRESETS[0].angle,
                            },
                          }
                        : {}),
                    })
                  }
                >
                  <TIcon className="h-3 w-3" />
                  {TYPE_LABEL[t]}
                </Button>
              );
            })}
          </div>

          {/* ── Type-specific controls ── */}
          {frame.type === "color" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Color</Label>
              <input
                type="color"
                value={frame.color ?? "#000000"}
                onChange={(e) => patch({ color: e.target.value })}
                className="h-8 w-full cursor-pointer rounded border-0"
              />
            </div>
          )}

          {frame.type === "gradient" && frame.gradient && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Gradient</Label>
              <GradientPicker
                selectedPresetId={frame.gradient.presetId}
                onSelect={(presetId) =>
                  patch({ gradient: { ...frame.gradient!, presetId } })
                }
                angle={frame.gradient.angle}
                onAngleChange={(angle) =>
                  patch({ gradient: { ...frame.gradient!, angle } })
                }
              />
            </div>
          )}

          {frame.type === "image" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Image</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageUpload}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose Image
              </Button>
              {frame.imageUrl && (
                <img
                  src={frame.imageUrl}
                  alt="Frame preview"
                  className="mt-1.5 h-16 w-full rounded object-cover"
                />
              )}
            </div>
          )}

          {/* ── Transform controls ── */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">
              Transform
            </Label>

            {/* X position */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">X</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {frame.x.toFixed(2)}
                </span>
              </div>
              <Slider
                value={[frame.x]}
                min={0}
                max={1}
                step={0.01}
                onValueChange={([v]) => patch({ x: v })}
              />
            </div>

            {/* Y position */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Y</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {frame.y.toFixed(2)}
                </span>
              </div>
              <Slider
                value={[frame.y]}
                min={0}
                max={1}
                step={0.01}
                onValueChange={([v]) => patch({ y: v })}
              />
            </div>

            {/* Width */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Width</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {frame.width.toFixed(2)}
                </span>
              </div>
              <Slider
                value={[frame.width]}
                min={0.1}
                max={2}
                step={0.01}
                onValueChange={([v]) => patch({ width: v })}
              />
            </div>

            {/* Height */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Height</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {frame.height.toFixed(2)}
                </span>
              </div>
              <Slider
                value={[frame.height]}
                min={0.1}
                max={2}
                step={0.01}
                onValueChange={([v]) => patch({ height: v })}
              />
            </div>
          </div>

          {/* Rotation */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Rotation</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {frame.rotation}°
              </span>
            </div>
            <Slider
              value={[frame.rotation]}
              min={0}
              max={360}
              step={1}
              onValueChange={([v]) => patch({ rotation: v })}
            />
          </div>

          {/* Opacity */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Opacity</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {Math.round(frame.opacity * 100)}%
              </span>
            </div>
            <Slider
              value={[Math.round(frame.opacity * 100)]}
              min={0}
              max={100}
              step={1}
              onValueChange={([v]) => patch({ opacity: v / 100 })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
