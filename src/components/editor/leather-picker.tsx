"use client";

import { useRef, useState, useCallback } from "react";
import { LEATHER_COLORS, LEATHER_TEXTURES } from "@/types/product";
import type { LeatherColor, LeatherTextureType } from "@/types/product";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Check, ImageIcon, X, Loader2 } from "lucide-react";

interface LeatherPickerProps {
  textureType: LeatherTextureType;
  color: LeatherColor;
  onTextureChange: (texture: LeatherTextureType) => void;
  onColorChange: (color: LeatherColor) => void;
  onCustomTextureSelect?: (file: File | null, previewUrl: string) => void;
  customTexturePending?: File | null;
  customTexturePreview?: string | null;
  uploading?: boolean;
}

export function LeatherPicker({
  textureType,
  color,
  onTextureChange,
  onColorChange,
  onCustomTextureSelect,
  customTexturePending,
  customTexturePreview,
  uploading = false,
}: LeatherPickerProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      const localUrl = URL.createObjectURL(file);
      onCustomTextureSelect?.(file, localUrl);
    },
    [onCustomTextureSelect]
  );

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      handleFile(file);
    }
  }

  function handleRemoveCustomTexture() {
    onCustomTextureSelect?.(null, "");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Texture Type */}
      <div className="flex flex-col gap-2">
        <Label>Texture Type</Label>
        <Select value={textureType} onValueChange={(v) => onTextureChange(v as LeatherTextureType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(LEATHER_TEXTURES).map(([key, { name }]) => (
              <SelectItem key={key} value={key}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Custom Texture Upload (only when custom is selected) */}
      {textureType === "custom" && (
        <div className="flex flex-col gap-2">
          <Label>Custom Texture</Label>
          {customTexturePreview ? (
            <div className="relative rounded-lg overflow-hidden border bg-muted group">
              <img
                src={customTexturePreview}
                alt="Custom texture preview"
                className="w-full h-24 object-contain bg-black/5"
              />
              {!uploading && (
                <button
                  onClick={handleRemoveCustomTexture}
                  className="absolute top-2 right-2 p-1.5 bg-background/90 rounded-lg text-foreground opacity-0 group-hover:opacity-100 transition-all duration-200 hover:bg-destructive hover:text-destructive-foreground cursor-pointer"
                  title="Remove texture"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
              {uploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
                  <Loader2 className="h-5 w-5 text-primary animate-spin" />
                </div>
              )}
              {customTexturePending && !uploading && (
                <div className="absolute bottom-2 left-2 px-2 py-1 bg-amber-500/90 text-amber-950 text-xs rounded font-medium">
                  Unsaved
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => inputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              disabled={uploading}
              className={`w-full h-20 rounded-lg border-2 border-dashed bg-muted/30 flex flex-col items-center justify-center gap-1.5 transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                isDragging
                  ? "border-primary bg-primary/10"
                  : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
              }`}
            >
              <ImageIcon className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {isDragging ? "Drop texture here" : "Upload leather texture"}
              </span>
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      )}

      {/* Color Palette */}
      <div className="flex flex-col gap-2">
        <Label>Color</Label>
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(LEATHER_COLORS).map(([key, { name, hex }]) => (
            <button
              key={key}
              onClick={() => onColorChange(key as LeatherColor)}
              className={cn(
                "aspect-square rounded-lg border-2 transition-all duration-200 relative cursor-pointer",
                "hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                color === key
                  ? "border-primary ring-2 ring-primary/30"
                  : "border-transparent hover:border-muted-foreground/30"
              )}
              style={{ backgroundColor: hex }}
              title={name}
            >
              {color === key && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-white/90 shadow-sm">
                    <Check className="h-4 w-4 text-primary" />
                  </div>
                </div>
              )}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Selected: {LEATHER_COLORS[color]?.name || color}
        </p>
      </div>
    </div>
  );
}
