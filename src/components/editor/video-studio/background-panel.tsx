"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ChevronDown,
  ChevronUp,
  RectangleHorizontal,
  Table2,
  Plus,
  Frame,
  Spline,
} from "lucide-react";
import type {
  SurfaceConfig,
  BackgroundFrame,
  SceneBackgroundConfig,
  CornerFillConfig,
} from "@/types/video-studio";
import { createBackgroundFrame, DEFAULT_SCENE_BACKGROUND } from "@/types/video-studio";
import type { TexturePackInfo, TextureManifest } from "@/lib/three/studio-background";
import { SurfaceFrameControls } from "./surface-frame-controls";

// ---------------------------------------------------------------------------
// Texture Preset Picker
// ---------------------------------------------------------------------------

function TexturePresetPicker({
  packs,
  selected,
  onSelect,
}: {
  packs: TexturePackInfo[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  if (packs.length === 0) return null;

  return (
    <div className="flex gap-1.5 flex-wrap px-1">
      {packs.map((pack) => {
        const ext = pack.fileExt ?? "jpg";
        const isSolid = pack.maps.length === 0 && pack.solidColor;
        return (
          <button
            key={pack.id}
            type="button"
            className={`relative w-12 h-12 rounded-md overflow-hidden border-2 transition-colors cursor-pointer ${
              selected === pack.id
                ? "border-primary ring-1 ring-primary/50"
                : "border-border/50 hover:border-border"
            }`}
            onClick={() => onSelect(pack.id)}
            title={pack.name}
          >
            {isSolid ? (
              <div
                className="w-full h-full"
                style={{ backgroundColor: pack.solidColor }}
              />
            ) : (
              <img
                src={`/textures/studio/${pack.folder}/diff.${ext}`}
                alt={pack.name}
                className="w-full h-full object-cover"
              />
            )}
            <span className="absolute bottom-0 inset-x-0 text-[8px] leading-tight text-center bg-black/60 text-white py-0.5 truncate">
              {pack.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Quick tints for a surface — neutrals plus a few set colours people actually use. */
const SURFACE_TINT_SWATCHES = ["#ffffff", "#1a1a1a", "#000000", "#3a3a3a", "#8a8a8a"];

/**
 * Colour + hex + swatches row, matching the "Không gian xung quanh" control so the two
 * read as the same kind of setting.
 */
function TintRow({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-border/50 bg-transparent p-0.5"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="h-7 w-20 rounded border border-border/50 bg-muted/30 px-1.5 font-mono text-[10px] uppercase outline-none focus:border-blue-500/50"
      />
      <div className="flex flex-1 gap-1">
        {SURFACE_TINT_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => onChange(c)}
            style={{ backgroundColor: c }}
            className={`h-6 flex-1 cursor-pointer rounded border transition-colors ${
              value.toLowerCase() === c ? "border-primary ring-1 ring-primary/50" : "border-border/50"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SurfaceSection – collapsible section for a single surface
// ---------------------------------------------------------------------------

function SurfaceSection({
  title,
  icon: Icon,
  surface,
  onChange,
  texturePacks,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  surface: SurfaceConfig;
  onChange: (surface: SurfaceConfig) => void;
  texturePacks: TexturePackInfo[];
}) {
  const [expanded, setExpanded] = useState(true);

  // Find current texture pack to get default roughness
  const currentPack = texturePacks.find((p) => p.id === surface.texturePreset);
  const roughness = surface.roughness ?? currentPack?.roughnessValue ?? 0.5;

  const frames = surface.frames ?? [];

  const updateFrame = (id: string, updated: BackgroundFrame) => {
    onChange({ ...surface, frames: frames.map((f) => (f.id === id ? updated : f)) });
  };

  const deleteFrame = (id: string) => {
    onChange({ ...surface, frames: frames.filter((f) => f.id !== id) });
  };

  const moveFrame = (index: number, direction: -1 | 1) => {
    const next = [...frames];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...surface, frames: next });
  };

  return (
    <div className="overflow-hidden">
      {/* Header */}
      <button
        type="button"
        className="flex items-center gap-2 px-3 py-2 w-full cursor-pointer hover:bg-muted/20 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium flex-1 text-left">{title}</span>
        {expanded ? (
          <ChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-2 pb-2 space-y-2">

          {/* Base surface tint — multiplies the texture pack, so the grain survives.
              Recolouring here rather than with a full-bleed frame keeps the surface a
              surface, which is what lets the logo backdrop still draw on top of it. */}
          <div className="px-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground">Màu bề mặt</Label>
            <TintRow
              value={surface.baseTint ?? "#ffffff"}
              onChange={(hex) => onChange({ ...surface, baseTint: hex })}
            />
          </div>

          {/* Background Frames (images, colours, gradients) */}
          <div className="px-1 space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Hình ảnh / màu nền</Label>
              {frames.length < 4 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs gap-1"
                  onClick={() =>
                    onChange({ ...surface, frames: [...frames, createBackgroundFrame()] })
                  }
                >
                  <Plus className="h-3 w-3" />
                  Thêm
                </Button>
              )}
            </div>
            {frames.map((frame, i) => (
              <SurfaceFrameControls
                key={frame.id}
                frame={frame}
                onChange={(updated) => updateFrame(frame.id, updated)}
                onDelete={() => deleteFrame(frame.id)}
                onMoveUp={() => moveFrame(i, -1)}
                onMoveDown={() => moveFrame(i, 1)}
                isFirst={i === 0}
                isLast={i === frames.length - 1}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackgroundPanel
// ---------------------------------------------------------------------------

interface BackgroundPanelProps {
  wallSurface: SurfaceConfig;
  tableSurface: SurfaceConfig;
  onWallSurfaceChange: (s: SurfaceConfig) => void;
  onTableSurfaceChange: (s: SurfaceConfig) => void;
  sceneBackground: SceneBackgroundConfig;
  onSceneBackgroundChange: (s: SceneBackgroundConfig) => void;
  cornerFill: CornerFillConfig;
  onCornerFillChange: (patch: Partial<CornerFillConfig>) => void;
}

/** Quick picks for the void colour — the two everybody actually reaches for. */
const SCENE_BACKGROUND_SWATCHES = ["#000000", "#0a0a0a", "#1a1a1a", "#2a2a2a", "#ffffff"];

export function BackgroundPanel({
  wallSurface,
  tableSurface,
  onWallSurfaceChange,
  onTableSurfaceChange,
  sceneBackground,
  onSceneBackgroundChange,
  cornerFill,
  onCornerFillChange,
}: BackgroundPanelProps) {
  const [manifest, setManifest] = useState<TextureManifest | null>(null);

  useEffect(() => {
    fetch("/textures/studio/textures.json")
      .then((r) => r.json())
      .then((data) => setManifest(data as TextureManifest))
      .catch(() => {});
  }, []);

  const voidColor = sceneBackground?.color ?? DEFAULT_SCENE_BACKGROUND.color;

  return (
    <div>
      {/* ── Space around the set ─────────────────────────────────────────────
          The wall and table are only 34x22 and 28x5 planes. Everything the camera
          sees past their edges is this colour, which is why setting the wall to
          black used to leave a lighter grey border around it. */}
      <div className="px-2 py-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <Frame className="size-4 text-muted-foreground" />
          <Label className="text-sm font-medium flex-1">Không gian xung quanh</Label>
        </div>
        <p className="text-[10px] text-muted-foreground leading-snug">
          Màu của vùng trống bao quanh tường và bàn (phần camera nhìn thấy ngoài rìa set).
        </p>
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={voidColor}
            onChange={(e) => onSceneBackgroundChange({ color: e.target.value })}
            className="h-7 w-9 shrink-0 cursor-pointer rounded border border-border/50 bg-transparent p-0.5"
          />
          <input
            type="text"
            value={voidColor}
            onChange={(e) => onSceneBackgroundChange({ color: e.target.value })}
            spellCheck={false}
            className="h-7 w-20 rounded border border-border/50 bg-muted/30 px-1.5 font-mono text-[10px] uppercase outline-none focus:border-blue-500/50"
          />
          <div className="flex flex-1 gap-1">
            {SCENE_BACKGROUND_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => onSceneBackgroundChange({ color: c })}
                style={{ backgroundColor: c }}
                className={`h-6 flex-1 cursor-pointer rounded border transition-colors ${
                  voidColor.toLowerCase() === c ? "border-primary ring-1 ring-primary/50" : "border-border/50"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="border-t border-border/40 my-1" />
      <SurfaceSection
        title="Nền tường"
        icon={RectangleHorizontal}
        surface={wallSurface}
        onChange={onWallSurfaceChange}
        texturePacks={manifest?.wall ?? []}
      />
      <div className="border-t border-border/40 my-1" />
      <SurfaceSection
        title="Bề mặt bàn"
        icon={Table2}
        surface={tableSurface}
        onChange={onTableSurfaceChange}
        texturePacks={manifest?.table ?? []}
      />

      {/* ── Curved wall/table corner ────────────────────────────────────────
          The fillet is part of the set, not part of the shadow: it is visible
          whether or not shadows are on, and it always repaints itself from
          whatever the wall shows. So it belongs here with the surfaces. */}
      <div className="border-t border-border/40 my-1" />
      <div className="px-2 py-2 space-y-2">
        <div className="flex items-center gap-2">
          <Spline className="size-4 text-muted-foreground" />
          <Label htmlFor="corner-fill-enabled" className="text-sm font-medium flex-1 cursor-pointer">
            Bo góc tường / bàn
          </Label>
          <Checkbox
            id="corner-fill-enabled"
            checked={cornerFill.enabled}
            onCheckedChange={(checked) => onCornerFillChange({ enabled: checked === true })}
            className="h-3.5 w-3.5"
          />
        </div>
        <p className="text-[10px] text-muted-foreground leading-snug">
          {cornerFill.enabled
            ? "Tường cong mượt xuống bàn. Màu và hình nền của góc bo tự đồng bộ theo tường."
            : "Góc vuông sắc — tường và bàn gặp nhau đúng tại đường giao."}
        </p>

        {cornerFill.enabled && (
          <div className="space-y-1.5 pt-0.5">
            <Label className="text-xs text-muted-foreground">
              Bán kính bo — {cornerFill.radius.toFixed(2)}
            </Label>
            <Slider
              value={[cornerFill.radius]}
              onValueChange={([v]) => onCornerFillChange({ radius: v })}
              min={0.1}
              max={3}
              step={0.05}
            />
          </div>
        )}
      </div>
    </div>
  );
}
