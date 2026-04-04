"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  RotateCcw, Plus, Trash2, ChevronDown, ChevronUp,
} from "lucide-react";
import type { CueConfig, CueInstance } from "@/types/video-studio";
import { createCueInstance, MAX_CUE_INSTANCES } from "@/types/video-studio";

interface CueSetupPanelProps {
  cueConfig: CueConfig;
  onChange: (config: CueConfig) => void;
}

export function CueSetupPanel({ cueConfig, onChange }: CueSetupPanelProps) {
  const [expandedPanels, setExpandedPanels] = useState<Set<string>>(
    new Set(["main"]),
  );

  const togglePanel = useCallback((id: string) => {
    setExpandedPanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const updateInstance = useCallback(
    (index: number, partial: Partial<CueInstance>) => {
      const instances = cueConfig.instances.map((inst, i) =>
        i === index ? { ...inst, ...partial } : inst,
      );
      onChange({ ...cueConfig, instances });
    },
    [cueConfig, onChange],
  );

  const deleteInstance = useCallback(
    (index: number) => {
      if (cueConfig.instances[index].isMain) return;
      onChange({
        ...cueConfig,
        instances: cueConfig.instances.filter((_, i) => i !== index),
      });
    },
    [cueConfig, onChange],
  );

  const addInstance = useCallback(() => {
    if (cueConfig.instances.length >= MAX_CUE_INSTANCES) return;
    onChange({
      ...cueConfig,
      instances: [...cueConfig.instances, createCueInstance()],
    });
  }, [cueConfig, onChange]);

  const spinYDeg = Math.round(cueConfig.spinY * (180 / Math.PI));

  return (
    <div className="space-y-3">
      {/* ── Shared controls ── */}
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
          onValueChange={([v]) =>
            onChange({ ...cueConfig, spinY: v * (Math.PI / 180) })
          }
          min={0}
          max={360}
          step={1}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground flex items-center gap-1">
            <RotateCcw className="h-3 w-3" /> Spin Speed
          </Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {cueConfig.spinSpeed.toFixed(2)}
          </span>
        </div>
        <Slider
          value={[cueConfig.spinSpeed]}
          onValueChange={([v]) => onChange({ ...cueConfig, spinSpeed: v })}
          min={0}
          max={1}
          step={0.05}
        />
      </div>

      {/* ── Per-instance panels ── */}
      {cueConfig.instances.map((instance, i) => {
        const expanded = expandedPanels.has(instance.id);
        return (
          <div
            key={instance.id}
            className="rounded-lg border border-border/50 overflow-hidden"
          >
            {/* Header */}
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50"
              onClick={() => togglePanel(instance.id)}
            >
              <span>
                {instance.isMain ? "Main Cue" : `Cue ${i + 1}`}
              </span>
              <span className="flex items-center gap-1">
                {!instance.isMain && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="rounded p-0.5 hover:bg-destructive/20"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteInstance(i);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        deleteInstance(i);
                      }
                    }}
                  >
                    <Trash2 className="size-3 text-destructive" />
                  </span>
                )}
                {expanded ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
              </span>
            </button>

            {/* Expanded content */}
            {expanded && (
              <div className="px-3 pb-3 space-y-2">
                {/* Position X */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">
                      Position X
                    </Label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {instance.positionX.toFixed(1)}
                    </span>
                  </div>
                  <Slider
                    value={[instance.positionX]}
                    onValueChange={([v]) =>
                      updateInstance(i, { positionX: v })
                    }
                    min={-14}
                    max={14}
                    step={0.1}
                  />
                </div>

                {/* Position Y */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">
                      Position Y
                    </Label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {instance.positionY.toFixed(1)}
                    </span>
                  </div>
                  <Slider
                    value={[instance.positionY]}
                    onValueChange={([v]) =>
                      updateInstance(i, { positionY: v })
                    }
                    min={-1}
                    max={10}
                    step={0.1}
                  />
                </div>

                {/* Position Z */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">
                      Position Z
                    </Label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {instance.positionZ.toFixed(1)}
                    </span>
                  </div>
                  <Slider
                    value={[instance.positionZ]}
                    onValueChange={([v]) =>
                      updateInstance(i, { positionZ: v })
                    }
                    min={-5}
                    max={3}
                    step={0.1}
                  />
                </div>

                {/* Scale */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">
                      Scale
                    </Label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {instance.scale.toFixed(1)}
                    </span>
                  </div>
                  <Slider
                    value={[instance.scale]}
                    onValueChange={([v]) => updateInstance(i, { scale: v })}
                    min={4}
                    max={12}
                    step={0.5}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* ── Add button ── */}
      <Button
        variant="outline"
        size="sm"
        className="w-full h-7 text-xs"
        disabled={cueConfig.instances.length >= MAX_CUE_INSTANCES}
        onClick={addInstance}
      >
        <Plus className="size-3 mr-1" /> Add Cue Copy
      </Button>
    </div>
  );
}
