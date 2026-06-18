"use client";

import { useEffect, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";
import type { ExtractorReferenceGroup } from "@/types/extractor";
import type { ShopifySkill, ShopifyCollection, ShopifyWrapType } from "@/types/product";
import type { AutoDeployConfig, AutoDeployVersion } from "@/lib/auto-deploy/types";

interface VideoTemplateItem {
  id: string;
  name: string;
}

interface ModelOption {
  id: string;
  label: string;
}

interface AutoDeployConfigFormProps {
  value: AutoDeployConfig;
  onChange: (next: AutoDeployConfig) => void;
}

const ALL_VERSIONS: AutoDeployVersion[] = ["Standard", "Premium", "Pro"];
const WRAP_OPTIONS: ShopifyWrapType[] = ["wrap", "wrapless"];

export function AutoDeployConfigForm({ value, onChange }: AutoDeployConfigFormProps) {
  const [groups, setGroups] = useState<ExtractorReferenceGroup[]>([]);
  const [skills, setSkills] = useState<ShopifySkill[]>([]);
  const [collections, setCollections] = useState<ShopifyCollection[]>([]);
  const [videoTemplates, setVideoTemplates] = useState<VideoTemplateItem[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Don't abort the in-flight fetches on cleanup: under React 18 Strict Mode the
    // effect runs twice on mount and an AbortController would reject the first run's
    // requests ("signal is aborted without reason"). Instead, just gate state writes
    // on a mounted flag so we never setState after unmount.
    let mounted = true;
    const get = (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

    Promise.all([
      get("/api/extractor-reference-groups"),
      get("/api/shopify/skills"),
      get("/api/shopify/collections"),
      get("/api/video-studio-templates?limit=100"),
      get("/api/shopify/generate-content"),
    ])
      .then(([g, s, c, v, m]) => {
        if (!mounted) return;
        if (g?.items) setGroups(g.items as ExtractorReferenceGroup[]);
        if (s?.items) setSkills(s.items as ShopifySkill[]);
        if (c?.items) setCollections(c.items as ShopifyCollection[]);
        if (v?.items) setVideoTemplates((v.items as VideoTemplateItem[]).map((t) => ({ id: t.id, name: t.name })));
        if (m?.models?.length) setModels(m.models as ModelOption[]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  function patch(p: Partial<AutoDeployConfig>) {
    onChange({ ...value, ...p });
  }

  function toggleGroup(id: string) {
    patch({
      groupIds: value.groupIds.includes(id)
        ? value.groupIds.filter((g) => g !== id)
        : [...value.groupIds, id],
    });
  }

  function toggleSkill(id: string) {
    patch({
      skillIds: value.skillIds.includes(id)
        ? value.skillIds.filter((s) => s !== id)
        : [...value.skillIds, id],
    });
  }

  function toggleVersion(v: AutoDeployVersion) {
    patch({
      versions: value.versions.includes(v)
        ? value.versions.filter((x) => x !== v)
        : [...value.versions, v],
    });
  }

  function toggleCollection(val: string) {
    const list = value.collections.split(",").map((c) => c.trim()).filter(Boolean);
    const next = list.includes(val) ? list.filter((c) => c !== val) : [...list, val];
    const breadcrumb = next.includes(value.breadcrumbCollection ?? "") ? value.breadcrumbCollection : null;
    patch({ collections: next.join(", "), breadcrumbCollection: breadcrumb });
  }

  const selectedCollections = value.collections.split(",").map((c) => c.trim()).filter(Boolean);
  const videoOn = value.videoTemplateId !== null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Đang tải cấu hình...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Render group */}
      <Field label="Nhóm khung ảnh để render" required>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              {value.groupIds.length === 0 ? "Chọn nhóm..." : `${value.groupIds.length} nhóm đã chọn`}
              <ChevronDown className="w-4 h-4 ml-2 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2 max-h-64 overflow-y-auto">
            {groups.length === 0 && <Empty>Chưa có nhóm nào</Empty>}
            {groups.map((g) => (
              <CheckRow key={g.id} checked={value.groupIds.includes(g.id)} onToggle={() => toggleGroup(g.id)}>
                {g.name}
              </CheckRow>
            ))}
          </PopoverContent>
        </Popover>
      </Field>

      {/* Versions */}
      <Field label="Phiên bản" required>
        <div className="flex gap-2 flex-wrap">
          {ALL_VERSIONS.map((v) => (
            <Chip key={v} active={value.versions.includes(v)} onClick={() => toggleVersion(v)}>
              {v}
            </Chip>
          ))}
        </div>
      </Field>

      {/* Wrap / Wrapless */}
      <Field label="Wrap / Wrapless" required>
        <div className="flex gap-2">
          {WRAP_OPTIONS.map((w) => (
            <Chip key={w} active={value.wrapType === w} onClick={() => patch({ wrapType: w })}>
              {w === "wrap" ? "Wrap" : "Wrapless"}
            </Chip>
          ))}
        </div>
      </Field>

      {/* Labels */}
      <Field label="Labels">
        <div className="flex gap-2 flex-wrap">
          <Chip active={value.laserShaft} onClick={() => patch({ laserShaft: !value.laserShaft })}>
            Shaft Engraving (+$20)
          </Chip>
          <Chip active={value.customImage} onClick={() => patch({ customImage: !value.customImage })}>
            Custom Image (+$20)
          </Chip>
          {/* Two mutually-exclusive custom-text modes: paid (+$20) vs free. */}
          <Chip
            active={value.customTextMode === "paid"}
            onClick={() => patch({ customTextMode: value.customTextMode === "paid" ? "none" : "paid" })}
          >
            Custom Text (+$20)
          </Chip>
          <Chip
            active={value.customTextMode === "free"}
            onClick={() => patch({ customTextMode: value.customTextMode === "free" ? "none" : "free" })}
          >
            Custom Text
          </Chip>
        </div>

        {/* Custom Text fields — required when a custom-text mode is on */}
        {value.customTextMode !== "none" && (
          <div className="flex flex-col gap-2 mt-3 pl-3 border-l-2 border-teal-500/40">
            <p className="text-[11px] text-teal-600 dark:text-teal-300/70">
              {value.customTextMode === "paid"
                ? "Custom Text tính phí (+$20) — cần làm thiết kế thêm."
                : "Custom Text miễn phí — chỉ thêm vào thiết kế."}
            </p>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">
                Custom text label <span className="text-destructive">*</span>
              </Label>
              <Input
                value={value.customTextLabel}
                onChange={(e) => patch({ customTextLabel: e.target.value })}
                placeholder="Enter your title/name"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">
                Custom text example <span className="text-destructive">*</span>
              </Label>
              <Input
                value={value.customTextExample}
                onChange={(e) => patch({ customTextExample: e.target.value })}
                placeholder="Example: Daddy, Dad, Michael,..."
              />
            </div>
          </div>
        )}
      </Field>

      {/* Skills */}
      <Field label="Skill (AI prompt)">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              {value.skillIds.length === 0 ? "Chọn skill..." : `${value.skillIds.length} skill đã chọn`}
              <ChevronDown className="w-4 h-4 ml-2 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2 max-h-64 overflow-y-auto">
            {skills.length === 0 && <Empty>Chưa có skill nào</Empty>}
            {skills.map((s) => (
              <CheckRow key={s.id} checked={value.skillIds.includes(s.id)} onToggle={() => toggleSkill(s.id)}>
                {s.name}
              </CheckRow>
            ))}
          </PopoverContent>
        </Popover>
      </Field>

      {/* Collections (labels) */}
      <Field label="Collection / Labels">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              {selectedCollections.length === 0 ? "Chọn collection..." : `${selectedCollections.length} đã chọn`}
              <ChevronDown className="w-4 h-4 ml-2 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2 max-h-64 overflow-y-auto">
            {collections.length === 0 && <Empty>Chưa có collection nào</Empty>}
            {collections.map((c) => (
              <CheckRow key={c.id} checked={selectedCollections.includes(c.value)} onToggle={() => toggleCollection(c.value)}>
                {c.value}
              </CheckRow>
            ))}
          </PopoverContent>
        </Popover>
        {selectedCollections.length > 0 && (
          <div className="flex flex-col gap-1 mt-2">
            <span className="text-xs text-muted-foreground">Breadcrumb (hiển thị chính):</span>
            <div className="flex flex-wrap gap-1.5">
              {selectedCollections.map((c) => (
                <Chip key={c} active={value.breadcrumbCollection === c} onClick={() => patch({ breadcrumbCollection: c })}>
                  {c}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </Field>

      {/* AI model */}
      <Field label="AI model">
        <select
          value={value.aiModel}
          onChange={(e) => patch({ aiModel: e.target.value })}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {(models.length ? models : [{ id: value.aiModel, label: value.aiModel }]).map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </Field>

      {/* Video (optional) */}
      <Field label="Video (tùy chọn)">
        <CheckRow
          checked={videoOn}
          onToggle={() => patch({ videoTemplateId: videoOn ? null : (videoTemplates[0]?.id ?? null) })}
        >
          Render video cho mỗi sản phẩm
        </CheckRow>
        {videoOn && (
          <>
            <select
              value={value.videoTemplateId ?? ""}
              onChange={(e) => patch({ videoTemplateId: e.target.value || null })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm mt-2"
            >
              {videoTemplates.length === 0 && <option value="">Chưa có template video</option>}
              {videoTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 mt-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Video sẽ rất chậm nếu chọn nhiều sản phẩm.
            </p>
          </>
        )}
      </Field>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-sm font-medium">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
    </div>
  );
}

function CheckRow({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer hover:bg-muted/60 text-sm">
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      {children}
    </label>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-3 py-1.5 rounded-md text-sm font-medium border transition-colors",
        active ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-transparent hover:bg-muted/70",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1.5 text-xs text-muted-foreground">{children}</div>;
}
