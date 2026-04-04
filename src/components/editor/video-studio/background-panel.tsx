"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  RectangleHorizontal,
  Table2,
} from "lucide-react";
import type { SurfaceConfig, BackgroundFrame } from "@/types/video-studio";
import {
  createBackgroundFrame,
  MAX_BACKGROUND_FRAMES,
} from "@/types/video-studio";
import { FrameControls } from "./frame-controls";

// ---------------------------------------------------------------------------
// SurfaceSection – collapsible section for a single surface
// ---------------------------------------------------------------------------

function SurfaceSection({
  title,
  icon: Icon,
  surface,
  onChange,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  surface: SurfaceConfig;
  onChange: (surface: SurfaceConfig) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const handleFrameChange = (frame: BackgroundFrame, index: number) => {
    const next = [...surface.frames];
    next[index] = frame;
    onChange({ ...surface, frames: next });
  };

  const handleFrameDelete = (index: number) => {
    onChange({
      ...surface,
      frames: surface.frames.filter((_, i) => i !== index),
    });
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const next = [...surface.frames];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onChange({ ...surface, frames: next });
  };

  const handleMoveDown = (index: number) => {
    if (index >= surface.frames.length - 1) return;
    const next = [...surface.frames];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onChange({ ...surface, frames: next });
  };

  const handleAddFrame = () => {
    if (surface.frames.length >= MAX_BACKGROUND_FRAMES) return;
    onChange({
      ...surface,
      frames: [...surface.frames, createBackgroundFrame("color")],
    });
  };

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      {/* Header */}
      <button
        type="button"
        className="flex items-center gap-2 px-3 py-2 w-full cursor-pointer hover:bg-muted/20 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium flex-1 text-left">{title}</span>
        <span className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
          {surface.frames.length}
        </span>
        {expanded ? (
          <ChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-2 pb-2 space-y-2">
          {/* Base color */}
          <div className="flex items-center gap-2 px-1">
            <Label className="text-xs text-muted-foreground">Base Color</Label>
            <input
              type="color"
              value={surface.baseColor}
              onChange={(e) =>
                onChange({ ...surface, baseColor: e.target.value })
              }
              className="h-6 w-10 cursor-pointer rounded border-0"
            />
          </div>

          {/* Frames */}
          {surface.frames.map((frame, index) => (
            <FrameControls
              key={frame.id}
              frame={frame}
              onChange={(updated) => handleFrameChange(updated, index)}
              onDelete={() => handleFrameDelete(index)}
              onMoveUp={() => handleMoveUp(index)}
              onMoveDown={() => handleMoveDown(index)}
              isFirst={index === 0}
              isLast={index === surface.frames.length - 1}
            />
          ))}

          {/* Add frame button */}
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-xs"
            disabled={surface.frames.length >= MAX_BACKGROUND_FRAMES}
            onClick={handleAddFrame}
          >
            <Plus className="size-3 mr-1" />
            Add Frame
          </Button>
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
  return (
    <div className="space-y-3">
      <SurfaceSection
        title="Wall Background"
        icon={RectangleHorizontal}
        surface={wallSurface}
        onChange={onWallSurfaceChange}
      />
      <SurfaceSection
        title="Table Surface"
        icon={Table2}
        surface={tableSurface}
        onChange={onTableSurfaceChange}
      />
    </div>
  );
}
