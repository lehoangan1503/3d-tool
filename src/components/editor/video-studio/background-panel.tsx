"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronUp,
  RectangleHorizontal,
  Table2,
  Plus,
} from "lucide-react";
import type { SurfaceConfig, BackgroundFrame } from "@/types/video-studio";
import { createBackgroundFrame } from "@/types/video-studio";
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
}

export function BackgroundPanel({
  wallSurface,
  tableSurface,
  onWallSurfaceChange,
  onTableSurfaceChange,
}: BackgroundPanelProps) {
  const [manifest, setManifest] = useState<TextureManifest | null>(null);

  useEffect(() => {
    fetch("/textures/studio/textures.json")
      .then((r) => r.json())
      .then((data) => setManifest(data as TextureManifest))
      .catch(() => {});
  }, []);

  return (
    <div>
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
    </div>
  );
}
