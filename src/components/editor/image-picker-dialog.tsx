"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Search, Upload, Loader2, X, Check, ImageIcon, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface StorageImage {
  name: string;
  path: string;
  url: string;
  createdAt?: string;
  isOwn?: boolean;
}

interface ImagePickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (url: string) => void;
  currentUrl?: string | null;
}

const PAGE_SIZE = 30;

export function ImagePickerDialog({
  open,
  onClose,
  onSelect,
  currentUrl,
}: ImagePickerDialogProps) {
  const [images, setImages] = useState<StorageImage[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedUrl, setSelectedUrl] = useState<string | null>(currentUrl || null);
  const [filterMode, setFilterMode] = useState<"all" | "mine">("all");

  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadImages = useCallback(
    async (offset: number, searchTerm: string, append: boolean, filter: "all" | "mine") => {
      if (offset === 0) setIsLoading(true);
      else setIsFetchingMore(true);

      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
          filter,
          ...(searchTerm ? { search: searchTerm } : {}),
        });
        const res = await fetch(`/api/storage-images?${params}`);
        if (!res.ok) throw new Error("Failed to load images");
        const { images: data, total: t } = await res.json();
        setImages((prev) => (append ? [...prev, ...data] : data));
        setTotal(t);
      } catch (err) {
        console.error("ImagePickerDialog load error:", err);
      } finally {
        setIsLoading(false);
        setIsFetchingMore(false);
      }
    },
    []
  );

  // Load when dialog opens, search or filter changes
  useEffect(() => {
    if (!open) return;
    loadImages(0, debouncedSearch, false, filterMode);
  }, [open, debouncedSearch, filterMode, loadImages]);

  // Sync currentUrl when prop changes
  useEffect(() => {
    setSelectedUrl(currentUrl || null);
  }, [currentUrl]);

  // Reset state on close
  useEffect(() => {
    if (!open) {
      setSearch("");
      setUploadFile(null);
      setUploadName("");
      setUploadError(null);
    }
  }, [open]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFile(file);
    setUploadName(file.name.replace(/\.[^.]+$/, ""));
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleUpload = async () => {
    if (!uploadFile || !uploadName.trim()) return;
    setIsUploading(true);
    setUploadError(null);

    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      fd.append("customName", uploadName.trim());

      const res = await fetch("/api/upload-overlay", { method: "POST", body: fd });
      if (!res.ok) throw new Error("Upload failed");

      const { url } = await res.json();

      setUploadFile(null);
      setUploadName("");

      // Reload and auto-select the new image
      await loadImages(0, debouncedSearch, false, filterMode);
      setSelectedUrl(url);
      onSelect(url);
      onClose();
    } catch {
      setUploadError("Tải lên thất bại. Vui lòng thử lại.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleSelect = (url: string) => {
    setSelectedUrl(url);
    onSelect(url);
    onClose();
  };

  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, img: StorageImage) => {
    e.stopPropagation();
    if (deletingPath) return;
    setDeletingPath(img.path);
    try {
      const res = await fetch(`/api/storage-images?path=${encodeURIComponent(img.path)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      setImages((prev) => prev.filter((i) => i.path !== img.path));
      setTotal((prev) => prev - 1);
      if (selectedUrl === img.url) setSelectedUrl(null);
    } catch (err) {
      console.error("ImagePickerDialog delete error:", err);
    } finally {
      setDeletingPath(null);
    }
  };

  const hasMore = images.length < total;
  const uploadExt = uploadFile?.name.split(".").pop() ?? "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5" />
            Thư Viện Ảnh
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          {/* Upload section */}
          <div className="px-6 py-4 border-b bg-muted/20 flex-shrink-0">
            <div className="flex items-end gap-2 flex-wrap">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileSelect}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="flex-shrink-0"
              >
                <Upload className="h-4 w-4 mr-2" />
                {uploadFile ? "Đổi tệp" : "Tải lên ảnh mới"}
              </Button>

              {uploadFile && (
                <>
                  <div className="flex-1 min-w-[160px]">
                    <Label className="text-xs text-muted-foreground mb-1 block">
                      Tên tệp <span className="text-muted-foreground/60">(đổi tên trước khi tải lên)</span>
                    </Label>
                    <Input
                      value={uploadName}
                      onChange={(e) => setUploadName(e.target.value)}
                      placeholder="Nhập tên tệp..."
                      className="h-8 text-sm"
                      onKeyDown={(e) => e.key === "Enter" && handleUpload()}
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={handleUpload}
                    disabled={isUploading || !uploadName.trim()}
                    className="flex-shrink-0"
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Đang tải lên…
                      </>
                    ) : (
                      <>
                        <Check className="h-4 w-4 mr-2" />
                        Tải lên
                      </>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setUploadFile(null);
                      setUploadName("");
                      setUploadError(null);
                    }}
                    className="flex-shrink-0"
                    disabled={isUploading}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>

            {uploadFile && uploadName.trim() && (
              <p className="text-[11px] text-muted-foreground/70 mt-1.5">
                Sẽ lưu thành:{" "}
                <span className="font-mono text-muted-foreground">
                  {uploadName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "image"}
                  _{"{timestamp}"}.{uploadExt}
                </span>
              </p>
            )}
            {uploadError && (
              <p className="text-xs text-destructive mt-1.5">{uploadError}</p>
            )}
          </div>

          {/* Filter tabs + Search */}
          <div className="px-6 py-3 border-b flex-shrink-0 flex items-center gap-3">
            {/* Filter tabs */}
            <div className="flex rounded-md border overflow-hidden flex-shrink-0">
              <button
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  filterMode === "all"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
                onClick={() => setFilterMode("all")}
              >
                Tất cả
              </button>
              <button
                className={cn(
                  "px-3 py-1.5 text-xs font-medium border-l transition-colors",
                  filterMode === "mine"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
                onClick={() => setFilterMode("mine")}
              >
                Ảnh bạn tải lên
              </button>
            </div>

            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm kiếm ảnh theo tên…"
                className="pl-9 h-9"
              />
            </div>
          </div>

          {/* Image grid */}
          <div className="flex-1 overflow-y-auto p-6">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : images.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <ImageIcon className="h-12 w-12 text-muted-foreground/25 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {search ? "Không tìm thấy ảnh nào" : "Chưa có ảnh nào"}
                </p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Dùng &ldquo;Tải lên ảnh mới&rdquo; ở trên để thêm ảnh đầu tiên
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-3">
                  {images.map((img) => {
                    const isActive = selectedUrl === img.url;
                    const isDeleting = deletingPath === img.path;
                    const canDelete = img.isOwn !== false;
                    return (
                      <button
                        key={img.path}
                        className={cn(
                          "group relative rounded-lg overflow-hidden border-2 transition-all text-left focus:outline-none",
                          isActive
                            ? "border-blue-500 shadow-[0_0_0_2px_rgb(59_130_246/0.3)]"
                            : "border-border hover:border-muted-foreground/50 hover:shadow-sm"
                        )}
                        onClick={() => handleSelect(img.url)}
                      >
                        <div className="aspect-square bg-muted/30">
                          <img
                            src={img.url}
                            alt={img.name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        </div>
                        <div className="px-1.5 py-1 bg-background">
                          <p className="text-[10px] text-muted-foreground truncate leading-tight">
                            {img.name}
                          </p>
                        </div>
                        {isActive && (
                          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center shadow">
                            <Check className="h-3 w-3 text-white" />
                          </div>
                        )}
                        {/* Delete button — only for own images */}
                        {canDelete && (
                          <button
                            type="button"
                            className="absolute top-1.5 left-1.5 w-6 h-6 rounded bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 focus:opacity-100"
                            onClick={(e) => handleDelete(e, img)}
                            disabled={isDeleting}
                            title="Xóa ảnh"
                          >
                            {isDeleting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </button>
                        )}
                      </button>
                    );
                  })}
                </div>

                {hasMore && (
                  <div className="flex justify-center mt-6">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadImages(images.length, debouncedSearch, true, filterMode)}
                      disabled={isFetchingMore}
                    >
                      {isFetchingMore ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Đang tải…
                        </>
                      ) : (
                        `Tải thêm (còn ${total - images.length})`
                      )}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
