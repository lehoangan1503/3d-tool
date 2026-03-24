"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Plus, 
  Trash2, 
  AlignCenter, 
  Sun,
  Move,
  Maximize2,
  RotateCw,
  ZoomIn,
  Crosshair,
} from "lucide-react";
import type { ExtractorFrame, ExtractorReference, TemplateKey } from "@/types/extractor";
import { FRAME_TEMPLATES } from "@/types/extractor";

interface FrameControlsPanelProps {
  // Reference management
  references: ExtractorReference[];
  selectedReferenceId: string | null;
  onSelectReference: (id: string | null) => void;
  
  // Frame management
  frames: ExtractorFrame[];
  selectedFrame: ExtractorFrame | null;
  onFrameChange: (frame: ExtractorFrame) => void;
  onDeleteFrame: (id: string) => void;
  onAddFrame: () => void;
  onApplyTemplate: (key: TemplateKey) => void;
  
  // Layout controls
  onAlignFrames: () => void;
  gap: number;
  onGapChange: (gap: number) => void;
}

export function FrameControlsPanel({
  references,
  selectedReferenceId,
  onSelectReference,
  frames,
  selectedFrame,
  onFrameChange,
  onDeleteFrame,
  onAddFrame,
  onApplyTemplate,
  onAlignFrames,
  gap,
  onGapChange,
}: FrameControlsPanelProps) {
  
  const updateTransform = (key: keyof ExtractorFrame['transform'], value: number) => {
    if (!selectedFrame) return;
    onFrameChange({
      ...selectedFrame,
      transform: { ...selectedFrame.transform, [key]: value },
    });
  };

  const updateCue = (key: keyof ExtractorFrame['cue'], value: number) => {
    if (!selectedFrame) return;
    onFrameChange({
      ...selectedFrame,
      cue: { ...selectedFrame.cue, [key]: value },
    });
  };

  // No frame selected - show reference/template controls
  if (!selectedFrame) {
    return (
      <div className="w-72 flex flex-col gap-4 p-4 border-l bg-muted/30 overflow-y-auto">
        {/* Reference Selector */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Load Reference</Label>
          <Select
            value={selectedReferenceId || "none"}
            onValueChange={(v) => onSelectReference(v === "none" ? null : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a saved layout..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">New Layout</SelectItem>
              {references.map((ref) => (
                <SelectItem key={ref.id} value={ref.id}>
                  {ref.name} ({ref.frames.length} frames)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Templates */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Templates</Label>
          <div className="grid grid-cols-3 gap-2">
            {(Object.entries(FRAME_TEMPLATES) as [TemplateKey, { name: string }][]).map(([key, { name }]) => (
              <Button
                key={key}
                variant="outline"
                size="sm"
                onClick={() => onApplyTemplate(key)}
                className="text-xs"
              >
                {name}
              </Button>
            ))}
          </div>
        </div>

        {/* Add Frame */}
        <Button onClick={onAddFrame} className="w-full">
          <Plus className="w-4 h-4 mr-2" />
          Add Frame
        </Button>

        {/* Layout Controls */}
        <div className="space-y-3 pt-4 border-t">
          <Label className="text-sm font-medium">Layout</Label>
          
          <Button variant="outline" size="sm" onClick={onAlignFrames} className="w-full">
            <AlignCenter className="w-4 h-4 mr-2" />
            Auto Align
          </Button>
          
          <div>
            <Label className="text-xs text-muted-foreground">Gap (px)</Label>
            <Input
              type="number"
              value={gap}
              onChange={(e) => onGapChange(parseInt(e.target.value) || 0)}
              className="h-8 mt-1"
              min={0}
              max={200}
            />
          </div>
        </div>

        {/* Frame Count Info */}
        <div className="text-xs text-muted-foreground mt-auto">
          {frames.length} frame{frames.length !== 1 ? 's' : ''} in canvas
        </div>
      </div>
    );
  }

  // Frame selected - show frame controls
  return (
    <div className="w-72 flex flex-col gap-4 p-4 border-l bg-muted/30 overflow-y-auto">
      {/* Frame Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">Frame {selectedFrame.order + 1}</h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDeleteFrame(selectedFrame.id)}
          className="h-8 w-8 text-destructive hover:text-destructive"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      {/* Frame Transform */}
      <div className="space-y-3">
        <Label className="text-sm font-medium flex items-center gap-2">
          <Move className="w-4 h-4" /> Position
        </Label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-muted-foreground">X</Label>
            <Input
              type="number"
              value={Math.round(selectedFrame.transform.x)}
              onChange={(e) => updateTransform('x', parseFloat(e.target.value) || 0)}
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Y</Label>
            <Input
              type="number"
              value={Math.round(selectedFrame.transform.y)}
              onChange={(e) => updateTransform('y', parseFloat(e.target.value) || 0)}
              className="h-8"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-sm font-medium flex items-center gap-2">
          <Maximize2 className="w-4 h-4" /> Size
        </Label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-muted-foreground">Width</Label>
            <Input
              type="number"
              value={Math.round(selectedFrame.transform.width)}
              onChange={(e) => updateTransform('width', Math.max(100, parseFloat(e.target.value) || 100))}
              className="h-8"
              min={100}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Height</Label>
            <Input
              type="number"
              value={Math.round(selectedFrame.transform.height)}
              onChange={(e) => updateTransform('height', Math.max(100, parseFloat(e.target.value) || 100))}
              className="h-8"
              min={100}
            />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium flex items-center gap-2">
          <RotateCw className="w-4 h-4" /> Rotation
        </Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={Math.round(selectedFrame.transform.rotation)}
            onChange={(e) => updateTransform('rotation', parseFloat(e.target.value) || 0)}
            className="h-8"
          />
          <span className="text-sm text-muted-foreground">°</span>
        </div>
      </div>

      {/* Cue Controls */}
      <div className="space-y-3 pt-4 border-t">
        <Label className="text-sm font-medium">Cue Controls</Label>
        
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-muted-foreground">Orbit X (°)</Label>
            <Input
              type="number"
              value={Math.round(selectedFrame.cue.orbitX * (180 / Math.PI))}
              onChange={(e) => updateCue('orbitX', (parseFloat(e.target.value) || 0) * (Math.PI / 180))}
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Orbit Y (°)</Label>
            <Input
              type="number"
              value={Math.round(selectedFrame.cue.orbitY * (180 / Math.PI))}
              onChange={(e) => updateCue('orbitY', (parseFloat(e.target.value) || 0) * (Math.PI / 180))}
              className="h-8"
            />
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground flex items-center gap-1">
            <ZoomIn className="w-3 h-3" /> Zoom
          </Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              value={selectedFrame.cue.zoom.toFixed(1)}
              onChange={(e) => updateCue('zoom', Math.max(0.5, Math.min(5, parseFloat(e.target.value) || 1)))}
              className="h-8"
              step={0.1}
              min={0.5}
              max={5}
            />
            <span className="text-sm text-muted-foreground">x</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-muted-foreground flex items-center gap-1">
              <Crosshair className="w-3 h-3" /> Offset X
            </Label>
            <Input
              type="number"
              value={selectedFrame.cue.offsetX.toFixed(2)}
              onChange={(e) => updateCue('offsetX', parseFloat(e.target.value) || 0)}
              className="h-8"
              step={0.1}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Offset Y</Label>
            <Input
              type="number"
              value={selectedFrame.cue.offsetY.toFixed(2)}
              onChange={(e) => updateCue('offsetY', parseFloat(e.target.value) || 0)}
              className="h-8"
              step={0.1}
            />
          </div>
        </div>
      </div>

      {/* Light */}
      <div className="space-y-2 pt-4 border-t">
        <Label className="text-sm font-medium flex items-center gap-2">
          <Sun className="w-4 h-4" /> Light Direction
        </Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={Math.round(selectedFrame.cue.lightAngle)}
            onChange={(e) => updateCue('lightAngle', parseFloat(e.target.value) || 0)}
            className="h-8"
            min={0}
            max={360}
          />
          <span className="text-sm text-muted-foreground">°</span>
        </div>
      </div>

      {/* Click outside hint */}
      <div className="text-xs text-muted-foreground mt-auto">
        Click outside frames for layout controls
      </div>
    </div>
  );
}
