"use client";

/**
 * Price table manager — shared by the admin page and the deploy dialog's
 * "sửa bảng giá" modal, so both show exactly the same controls.
 *
 * Each row is a named price table. "Global" holds the prices that used to be
 * hardcoded; add more (Uni, Novera, ...) and edit their numbers. The deploy
 * dialog picks one per deploy.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_PRICING, VERSION_ORDER, resolvePricing } from "@/lib/shopify/pricing";
import type { DeployPricing, DeployTemplate, ResolvedPricing } from "@/types/deploy-template";
import type { ShopifyVersionName } from "@/types/product";

/** Form state mirrors the editable fields; prices are strings while typing. */
interface PriceDraft {
  price: string;
  discountPercent: string;
}

interface FormState {
  name: string;
  vendor: string;
  versions: Record<ShopifyVersionName, PriceDraft>;
  modifiers: { laserShaft: string; customImage: string; customTextPaid: string };
}

function toDraft(pricing: ResolvedPricing): FormState["versions"] {
  const out = {} as FormState["versions"];
  for (const v of VERSION_ORDER) {
    out[v] = {
      price: String(pricing.versions[v].price),
      discountPercent: String(pricing.versions[v].discountPercent),
    };
  }
  return out;
}

function formFrom(template: DeployTemplate): FormState {
  const resolved = resolvePricing(template.pricing);
  return {
    name: template.name,
    vendor: template.vendor ?? "",
    versions: toDraft(resolved),
    modifiers: {
      laserShaft: String(resolved.modifiers.laserShaft),
      customImage: String(resolved.modifiers.customImage),
      customTextPaid: String(resolved.modifiers.customTextPaid),
    },
  };
}

/** Blank input = "not set", which persists as an absent key and inherits the default. */
function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function draftToPricing(form: FormState): DeployPricing {
  const versions: DeployPricing["versions"] = {};
  for (const v of VERSION_ORDER) {
    const price = numberOrUndefined(form.versions[v].price);
    const discountPercent = numberOrUndefined(form.versions[v].discountPercent);
    const entry: { price?: number; discountPercent?: number } = {};
    if (price !== undefined) entry.price = price;
    if (discountPercent !== undefined) entry.discountPercent = discountPercent;
    if (Object.keys(entry).length) versions[v] = entry;
  }

  const modifiers: DeployPricing["modifiers"] = {};
  for (const key of ["laserShaft", "customImage", "customTextPaid"] as const) {
    const n = numberOrUndefined(form.modifiers[key]);
    if (n !== undefined) modifiers[key] = n;
  }

  const out: DeployPricing = {};
  if (Object.keys(versions).length) out.versions = versions;
  if (Object.keys(modifiers).length) out.modifiers = modifiers;
  return out;
}

interface PriceTablesEditorProps {
  /** Preselect this table when opening (the one picked in the deploy dialog). */
  initialSelectedId?: string | null;
  /**
   * Called after any successful create/edit/delete so the opener can refresh its
   * own copy of the list. Receives the id that is now selected (null if deleted).
   */
  onChanged?: (selectedId: string | null) => void;
}

export function PriceTablesEditor({ initialSelectedId = null, onChanged }: PriceTablesEditorProps = {}) {
  const [templates, setTemplates] = useState<DeployTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>(initialSelectedId ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch("/api/shopify/deploy-templates");
      const data = (await res.json()) as { items?: DeployTemplate[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTemplates(data.items ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không tải được bảng giá.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Keep a template selected as the list loads/changes.
  useEffect(() => {
    if (!selectedId && templates.length) setSelectedId(templates[0].id);
  }, [templates, selectedId]);

  const [form, setForm] = useState<FormState>(() => ({
    name: "",
    vendor: "",
    versions: toDraft(DEFAULT_PRICING),
    modifiers: {
      laserShaft: String(DEFAULT_PRICING.modifiers.laserShaft),
      customImage: String(DEFAULT_PRICING.modifiers.customImage),
      customTextPaid: String(DEFAULT_PRICING.modifiers.customTextPaid),
    },
  }));

  // Reload the form whenever a different table is selected.
  useEffect(() => {
    if (selected) setForm(formFrom(selected));
  }, [selected]);

  async function handleCreate() {
    const name = window.prompt("Tên bảng giá mới (VD: Novera):")?.trim();
    if (!name) return;
    setSaving(true);
    setMessage(null);
    try {
      // A new table starts on the built-in prices, so it deploys identically to
      // today until its numbers are edited.
      const res = await fetch("/api/shopify/deploy-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, pricing: {} }),
      });
      const data = (await res.json()) as { item?: DeployTemplate; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await load(false);
      if (data.item) setSelectedId(data.item.id);
      onChanged?.(data.item?.id ?? null);
      setMessage(`Đã tạo bảng giá "${name}".`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Tạo bảng giá thất bại.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!selected) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/shopify/deploy-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selected.id,
          name: form.name,
          vendor: form.vendor || null,
          pricing: draftToPricing(form),
        }),
      });
      const data = (await res.json()) as { item?: DeployTemplate; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await load(false);
      onChanged?.(selected.id);
      setMessage("Đã lưu bảng giá.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Lưu thất bại.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selected) return;
    if (!window.confirm(`Xoá bảng giá "${selected.name}"? Sản phẩm đã đăng không bị xoá.`)) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/shopify/deploy-templates", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSelectedId("");
      await load(false);
      onChanged?.(null);
      setMessage("Đã xoá bảng giá.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Xoá thất bại.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Đang tải bảng giá...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Label className="text-xs mb-1 block">Bảng giá</Label>
          <Select value={selectedId || undefined} onValueChange={setSelectedId}>
            <SelectTrigger>
              <SelectValue placeholder="-- Chọn bảng giá --" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button type="button" variant="outline" onClick={handleCreate} disabled={saving} className="gap-2">
          <Plus className="h-4 w-4" /> Tạo bảng giá
        </Button>
      </div>

      {!selected && (
        <p className="text-sm text-muted-foreground">
          Chưa chọn bảng giá nào. Bấm &quot;Tạo bảng giá&quot; để thêm.
        </p>
      )}

      {selected && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs mb-1 block">Tên bảng giá</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Vendor (để trống = Uni Cues)</Label>
              <Input
                value={form.vendor}
                onChange={(e) => setForm((f) => ({ ...f, vendor: e.target.value }))}
                placeholder="VD: Novera Cues"
              />
            </div>
          </div>

          <div>
            <Label className="text-xs mb-2 block">Giá từng phiên bản</Label>
            <div className="space-y-2">
              {VERSION_ORDER.map((v) => (
                <div key={v} className="flex flex-wrap items-center gap-2">
                  <span className="w-20 text-sm">{v}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">Giá $</span>
                    <Input
                      type="number"
                      step="0.5"
                      min="0"
                      className="w-28"
                      value={form.versions[v].price}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          versions: { ...f.versions, [v]: { ...f.versions[v], price: e.target.value } },
                        }))
                      }
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">Giảm %</span>
                    <Input
                      type="number"
                      step="1"
                      min="0"
                      max="99"
                      className="w-20"
                      value={form.versions[v].discountPercent}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          versions: {
                            ...f.versions,
                            [v]: { ...f.versions[v], discountPercent: e.target.value },
                          },
                        }))
                      }
                    />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {/* Same formula the builder uses for compare_at_price. */}
                    compare_at_price ≈ $
                    {(() => {
                      const price = Number(form.versions[v].price);
                      const pct = Number(form.versions[v].discountPercent);
                      if (!Number.isFinite(price) || !Number.isFinite(pct) || pct >= 100) return "—";
                      return Math.round((price / (1 - pct / 100)) * 2) / 2;
                    })()}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              &quot;Giảm %&quot; chỉ dùng để tính compare_at_price, không giảm giá bán thật.
            </p>
          </div>

          <div>
            <Label className="text-xs mb-2 block">Phụ phí nhãn</Label>
            <div className="flex flex-wrap gap-3">
              {(
                [
                  ["laserShaft", "Shaft Engraving"],
                  ["customImage", "Custom Image"],
                  ["customTextPaid", "Custom Text (có phí)"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">{label} $</span>
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    className="w-24"
                    value={form.modifiers[key]}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, modifiers: { ...f.modifiers, [key]: e.target.value } }))
                    }
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={handleSave} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Lưu
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleDelete}
              disabled={saving}
              className="gap-2 text-red-500 hover:text-red-400"
            >
              <Trash2 className="h-4 w-4" /> Xoá bảng giá
            </Button>
          </div>
        </div>
      )}

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
