"use client";

import { useRef, useState, useCallback } from "react";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { X, Loader2, ImageIcon, Maximize2 } from "lucide-react";

interface SurfaceUploaderProps {
  productId: string;
  currentUrl?: string | null;
  onFileSelect: (file: File | null, previewUrl: string) => void;
  pendingFile?: File | null;
  pendingPreview?: string | null;
  uploading?: boolean;
}

export function SurfaceUploader({
  productId,
  currentUrl,
  onFileSelect,
  pendingFile,
  pendingPreview,
  uploading = false,
}: SurfaceUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Use pending preview if available, otherwise current URL
  const preview = pendingPreview || currentUrl || null;

  const handleFile = useCallback(
    (file: File) => {
      const localUrl = URL.createObjectURL(file);
      onFileSelect(file, localUrl);
    },
    [onFileSelect]
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

  function handleRemove() {
    onFileSelect(null, "");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Label>Surface Image</Label>

      {preview ? (
        <div className="relative rounded-lg overflow-hidden border bg-muted group">
          <img
            src={preview}
            alt="Surface preview"
            className="w-full h-32 object-contain bg-black/5"
          />
          {!uploading && (
            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200">
              <button
                onClick={() => setFullscreenOpen(true)}
                className="p-1.5 bg-background/90 rounded-lg text-foreground hover:bg-primary hover:text-primary-foreground cursor-pointer"
                title="View fullscreen"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              <button
                onClick={handleRemove}
                className="p-1.5 bg-background/90 rounded-lg text-foreground hover:bg-destructive hover:text-destructive-foreground cursor-pointer"
                title="Remove image"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {uploading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-6 w-6 text-primary animate-spin" />
                <span className="text-xs text-muted-foreground">Uploading...</span>
              </div>
            </div>
          )}
          {pendingFile && !uploading && (
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
          className={`w-full h-28 rounded-lg border-2 border-dashed bg-muted/30 flex flex-col items-center justify-center gap-2 transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
            isDragging
              ? "border-primary bg-primary/10"
              : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
          }`}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <ImageIcon className="h-5 w-5 text-primary" />
          </div>
          <span className="text-sm text-muted-foreground">
            {isDragging ? "Drop image here" : "Click or drag to upload"}
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

      <p className="text-xs text-muted-foreground">Recommended: 1141 × 8359</p>

      {/* Fullscreen Dialog */}
      <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] p-0 overflow-hidden">
          <DialogHeader className="p-4 pb-2">
            <DialogTitle>Surface Image</DialogTitle>
          </DialogHeader>
          <div className="p-4 pt-0 flex items-center justify-center bg-black/5">
            {preview && (
              <img
                src={preview}
                alt="Surface fullscreen"
                className="max-w-full max-h-[70vh] object-contain"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
