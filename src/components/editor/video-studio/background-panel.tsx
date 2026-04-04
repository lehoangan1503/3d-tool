"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Layers,
  RectangleHorizontal,
  Table2,
} from "lucide-react";
import type {
  BackgroundLayer,
  BackgroundLayerType,
} from "@/types/video-studio";
import { createBackgroundLayer } from "@/types/video-studio";
import { LayerControls } from "./layer-controls";

// ---------------------------------------------------------------------------
// LayerSection – collapsible section for a single background stack
// ---------------------------------------------------------------------------

function LayerSection({
  title,
  icon: Icon,
  layers,
  onChange,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  layers: BackgroundLayer[];
  onChange: (layers: BackgroundLayer[]) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const handleLayerChange = (layer: BackgroundLayer, index: number) => {
    const next = [...layers];
    next[index] = layer;
    onChange(next);
  };

  const handleLayerDelete = (index: number) => {
    if (index === 0) return; // base layer cannot be removed
    onChange(layers.filter((_, i) => i !== index));
  };

  const handleAddLayer = (type: BackgroundLayerType) => {
    onChange([...layers, createBackgroundLayer(type)]);
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
          {layers.length}
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
          {layers.map((layer, index) => (
            <LayerControls
              key={layer.id}
              layer={layer}
              isBase={index === 0}
              onChange={(updated: BackgroundLayer) => handleLayerChange(updated, index)}
              onDelete={() => handleLayerDelete(index)}
            />
          ))}

          {/* Add layer buttons */}
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-7 text-xs"
              onClick={() => handleAddLayer("color")}
            >
              <Plus className="size-3 mr-1" />
              Color
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-7 text-xs"
              onClick={() => handleAddLayer("gradient")}
            >
              <Plus className="size-3 mr-1" />
              Gradient
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-7 text-xs"
              onClick={() => handleAddLayer("image")}
            >
              <Plus className="size-3 mr-1" />
              Image
            </Button>
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
  wallLayers: BackgroundLayer[];
  tableLayers: BackgroundLayer[];
  onWallLayersChange: (layers: BackgroundLayer[]) => void;
  onTableLayersChange: (layers: BackgroundLayer[]) => void;
}

export function BackgroundPanel({
  wallLayers,
  tableLayers,
  onWallLayersChange,
  onTableLayersChange,
}: BackgroundPanelProps) {
  return (
    <div className="space-y-3">
      <LayerSection
        title="Wall Background"
        icon={RectangleHorizontal}
        layers={wallLayers}
        onChange={onWallLayersChange}
      />
      <LayerSection
        title="Table Surface"
        icon={Table2}
        layers={tableLayers}
        onChange={onTableLayersChange}
      />
    </div>
  );
}
