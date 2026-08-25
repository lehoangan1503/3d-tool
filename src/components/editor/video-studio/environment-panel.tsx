"use client";

/**
 * Video Studio V2 — environment controls.
 *
 * Replaces V1's wall/table surface panel. Instead of styling two fake planes, this
 * picks the real space the cue sits in: a 360° HDRI panorama or a loaded GLB room,
 * plus the ground projection and contact-shadow settings that make the cue read as
 * genuinely standing in that space.
 */

import { useRef } from "react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Upload, Image as ImageIcon, Box, Trash2, RotateCcw } from "lucide-react";
import type {
  StudioEnvironmentConfig,
  StudioEnvironmentAsset,
  StudioEnvironmentMode,
} from "@/types/studio-environment";
import {
  BUILTIN_ENVIRONMENTS,
  ENVIRONMENT_ACCEPT,
  inferEnvironmentMode,
  DEFAULT_STUDIO_ENVIRONMENT,
} from "@/types/studio-environment";

interface EnvironmentPanelProps {
  config: StudioEnvironmentConfig;
  onChange: (patch: Partial<StudioEnvironmentConfig>) => void;
  /** Assets the user added this session (blob URLs), lifted so they survive re-renders. */
  userAssets: StudioEnvironmentAsset[];
  onAddUserAsset: (asset: StudioEnvironmentAsset) => void;
  onRemoveUserAsset: (id: string) => void;
  /** Message from the last failed environment load, surfaced under the picker. */
  loadError?: string | null;
}

/** A labelled slider row — the shape used throughout the studio panels. */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {value.toFixed(step < 1 ? 2 : 0)}
          {suffix ?? ""}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

export function EnvironmentPanel({
  config,
  onChange,
  userAssets,
  onAddUserAsset,
  onRemoveUserAsset,
  loadError,
}: EnvironmentPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allAssets: StudioEnvironmentAsset[] = [...BUILTIN_ENVIRONMENTS, ...userAssets];
  const selected = allAssets.find((a) => a.id === config.assetId);

  /** Select an asset — mode follows the asset, so the loader always matches the file. */
  const selectAsset = (asset: StudioEnvironmentAsset) => {
    onChange({ assetId: asset.id, assetUrl: asset.url, mode: asset.mode });
  };

  /**
   * Register a local file as an environment.
   *
   * Kept as an object URL rather than uploaded: HDRIs and room models are tens of
   * megabytes, and the studio only needs them for this editing session. A template
   * saved with a local asset falls back to the default panorama when reopened.
   */
  const handleFile = (file: File | undefined) => {
    if (!file) return;

    const mode: StudioEnvironmentMode = inferEnvironmentMode(file.name);
    const url = URL.createObjectURL(file);
    const asset: StudioEnvironmentAsset = {
      id: `user-${file.name}-${file.size}`,
      label: file.name.replace(/\.[^.]+$/, ""),
      mode,
      url,
      userProvided: true,
    };

    onAddUserAsset(asset);
    selectAsset(asset);
  };

  const resetEnvironment = () => {
    onChange({
      ...DEFAULT_STUDIO_ENVIRONMENT,
      groundProjection: { ...DEFAULT_STUDIO_ENVIRONMENT.groundProjection },
      shadowCatcher: { ...DEFAULT_STUDIO_ENVIRONMENT.shadowCatcher },
      roomTransform: { ...DEFAULT_STUDIO_ENVIRONMENT.roomTransform },
    });
  };

  const isGlb = config.mode === "glb";

  return (
    <div className="space-y-4">
      {/* ── Asset picker ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Không gian</Label>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] gap-1"
            onClick={resetEnvironment}
            title="Đặt lại không gian"
          >
            <RotateCcw className="h-3 w-3" />
            Đặt lại
          </Button>
        </div>

        <Select
          value={config.assetId}
          onValueChange={(id) => {
            const asset = allAssets.find((a) => a.id === id);
            if (asset) selectAsset(asset);
          }}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Chọn không gian…" />
          </SelectTrigger>
          <SelectContent>
            {allAssets.map((asset) => (
              <SelectItem key={asset.id} value={asset.id} className="text-xs">
                <span className="flex items-center gap-1.5">
                  {asset.mode === "glb" ? (
                    <Box className="h-3 w-3" />
                  ) : (
                    <ImageIcon className="h-3 w-3" />
                  )}
                  {asset.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Upload — HDRI panorama or GLB room from Poly Haven / Sketchfab etc. */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={`${ENVIRONMENT_ACCEPT.hdri},${ENVIRONMENT_ACCEPT.glb}`}
          onChange={(e) => {
            handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="w-full h-8 text-xs gap-1.5"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" />
          Tải HDRI / phòng 3D (.hdr .exr .glb)
        </Button>
        {loadError && (
          <p className="text-[11px] text-destructive">
            Không tải được không gian: {loadError}
          </p>
        )}

        {selected?.userProvided && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-7 text-[11px] gap-1.5 text-destructive hover:text-destructive"
            onClick={() => {
              onRemoveUserAsset(selected.id);
              selectAsset(BUILTIN_ENVIRONMENTS[0]);
            }}
          >
            <Trash2 className="h-3 w-3" />
            Xoá không gian đã tải
          </Button>
        )}
      </div>

      {/* ── Orientation and lighting ── */}
      <div className="space-y-3 pt-1 border-t border-border/50">
        <SliderRow
          label="Xoay không gian"
          value={config.rotationY}
          min={0}
          max={360}
          step={1}
          suffix="°"
          onChange={(v) => onChange({ rotationY: v })}
        />
        <SliderRow
          label="Cường độ sáng"
          value={config.intensity}
          min={0}
          max={3}
          step={0.05}
          onChange={(v) => onChange({ intensity: v })}
        />
        <SliderRow
          label="Độ sáng nền"
          value={config.backgroundIntensity}
          min={0}
          max={3}
          step={0.05}
          onChange={(v) => onChange({ backgroundIntensity: v })}
        />

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.showBackground}
            onChange={(e) => onChange({ showBackground: e.target.checked })}
            className="h-3.5 w-3.5 accent-primary"
          />
          <span className="text-xs">Hiện không gian làm nền</span>
        </label>

        {/* The cue normally keeps its own product-tuned HDRI; this opts into room light. */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.lightCueFromEnvironment}
            onChange={(e) => onChange({ lightCueFromEnvironment: e.target.checked })}
            className="h-3.5 w-3.5 accent-primary"
          />
          <span className="text-xs">Chiếu sáng cơ bằng không gian</span>
        </label>
      </div>

      {/* ── Ground projection (HDRI only) ── */}
      {!isGlb && (
        <div className="space-y-3 pt-3 border-t border-border/50">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.groundProjection.enabled}
              onChange={(e) =>
                onChange({
                  groundProjection: {
                    ...config.groundProjection,
                    enabled: e.target.checked,
                  },
                })
              }
              className="h-3.5 w-3.5 accent-primary"
            />
            <span className="text-xs">Chiếu nền xuống sàn (3D thật)</span>
          </label>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {config.groundProjection.enabled ? (
              <>
                Sàn có phối cảnh thật khi máy quay di chuyển, nhưng vì nền được
                chiếu lên một mặt cầu nên tường thẳng sẽ hơi cong. Tăng{" "}
                <span className="font-medium">bán kính sàn</span> để tường thẳng
                hơn, giảm để sàn có chiều sâu rõ hơn.
              </>
            ) : (
              <>
                Tường và đường thẳng giữ nguyên độ thẳng tuyệt đối, nhưng nền là
                vòm ở vô cực nên sàn không có chiều sâu khi máy quay di chuyển.
              </>
            )}
          </p>

          {config.groundProjection.enabled && (
            <>
              <SliderRow
                label="Chiều cao chân trời"
                value={config.groundProjection.height}
                min={1}
                max={40}
                step={0.5}
                onChange={(v) =>
                  onChange({
                    groundProjection: { ...config.groundProjection, height: v },
                  })
                }
              />
              <SliderRow
                label="Bán kính sàn (lớn = tường thẳng hơn)"
                value={config.groundProjection.radius}
                min={15}
                max={300}
                step={5}
                onChange={(v) =>
                  onChange({
                    groundProjection: { ...config.groundProjection, radius: v },
                  })
                }
              />
            </>
          )}
        </div>
      )}

      {/* ── GLB room placement ── */}
      {isGlb && (
        <div className="space-y-3 pt-3 border-t border-border/50">
          <Label className="text-xs font-medium">Vị trí phòng 3D</Label>
          <SliderRow
            label="Tỷ lệ"
            value={config.roomTransform.scale}
            min={0.01}
            max={20}
            step={0.01}
            onChange={(v) =>
              onChange({ roomTransform: { ...config.roomTransform, scale: v } })
            }
          />
          <SliderRow
            label="Vị trí X"
            value={config.roomTransform.positionX}
            min={-50}
            max={50}
            step={0.1}
            onChange={(v) =>
              onChange({ roomTransform: { ...config.roomTransform, positionX: v } })
            }
          />
          <SliderRow
            label="Vị trí Y"
            value={config.roomTransform.positionY}
            min={-50}
            max={50}
            step={0.1}
            onChange={(v) =>
              onChange({ roomTransform: { ...config.roomTransform, positionY: v } })
            }
          />
          <SliderRow
            label="Vị trí Z"
            value={config.roomTransform.positionZ}
            min={-50}
            max={50}
            step={0.1}
            onChange={(v) =>
              onChange({ roomTransform: { ...config.roomTransform, positionZ: v } })
            }
          />
          <SliderRow
            label="Xoay phòng"
            value={config.roomTransform.rotationY}
            min={0}
            max={360}
            step={1}
            suffix="°"
            onChange={(v) =>
              onChange({ roomTransform: { ...config.roomTransform, rotationY: v } })
            }
          />
        </div>
      )}

      {/* ── Contact shadow ── */}
      <div className="space-y-3 pt-3 border-t border-border/50">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.shadowCatcher.enabled}
            onChange={(e) =>
              onChange({
                shadowCatcher: {
                  ...config.shadowCatcher,
                  enabled: e.target.checked,
                },
              })
            }
            className="h-3.5 w-3.5 accent-primary"
          />
          <span className="text-xs">Bóng tiếp xúc (mặt phẳng vô hình)</span>
        </label>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Sàn trong ảnh 360° không có hình khối nên cơ sẽ bị &ldquo;lơ lửng&rdquo;.
          Mặt phẳng này chỉ hiện bóng, giúp cơ dính vào sàn hoặc mặt bàn.
        </p>

        {config.shadowCatcher.enabled && (
          <>
            <SliderRow
              label="Cao độ mặt nhận bóng"
              value={config.shadowCatcher.height}
              min={-20}
              max={20}
              step={0.1}
              onChange={(v) =>
                onChange({
                  shadowCatcher: { ...config.shadowCatcher, height: v },
                })
              }
            />
            <SliderRow
              label="Kích thước"
              value={config.shadowCatcher.size}
              min={5}
              max={200}
              step={1}
              onChange={(v) =>
                onChange({ shadowCatcher: { ...config.shadowCatcher, size: v } })
              }
            />
            <SliderRow
              label="Độ đậm bóng"
              value={config.shadowCatcher.opacity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) =>
                onChange({
                  shadowCatcher: { ...config.shadowCatcher, opacity: v },
                })
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
