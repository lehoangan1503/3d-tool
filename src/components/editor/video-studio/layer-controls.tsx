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
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { GradientPicker } from "./gradient-picker";

import type {
  BackgroundLayer,
  BackgroundLayerType,
} from "@/types/video-studio";
import { GRADIENT_PRESETS } from "@/types/video-studio";

// ─── Constants ───────────────────────────────────────────────────────────────

const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
] as const;

const TYPE_ICON: Record<BackgroundLayerType, typeof Palette> = {
  color: Palette,
  gradient: Droplets,
  image: ImageIcon,
};

const TYPE_LABEL: Record<BackgroundLayerType, string> = {
  color: "Color",
  gradient: "Gradient",
  image: "Image",
};

// ─── Swatch helper ───────────────────────────────────────────────────────────

function Swatch({ layer }: { layer: BackgroundLayer }) {
  if (layer.type === "color") {
    return (
      <div
        className="h-4 w-4 shrink-0 rounded border border-border/40"
        style={{ backgroundColor: layer.color }}
      />
    );
  }

  if (layer.type === "gradient" && layer.gradient) {
    const preset = GRADIENT_PRESETS.find(
      (p) => p.id === layer.gradient!.presetId,
    );
    const colors = preset?.colors ?? ["#333", "#666"];
    const angle = layer.gradient.angle ?? preset?.angle ?? 180;
    return (
      <div
        className="h-4 w-4 shrink-0 rounded border border-border/40"
        style={{
          background: `linear-gradient(${angle}deg, ${colors.join(", ")})`,
        }}
      />
    );
  }

  // Image — thumbnail or placeholder
  if (layer.type === "image" && layer.imageUrl) {
    return (
      <img
        src={layer.imageUrl}
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

// ─── LayerControls ───────────────────────────────────────────────────────────

export interface LayerControlsProps {
  layer: BackgroundLayer;
  onChange: (layer: BackgroundLayer) => void;
  onDelete: () => void;
  isBase: boolean;
}

export function LayerControls({
  layer,
  onChange,
  onDelete,
  isBase,
}: LayerControlsProps) {
  const [expanded, setExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const Icon = TYPE_ICON[layer.type];

  const patch = useCallback(
    (partial: Partial<BackgroundLayer>) =>
      onChange({ ...layer, ...partial } as BackgroundLayer),
    [layer, onChange],
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
      {/* ── Collapsed row ── */}
      <div
        className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/30"
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">{TYPE_LABEL[layer.type]}</span>
        <Swatch layer={layer} />

        <div className="flex-1" />

        {/* Visibility toggle */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={(e) => {
            e.stopPropagation();
            patch({ enabled: !layer.enabled });
          }}
        >
          {layer.enabled ? (
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

        {/* Delete */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-destructive/70 hover:text-destructive"
          disabled={isBase}
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
          {/* Opacity */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Opacity — {Math.round(layer.opacity * 100)}%
            </Label>
            <Slider
              value={[layer.opacity]}
              onValueChange={([v]) => patch({ opacity: v })}
              min={0}
              max={1}
              step={0.01}
            />
          </div>

          {/* Blend mode */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Blend Mode</Label>
            <Select
              value={layer.blendMode}
              onValueChange={(v) => patch({ blendMode: v as typeof layer.blendMode })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BLEND_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {mode
                      .split("-")
                      .map((w) => w[0].toUpperCase() + w.slice(1))
                      .join(" ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── Type-specific controls ── */}
          {layer.type === "color" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Color</Label>
              <input
                type="color"
                value={layer.color ?? "#000000"}
                onChange={(e) => patch({ color: e.target.value })}
                className="h-8 w-full cursor-pointer rounded border-0"
              />
            </div>
          )}

          {layer.type === "gradient" && layer.gradient && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Gradient</Label>
              <GradientPicker
                selectedPresetId={layer.gradient.presetId}
                onSelect={(presetId) =>
                  patch({ gradient: { ...layer.gradient!, presetId } })
                }
                angle={layer.gradient.angle}
                onAngleChange={(angle) =>
                  patch({ gradient: { ...layer.gradient!, angle } })
                }
              />
            </div>
          )}

          {layer.type === "image" && (
            <div className="space-y-3">
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
                {layer.imageUrl && (
                  <img
                    src={layer.imageUrl}
                    alt="Layer preview"
                    className="mt-1.5 h-16 w-full rounded object-cover"
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Object Fit
                </Label>
                <Select
                  value={layer.objectFit ?? "cover"}
                  onValueChange={(v) =>
                    patch({ objectFit: v as BackgroundLayer["objectFit"] })
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cover">Cover</SelectItem>
                    <SelectItem value="contain">Contain</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
