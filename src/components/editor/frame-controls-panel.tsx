"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  ArrowLeft,
  Lightbulb,
  X,
  Check,
} from "lucide-react";
import type { ExtractorFrame, ExtractorReference, HdriLayer } from "@/types/extractor";
import { createDefaultHdriLayer } from "@/types/extractor";
import { cn } from "@/lib/utils";

interface HdriOption {
  id: string;
  label: string;
}

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
  onDeselectFrame: () => void;
  
  // Layout controls
  onAlignFrames: () => void;
  gap: number;
  onGapChange: (gap: number) => void;
  
  // HDRI controls
  hdriOptions: HdriOption[];
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
  onDeselectFrame,
  onAlignFrames,
  gap,
  onGapChange,
  hdriOptions,
}: FrameControlsPanelProps) {
  // Track which HDRI layer is being edited (by layer id)
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [addHdriOpen, setAddHdriOpen] = useState(false);
  
  // Local state for slider drag (for smooth UI, only commit on release)
  const [localRotationX, setLocalRotationX] = useState<number | null>(null);
  const [localRotationY, setLocalRotationY] = useState<number | null>(null);
  
  const updateTransform = (key: keyof ExtractorFrame['transform'], value: number) => {
    if (!selectedFrame) return;
    onFrameChange({
      ...selectedFrame,
      transform: { ...selectedFrame.transform, [key]: value },
    });
  };

  const updateCue = (key: keyof ExtractorFrame['cue'], value: number | string | HdriLayer[]) => {
    if (!selectedFrame) return;
    onFrameChange({
      ...selectedFrame,
      cue: { ...selectedFrame.cue, [key]: value },
    });
  };
  
  // Parse number from text input, handling empty/invalid values
  const parseNumber = (value: string, fallback: number = 0): number => {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? fallback : parsed;
  };

  // HDRI Layer management
  const hdriLayers = selectedFrame?.cue.hdriLayers || [];
  const canAddHdri = hdriLayers.length < 2;
  
  // Auto-select first layer for editing if none selected
  const effectiveEditingLayerId = editingLayerId && hdriLayers.find(l => l.id === editingLayerId) 
    ? editingLayerId 
    : hdriLayers[0]?.id || null;
  
  const editingLayer = hdriLayers.find(l => l.id === effectiveEditingLayerId);
  
  const addHdriLayer = (hdriType: string) => {
    if (!selectedFrame || hdriLayers.length >= 2) return;
    const newLayer = createDefaultHdriLayer(hdriType);
    updateCue('hdriLayers', [...hdriLayers, newLayer]);
    setEditingLayerId(newLayer.id);
    setAddHdriOpen(false);
  };
  
  const removeHdriLayer = (layerId: string) => {
    if (!selectedFrame || hdriLayers.length <= 1) return; // Keep at least 1
    const newLayers = hdriLayers.filter(l => l.id !== layerId);
    updateCue('hdriLayers', newLayers);
    if (editingLayerId === layerId) {
      setEditingLayerId(newLayers[0]?.id || null);
    }
  };
  
  const updateHdriLayer = (layerId: string, updates: Partial<HdriLayer>) => {
    if (!selectedFrame) return;
    const newLayers = hdriLayers.map(l => 
      l.id === layerId ? { ...l, ...updates } : l
    );
    updateCue('hdriLayers', newLayers);
  };
  
  const getHdriLabel = (hdriType: string) => {
    const option = hdriOptions.find(o => o.id === hdriType);
    // Return short name (first 2 words)
    if (option) {
      const words = option.label.split(' ').slice(0, 2);
      return words.join(' ');
    }
    return hdriType.split('_').slice(0, 2).join(' ');
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
              type="text"
              inputMode="numeric"
              value={gap}
              onChange={(e) => onGapChange(parseNumber(e.target.value, 0))}
              className="h-8 mt-1"
            />
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              Change value and click Auto Align
            </p>
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
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onDeselectFrame}
            className="h-8 w-8"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h3 className="font-medium text-sm">Frame {selectedFrame.order + 1}</h3>
        </div>
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
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">X</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={Math.round(selectedFrame.transform.x)}
              onChange={(e) => updateTransform('x', parseNumber(e.target.value, 0))}
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Y</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={Math.round(selectedFrame.transform.y)}
              onChange={(e) => updateTransform('y', parseNumber(e.target.value, 0))}
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
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Width</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={Math.round(selectedFrame.transform.width)}
              onChange={(e) => updateTransform('width', Math.max(100, parseNumber(e.target.value, 100)))}
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Height</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={Math.round(selectedFrame.transform.height)}
              onChange={(e) => updateTransform('height', Math.max(100, parseNumber(e.target.value, 100)))}
              className="h-8"
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
            type="text"
            inputMode="numeric"
            value={Math.round(selectedFrame.transform.rotation)}
            onChange={(e) => updateTransform('rotation', parseNumber(e.target.value, 0))}
            className="h-8"
          />
          <span className="text-sm text-muted-foreground">°</span>
        </div>
      </div>

      {/* Cue Controls */}
      <div className="space-y-3 pt-4 border-t">
        <Label className="text-sm font-medium">Cue Controls</Label>
        
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Spin Y (°)</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={Math.round(selectedFrame.cue.spinY * (180 / Math.PI))}
              onChange={(e) => updateCue('spinY', parseNumber(e.target.value, 0) * (Math.PI / 180))}
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Camera (°)</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={Math.round(selectedFrame.cue.phi * (180 / Math.PI))}
              onChange={(e) => updateCue('phi', parseNumber(e.target.value, 90) * (Math.PI / 180))}
              className="h-8"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1">
            <ZoomIn className="w-3 h-3" /> Zoom
          </Label>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              inputMode="decimal"
              value={selectedFrame.cue.zoom.toFixed(1)}
              onChange={(e) => updateCue('zoom', Math.max(0.5, Math.min(5, parseNumber(e.target.value, 1))))}
              className="h-8"
            />
            <span className="text-sm text-muted-foreground">x</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground flex items-center gap-1">
              <Crosshair className="w-3 h-3" /> Offset X
            </Label>
            <Input
              type="text"
              inputMode="decimal"
              value={selectedFrame.cue.offsetX.toFixed(2)}
              onChange={(e) => updateCue('offsetX', parseNumber(e.target.value, 0))}
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Offset Y</Label>
            <Input
              type="text"
              inputMode="decimal"
              value={selectedFrame.cue.offsetY.toFixed(2)}
              onChange={(e) => updateCue('offsetY', parseNumber(e.target.value, 0))}
              className="h-8"
            />
          </div>
        </div>
      </div>

      {/* HDRI / Light Controls */}
      <div className="space-y-3 pt-4 border-t">
        <Label className="text-sm font-medium flex items-center gap-2">
          <Lightbulb className="w-4 h-4" /> Lighting
        </Label>
        
        {/* Add HDRI Button */}
        <Popover open={addHdriOpen} onOpenChange={setAddHdriOpen}>
          <PopoverTrigger asChild>
            <Button 
              variant="outline" 
              size="sm" 
              className="w-full"
              disabled={!canAddHdri}
            >
              <Plus className="w-4 h-4 mr-2" />
              Add HDRI {hdriLayers.length > 0 && `(${hdriLayers.length}/2)`}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-2" align="start">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground px-2">Select HDRI to add</Label>
              {hdriOptions.map((option) => (
                <Button
                  key={option.id}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-sm h-8"
                  onClick={() => addHdriLayer(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        
        {/* Active HDRI Badges */}
        {hdriLayers.length > 0 && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Active HDRIs (click to edit)</Label>
            <div className="flex flex-wrap gap-2">
              {hdriLayers.map((layer) => (
                <div
                  key={layer.id}
                  className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-md text-xs cursor-pointer transition-colors",
                    effectiveEditingLayerId === layer.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted hover:bg-muted/80"
                  )}
                  onClick={() => setEditingLayerId(layer.id)}
                >
                  {effectiveEditingLayerId === layer.id && (
                    <Check className="w-3 h-3" />
                  )}
                  <span className="truncate max-w-[100px]">{getHdriLabel(layer.hdriType)}</span>
                  {hdriLayers.length > 1 && (
                    <button
                      className="ml-1 hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeHdriLayer(layer.id);
                      }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        
        {/* Rotation Sliders for Selected HDRI */}
        {editingLayer && (
          <div className="space-y-3 p-3 bg-muted/50 rounded-lg">
            <Label className="text-xs font-medium">
              {getHdriLabel(editingLayer.hdriType)} Rotation
            </Label>
            
            {/* X Rotation Slider */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Sun className="w-3 h-3" /> X (Vertical)
                </Label>
                <span className="text-xs text-muted-foreground w-10 text-right">
                  {Math.round(localRotationX ?? editingLayer.rotationX)}°
                </span>
              </div>
              <Slider
                value={[localRotationX ?? editingLayer.rotationX]}
                onValueChange={([value]) => setLocalRotationX(value)}
                onValueCommit={([value]) => {
                  updateHdriLayer(editingLayer.id, { rotationX: value });
                  setLocalRotationX(null);
                }}
                min={0}
                max={360}
                step={1}
                className="w-full"
              />
            </div>
            
            {/* Y Rotation Slider */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground flex items-center gap-1">
                  <RotateCw className="w-3 h-3" /> Y (Horizontal)
                </Label>
                <span className="text-xs text-muted-foreground w-10 text-right">
                  {Math.round(localRotationY ?? editingLayer.rotationY)}°
                </span>
              </div>
              <Slider
                value={[localRotationY ?? editingLayer.rotationY]}
                onValueChange={([value]) => setLocalRotationY(value)}
                onValueCommit={([value]) => {
                  updateHdriLayer(editingLayer.id, { rotationY: value });
                  setLocalRotationY(null);
                }}
                min={0}
                max={360}
                step={1}
                className="w-full"
              />
            </div>
          </div>
        )}
      </div>

      {/* Click outside hint */}
      <div className="text-xs text-muted-foreground mt-auto">
        Click outside frames for layout controls
      </div>
    </div>
  );
}
