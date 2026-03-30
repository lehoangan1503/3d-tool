"use client";

import { useState, useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Images, Trash2, Link2, Link2Off, Check } from "lucide-react";
import type { ImageFrame, ObjectFit } from "@/types/extractor";
import { ImagePickerDialog } from "./image-picker-dialog";

interface ImageFrameControlsProps {
  frame: ImageFrame;
  onFrameChange: (frame: ImageFrame) => void;
}

const OBJECT_FIT_OPTIONS: { value: ObjectFit; label: string }[] = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'custom', label: 'Custom' },
];

export function ImageFrameControls({ frame, onFrameChange }: ImageFrameControlsProps) {
  const [linkedDimensions, setLinkedDimensions] = useState(frame.imageSettings.objectFit !== 'custom');
  const [pickerOpen, setPickerOpen] = useState(false);

  const { imageSettings, transform } = frame;

  const updateImageSettings = useCallback((updates: Partial<typeof imageSettings>) => {
    onFrameChange({
      ...frame,
      imageSettings: { ...imageSettings, ...updates },
    });
  }, [frame, imageSettings, onFrameChange]);

  const updateTransform = useCallback((updates: Partial<typeof transform>) => {
    onFrameChange({
      ...frame,
      transform: { ...transform, ...updates },
    });
  }, [frame, transform, onFrameChange]);

  const handleObjectFitChange = useCallback((value: ObjectFit) => {
    setLinkedDimensions(value !== 'custom');
    updateImageSettings({ objectFit: value });
  }, [updateImageSettings]);

  const handleWidthChange = useCallback((width: number) => {
    if (linkedDimensions) {
      const aspectRatio = transform.width / transform.height;
      updateTransform({ width, height: Math.round(width / aspectRatio) });
    } else {
      updateTransform({ width });
    }
  }, [linkedDimensions, transform, updateTransform]);

  const handleHeightChange = useCallback((height: number) => {
    if (linkedDimensions) {
      const aspectRatio = transform.width / transform.height;
      updateTransform({ width: Math.round(height * aspectRatio), height });
    } else {
      updateTransform({ height });
    }
  }, [linkedDimensions, transform, updateTransform]);

  const handleRemoveImage = useCallback(() => {
    updateImageSettings({ imageUrl: null });
  }, [updateImageSettings]);

  const bgEnabled = imageSettings.backgroundEnabled ?? true;
  const imageOpacity = imageSettings.imageOpacity ?? imageSettings.opacity ?? 1;
  const backgroundOpacity = imageSettings.backgroundOpacity ?? 1;

  return (
    <div className="space-y-4">
      {/* Image Picker Dialog */}
      <ImagePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(url) => updateImageSettings({ imageUrl: url })}
        currentUrl={imageSettings.imageUrl}
      />

      {/* Image Upload */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">Image</Label>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => setPickerOpen(true)}
          >
            <Images className="h-3.5 w-3.5 mr-2" />
            {imageSettings.imageUrl ? "Replace Image" : "Choose Image"}
          </Button>
          {imageSettings.imageUrl && (
            <Button variant="outline" size="sm" onClick={handleRemoveImage}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        {imageSettings.imageUrl && (
          <div className="rounded border overflow-hidden bg-muted/30">
            <img
              src={imageSettings.imageUrl}
              alt="Preview"
              className="w-full h-16 object-cover"
            />
          </div>
        )}
      </div>

      {/* Image Opacity */}
      {imageSettings.imageUrl && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <Label className="font-medium text-muted-foreground">Image Opacity</Label>
            <span className="text-muted-foreground">{Math.round(imageOpacity * 100)}%</span>
          </div>
          <Slider
            value={[imageOpacity * 100]}
            onValueChange={([v]) => updateImageSettings({ imageOpacity: v / 100 })}
            min={0}
            max={100}
            step={1}
          />
        </div>
      )}

      {/* Image Fit */}
      {imageSettings.imageUrl && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Image Fit</Label>
          <Select value={imageSettings.objectFit} onValueChange={handleObjectFitChange}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OBJECT_FIT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Background Color — with toggle */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium text-muted-foreground">Background</Label>
          {/* Tick toggle */}
          <button
            type="button"
            onClick={() => updateImageSettings({ backgroundEnabled: !bgEnabled })}
            className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
              bgEnabled
                ? "bg-primary border-primary text-primary-foreground"
                : "border-muted-foreground/40 hover:border-muted-foreground"
            }`}
            title={bgEnabled ? "Remove background" : "Add background"}
          >
            {bgEnabled && <Check className="w-3 h-3" />}
          </button>
        </div>
        {bgEnabled && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                type="color"
                value={imageSettings.backgroundColor}
                onChange={(e) => updateImageSettings({ backgroundColor: e.target.value })}
                className="w-10 h-8 p-0.5 cursor-pointer"
              />
              <Input
                type="text"
                value={imageSettings.backgroundColor}
                onChange={(e) => updateImageSettings({ backgroundColor: e.target.value })}
                className="flex-1 h-8 font-mono text-xs"
                placeholder="#2a2a2a"
              />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Opacity</span>
                <span className="text-muted-foreground">{Math.round(backgroundOpacity * 100)}%</span>
              </div>
              <Slider
                value={[backgroundOpacity * 100]}
                onValueChange={([v]) => updateImageSettings({ backgroundOpacity: v / 100 })}
                min={0}
                max={100}
                step={1}
              />
            </div>
          </div>
        )}
      </div>

      {/* Dimensions */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium text-muted-foreground">Dimensions</Label>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5"
            onClick={() => setLinkedDimensions(!linkedDimensions)}
            disabled={imageSettings.objectFit !== 'custom'}
          >
            {linkedDimensions ? <Link2 className="h-3 w-3" /> : <Link2Off className="h-3 w-3" />}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-muted-foreground">W</Label>
            <Input
              type="number"
              value={transform.width}
              onChange={(e) => handleWidthChange(Number(e.target.value))}
              min={50}
              max={2048}
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">H</Label>
            <Input
              type="number"
              value={transform.height}
              onChange={(e) => handleHeightChange(Number(e.target.value))}
              min={50}
              max={2048}
              className="h-8"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
