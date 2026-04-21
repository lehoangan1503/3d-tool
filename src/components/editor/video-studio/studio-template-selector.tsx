"use client";

import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import type { Ref } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Save, Trash2, FolderOpen, Plus } from "lucide-react";
import type {
  VideoStudioConfig,
  VideoStudioTemplate,
} from "@/types/video-studio";

type TemplateWithMeta = VideoStudioTemplate & { isOwner?: boolean };

const NEW_TEMPLATE_VALUE = "__new__";

export interface StudioTemplateSelectorHandle {
  triggerSave: () => void;
}

interface StudioTemplateSelectorProps {
  productId: string;
  currentConfig: VideoStudioConfig;
  onLoadConfig: (config: VideoStudioConfig) => void;
  onNewTemplate: () => void;
}

export const StudioTemplateSelector = forwardRef(function StudioTemplateSelector(
  {
    productId,
    currentConfig,
    onLoadConfig,
    onNewTemplate,
  }: StudioTemplateSelectorProps,
  ref: Ref<StudioTemplateSelectorHandle>
) {
  const [templates, setTemplates] = useState<TemplateWithMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showSaveChoiceDialog, setShowSaveChoiceDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        limit: "50",
      });
      const res = await fetch(`/api/video-studio-templates?${params}`);
      if (!res.ok) throw new Error("Failed to fetch templates");
      const json = await res.json();
      setTemplates((json.data ?? json.items ?? []) as VideoStudioTemplate[]);
    } catch (err) {
      console.error("StudioTemplateSelector fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleSelectChange = (value: string) => {
    if (value === NEW_TEMPLATE_VALUE) {
      setSelectedId(null);
      onNewTemplate();
      return;
    }
    setSelectedId(value);
    const template = templates.find((t) => t.id === value);
    if (template) onLoadConfig(template.config);
  };

  /** Open save — if a template is selected AND owned, show choice dialog; otherwise go straight to "save new" */
  const handleSaveClick = useCallback(() => {
    const selected = selectedId ? templates.find((t) => t.id === selectedId) : null;
    if (selected?.isOwner) {
      setShowSaveChoiceDialog(true);
    } else {
      setSaveName("");
      setShowSaveDialog(true);
    }
  }, [selectedId, templates]);

  useImperativeHandle(ref, () => ({ triggerSave: handleSaveClick }), [handleSaveClick]);

  const handleUpdateCurrent = useCallback(async () => {
    if (!selectedId) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/video-studio-templates/${selectedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: currentConfig }),
      });
      if (!res.ok) throw new Error("Failed to update template");
      await fetchTemplates();
    } catch (err) {
      console.error("StudioTemplateSelector save error:", err);
    } finally {
      setIsSaving(false);
      setShowSaveChoiceDialog(false);
    }
  }, [selectedId, currentConfig, fetchTemplates]);

  const handleSaveAsNew = useCallback(() => {
    setShowSaveChoiceDialog(false);
    setSaveName("");
    setShowSaveDialog(true);
  }, []);

  const handleSaveNew = useCallback(async () => {
    if (!saveName.trim()) return;

    setIsSaving(true);
    try {
      const res = await fetch("/api/video-studio-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: productId,
          name: saveName.trim(),
          config: currentConfig,
        }),
      });
      if (!res.ok) throw new Error("Failed to create template");
      const created = await res.json();
      setShowSaveDialog(false);
      setSaveName("");
      await fetchTemplates();
      setSelectedId((created as VideoStudioTemplate).id);
    } catch (err) {
      console.error("StudioTemplateSelector create error:", err);
    } finally {
      setIsSaving(false);
    }
  }, [saveName, productId, currentConfig, fetchTemplates]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    const template = templates.find((t) => t.id === selectedId);
    if (!template) return;

    const confirmed = window.confirm(
      `Xóa mẫu "${template.name}"? Hành động này không thể hoàn tác.`,
    );
    if (!confirmed) return;

    setIsLoading(true);
    try {
      const res = await fetch(`/api/video-studio-templates/${selectedId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete template");
      setSelectedId(null);
      await fetchTemplates();
    } catch (err) {
      console.error("StudioTemplateSelector delete error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [selectedId, templates, fetchTemplates]);

  const selectedTemplateName = selectedId
    ? templates.find((t) => t.id === selectedId)?.name
    : null;

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <FolderOpen className="h-3.5 w-3.5" />
        Mẫu Studio
      </Label>

      <div className="flex items-center gap-2">
        <Select
          value={selectedId ?? undefined}
          onValueChange={handleSelectChange}
        >
          <SelectTrigger className="h-8 flex-1">
            <SelectValue placeholder="Chọn mẫu…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_TEMPLATE_VALUE}>
              <span className="flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Mẫu mới…
              </span>
            </SelectItem>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                <span className="flex flex-col leading-tight">
                  <span>{t.name}</span>
                  {t.createdByName && (
                    <span className="text-[10px] text-muted-foreground">{t.createdByName}</span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={isLoading || isSaving || (!!selectedId && !templates.find(t => t.id === selectedId)?.isOwner)}
          onClick={handleSaveClick}
          title={selectedId ? "Lưu mẫu" : "Lưu thành mẫu mới"}
        >
          <Save className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={!selectedId || isLoading || isSaving || !templates.find(t => t.id === selectedId)?.isOwner}
          onClick={handleDelete}
          title="Xóa mẫu"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Save choice dialog — Update Current or Save as New */}
      <Dialog open={showSaveChoiceDialog} onOpenChange={setShowSaveChoiceDialog}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Lưu Mẫu</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={handleUpdateCurrent}
              disabled={isSaving}
            >
              <Save className="h-4 w-4 mr-2" />
              {isSaving ? "Đang lưu…" : `Cập nhật "${selectedTemplateName}"`}
            </Button>
            <Button
              className="w-full justify-start"
              variant="outline"
              onClick={handleSaveAsNew}
              disabled={isSaving}
            >
              <Plus className="h-4 w-4 mr-2" />
              Lưu thành Mẫu mới
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Save new template dialog */}
      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Lưu Mẫu</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="template-name" className="text-sm">
                Tên
              </Label>
              <Input
                id="template-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Mẫu của tôi"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && saveName.trim()) handleSaveNew();
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSaveDialog(false)}
              disabled={isSaving}
            >
              Hủy
            </Button>
            <Button
              onClick={handleSaveNew}
              disabled={!saveName.trim() || isSaving}
            >
              {isSaving ? "Đang lưu…" : "Lưu"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
