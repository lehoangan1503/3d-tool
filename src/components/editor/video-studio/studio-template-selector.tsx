"use client";

import { useState, useEffect, useCallback } from "react";
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

const NEW_TEMPLATE_VALUE = "__new__";

interface StudioTemplateSelectorProps {
  productId: string;
  currentConfig: VideoStudioConfig;
  onLoadConfig: (config: VideoStudioConfig) => void;
}

export function StudioTemplateSelector({
  productId,
  currentConfig,
  onLoadConfig,
}: StudioTemplateSelectorProps) {
  const [templates, setTemplates] = useState<VideoStudioTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        product_id: productId,
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
      setSaveName("");
      setShowSaveDialog(true);
      return;
    }
    setSelectedId(value);
    const template = templates.find((t) => t.id === value);
    if (template) onLoadConfig(template.config);
  };

  const handleSave = useCallback(async () => {
    if (!selectedId) {
      setSaveName("");
      setShowSaveDialog(true);
      return;
    }

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
    }
  }, [selectedId, currentConfig, fetchTemplates]);

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
      `Delete template "${template.name}"? This cannot be undone.`,
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

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <FolderOpen className="h-3.5 w-3.5" />
        Studio Templates
      </Label>

      <div className="flex items-center gap-2">
        <Select
          value={selectedId ?? undefined}
          onValueChange={handleSelectChange}
        >
          <SelectTrigger className="h-8 flex-1">
            <SelectValue placeholder="Select template…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_TEMPLATE_VALUE}>
              <span className="flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                New Template…
              </span>
            </SelectItem>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={isLoading || isSaving}
          onClick={handleSave}
          title={selectedId ? "Save to template" : "Save as new template"}
        >
          <Save className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={!selectedId || isLoading || isSaving}
          onClick={handleDelete}
          title="Delete template"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="template-name" className="text-sm">
                Name
              </Label>
              <Input
                id="template-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="My template"
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
              Cancel
            </Button>
            <Button
              onClick={handleSaveNew}
              disabled={!saveName.trim() || isSaving}
            >
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
