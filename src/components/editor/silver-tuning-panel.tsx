"use client";

import { Label } from "@/components/ui/label";
import type { SilverGlobalConfig } from "@/lib/three/silver-coating";

interface SilverTuningPanelProps {
  /** Current global silver config values. */
  value: SilverGlobalConfig;
  /** Called with a partial patch whenever a control changes (live). */
  onChange: (patch: Partial<SilverGlobalConfig>) => void;
  /** Suffix to keep input ids unique between the mobile/desktop copies. */
  idSuffix?: string;
}

interface SliderDef {
  key: keyof SilverGlobalConfig;
  label: string;
  min: number;
  max: number;
  step: number;
}

// The ONLY three user-editable silver values (a single global config). All other
// material specs are hard-coded in silver-coating.ts.
const SLIDERS: SliderDef[] = [
  { key: "density", label: "Độ phủ bạc", min: 0, max: 100, step: 1 },
  { key: "metalness", label: "Metalness", min: 0, max: 1, step: 0.01 },
  { key: "normalScale", label: "Độ sâu hạt", min: 0, max: 2, step: 0.01 },
];

/**
 * The 3 global "Phủ bạc" controls (Độ phủ bạc / Metalness / Độ sâu hạt). One
 * config shared by every product; each change applies live to the 3D preview and
 * is saved to the DB by the parent. Everything else about the silver look is
 * fixed in code.
 */
export function SilverTuningPanel({ value, onChange, idSuffix = "" }: SilverTuningPanelProps) {
  return (
    <div className="mt-3 flex flex-col gap-4 border-l-2 border-muted pl-3">
      {SLIDERS.map((s) => (
        <div key={s.key} className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor={`silverCfg-${s.key}${idSuffix}`}>{s.label}</Label>
            <span className="text-xs text-muted-foreground">
              {Number(value[s.key]).toFixed(s.step < 1 ? 2 : 0)}
            </span>
          </div>
          <input
            id={`silverCfg-${s.key}${idSuffix}`}
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={value[s.key]}
            onChange={(e) => onChange({ [s.key]: parseFloat(e.target.value) })}
            className="w-full accent-primary"
          />
        </div>
      ))}
    </div>
  );
}
