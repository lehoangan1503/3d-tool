"use client";

import { useRef } from "react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, X, RotateCcw } from "lucide-react";
import type { LogoBackdropConfig, LogoBackdropStyle } from "@/types/video-studio";
import { DEFAULT_LOGO_BACKDROP } from "@/types/video-studio";
import { CUE_LOGO_OPTIONS } from "@/types/product";

interface LogoBackdropPanelProps {
  config: LogoBackdropConfig;
  onChange: (patch: Partial<LogoBackdropConfig>) => void;
  /** The product's own engraved logo id, shown as the label of the "auto" option. */
  productLogoId?: string | null;
  /** Called with a fresh object URL so the studio can revoke it on unmount. */
  onCustomUpload: (url: string) => void;
}

/**
 * Logo row with a thumbnail, matching the "Logo khắc laser" picker on the 3D preview page
 * so the same mark is recognisable in both places.
 */
function LogoOptionRow({ label, path }: { label: string; path?: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="h-6 w-6 shrink-0 rounded border border-white/15 bg-neutral-700 bg-contain bg-center bg-no-repeat"
        style={path ? { backgroundImage: `url(${path})` } : undefined}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * Neon colour presets.
 *
 * Colour ONLY. Every swatch sets `color` and `neonColor` and touches nothing else, so the
 * tube shape you dialled in — brightness, glow, core width, bloom, flicker — survives
 * picking a different colour. An earlier version bundled a full look into half the swatches,
 * which meant clicking a colour silently rewrote six other sliders.
 */
interface NeonPreset {
  label: string;
  color: string;
  neonColor: string;
}

const NEON_PRESETS: NeonPreset[] = [
  { label: "Hồng",      color: "#ffffff", neonColor: "#ff1177" },
  { label: "Lam",       color: "#ffffff", neonColor: "#00b3ff" },
  { label: "Lục",       color: "#ffffff", neonColor: "#22ff88" },
  { label: "Tím",       color: "#ffffff", neonColor: "#9d00ff" },
  { label: "Cam",       color: "#fff4e0", neonColor: "#ff7a00" },
  { label: "Hồng sen",  color: "#ffffff", neonColor: "#ff2d95" },
  { label: "Xanh ngọc", color: "#ffffff", neonColor: "#00e5ff" },
  { label: "Băng",      color: "#eaf6ff", neonColor: "#7fd4ff" },
  { label: "Hổ phách",  color: "#fff0d0", neonColor: "#ff9a2e" },
  { label: "Đỏ",        color: "#ffe8e8", neonColor: "#ff1830" },
];

/** Compact labelled slider — the studio's house style for a 0–1 control. */
function Row({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-0.5">
      <Label className="text-[10px] text-muted-foreground">
        {label} — {format ? format(value) : value.toFixed(2)}
      </Label>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}

/** Colour swatch + hex field pair. */
function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label className="flex-1 text-[10px] text-muted-foreground">{label}</Label>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border/50 bg-transparent p-0.5"
      />
      <input
        type="text"
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-[68px] rounded border border-border/50 bg-muted/30 px-1.5 font-mono text-[10px] uppercase outline-none focus:border-blue-500/50"
      />
    </div>
  );
}

/**
 * Controls for the giant logo plate drawn behind the cue.
 *
 * The plate is rendered by a camera-locked overlay pass, so none of these values move
 * anything in the 3D world — they are all frame-space (fractions of the output frame),
 * which is why the offsets read -1..1 rather than in scene units.
 */
export function LogoBackdropPanel({
  config,
  onChange,
  productLogoId,
  onCustomUpload,
}: LogoBackdropPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const isNeon = config.style === "neon";
  const autoOption =
    CUE_LOGO_OPTIONS.find((o) => o.id === productLogoId) ?? CUE_LOGO_OPTIONS[0];
  const autoLabel = autoOption.label;
  const autoPath = autoOption.path;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id="logo-backdrop-enabled"
          checked={config.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked === true })}
        />
        <Label htmlFor="logo-backdrop-enabled" className="text-[11px] cursor-pointer">
          Hiện logo lớn phía sau cơ
        </Label>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[10px]"
          title="Đặt lại"
          onClick={() => onChange({ ...DEFAULT_LOGO_BACKDROP, enabled: config.enabled })}
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </div>

      <p className="text-[10px] leading-snug text-muted-foreground">
        Logo được dán lên tường phía sau, là vật thể thật trong bối cảnh: cơ che phía trước,
        logo chạy theo phối cảnh khi camera di chuyển.
      </p>

      {config.enabled && (
        <>
          {/* ── Placement ──────────────────────────────────────────────────
              The plate is always real geometry on the wall, so the cue occludes it and it
              takes the set's perspective. The only choice is whether it is positioned
              against the CAMERA'S VIEW of the wall (holding its spot in the shot) or
              against the wall itself (fixed to one place, drifting through frame). */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id="logo-frame-relative"
                checked={config.frameRelative ?? false}
                onCheckedChange={(checked) => onChange({ frameRelative: checked === true })}
                className="h-3.5 w-3.5"
              />
              <Label htmlFor="logo-frame-relative" className="text-[10px] font-medium cursor-pointer">
                Luôn giữ trong khung hình
              </Label>
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {config.frameRelative
                ? "Logo nằm trên tường (cơ che phía trước) và được đặt theo vùng tường camera nhìn thấy, nên nó đứng yên trong khung hình khi camera di chuyển."
                : "Logo cố định tại một vị trí trên tường — camera di chuyển thì logo sẽ trôi qua khung hình."}
            </p>
          </div>

          {/* ── Which logo ────────────────────────────────────────────────── */}
          <div className="space-y-0.5">
            <Label className="text-[10px] text-muted-foreground">Logo</Label>
            <Select
              value={config.customUrl ? "custom" : config.logoId}
              onValueChange={(v) => {
                if (v === "custom") {
                  fileRef.current?.click();
                  return;
                }
                onChange({ logoId: v, customUrl: null });
              }}
            >
              <SelectTrigger className="h-6 text-[10px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" className="py-1.5">
                  <LogoOptionRow label={`Theo logo khắc laser (${autoLabel})`} path={autoPath} />
                </SelectItem>
                {CUE_LOGO_OPTIONS.map((o) => (
                  <SelectItem key={o.id} value={o.id} className="py-1.5">
                    <LogoOptionRow label={o.label} path={o.path} />
                  </SelectItem>
                ))}
                {config.customUrl && (
                  <SelectItem value="custom" className="py-1.5">
                    <LogoOptionRow label="Ảnh tải lên" path={config.customUrl} />
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-6 flex-1 gap-1 px-2 text-[10px]"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-3 w-3" />
              Tải ảnh logo (PNG nền trong suốt)
            </Button>
            {config.customUrl && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5"
                title="Bỏ ảnh tải lên"
                onClick={() => onChange({ customUrl: null })}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/svg+xml,image/webp,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so picking the same file twice still fires a change event.
              e.target.value = "";
              if (!file) return;
              const url = URL.createObjectURL(file);
              onCustomUpload(url);
              onChange({ customUrl: url });
            }}
          />

          {/* ── Style ─────────────────────────────────────────────────────── */}
          <div className="space-y-0.5">
            <Label className="text-[10px] text-muted-foreground">Kiểu</Label>
            <div className="flex gap-1">
              {(["solid", "neon"] as LogoBackdropStyle[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onChange({ style: s })}
                  className={`h-6 flex-1 cursor-pointer rounded border text-[10px] transition-colors ${
                    config.style === s
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border/50 text-muted-foreground hover:border-border"
                  }`}
                >
                  {s === "solid" ? "Màu phẳng" : "Neon"}
                </button>
              ))}
            </div>
          </div>

          <ColorRow
            label={isNeon ? "Màu lõi" : "Màu logo"}
            value={config.color}
            onChange={(v) => onChange({ color: v })}
          />

          {isNeon && (
            <>
              <ColorRow
                label="Màu ánh sáng neon"
                value={config.neonColor}
                onChange={(v) => onChange({ neonColor: v })}
              />
              <div className="grid grid-cols-5 gap-1">
                {NEON_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    title={p.label}
                    // Colour only — the tube shape stays exactly as dialled in.
                    onClick={() => onChange({ color: p.color, neonColor: p.neonColor })}
                    className="h-6 cursor-pointer rounded border border-border/50 transition-colors hover:border-border"
                    style={{
                      backgroundColor: p.neonColor,
                      boxShadow: `0 0 6px ${p.neonColor}`,
                    }}
                  />
                ))}
              </div>
              <Row
                label="Độ sáng neon"
                value={config.neonIntensity}
                onChange={(v) => onChange({ neonIntensity: v })}
              />
              <Row
                label="Độ toả sáng"
                value={config.neonGlowSize ?? 0.5}
                onChange={(v) => onChange({ neonGlowSize: v })}
              />
              <Row
                label="Độ dày lõi ống"
                value={config.neonCoreWidth ?? 0.5}
                onChange={(v) => onChange({ neonCoreWidth: v })}
              />
              <Row
                label="Lõi cháy trắng"
                value={config.neonCoreGlow ?? 0.65}
                onChange={(v) => onChange({ neonCoreGlow: v })}
              />
              <Row
                label="Hắt sáng lên tường"
                value={config.neonBloom ?? 0.5}
                onChange={(v) => onChange({ neonBloom: v })}
              />
              <Row
                label="Nhấp nháy"
                value={config.neonFlicker ?? 0}
                onChange={(v) => onChange({ neonFlicker: v })}
              />
              {/* Neon keeps its OWN softness. Sharing the solid style's blur turned every
                  tube into a smear the moment a soft flat logo had been dialled in. */}
              <Row
                label="Độ mờ ống neon"
                value={config.neonBlur ?? 0}
                onChange={(v) => onChange({ neonBlur: v })}
              />
            </>
          )}

          {/* ── Look ──────────────────────────────────────────────────────── */}
          {!isNeon && (
            <Row label="Độ mờ (blur)" value={config.blur} onChange={(v) => onChange({ blur: v })} />
          )}
          <Row label="Độ đậm" value={config.opacity} onChange={(v) => onChange({ opacity: v })} />

          {/* ── Placement ─────────────────────────────────────────────────── */}
          <Row
            label={
              config.frameRelative
                ? "Kích thước (tỷ lệ khung hình)"
                : "Kích thước (tỷ lệ so với tường)"
            }
            value={config.scale}
            min={0.1}
            max={2}
            onChange={(v) => onChange({ scale: v })}
          />
          <div className="grid grid-cols-2 gap-2">
            <Row
              label="Lệch ngang"
              value={config.offsetX}
              min={-1}
              max={1}
              onChange={(v) => onChange({ offsetX: v })}
            />
            <Row
              label="Lệch dọc"
              value={config.offsetY}
              min={-1}
              max={1}
              onChange={(v) => onChange({ offsetY: v })}
            />
          </div>
          <Row
            label="Xoay"
            value={config.rotation}
            min={-180}
            max={180}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={(v) => onChange({ rotation: v })}
          />

        </>
      )}
    </div>
  );
}
