"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface NumberInputProps
  extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> {
  /** Current numeric value coming from state. */
  value: number;
  /** Called with the parsed number once the user commits (blur / Enter) or types a valid number. */
  onChange: (value: number) => void;
  /**
   * Value committed when the field is left empty or unparseable.
   * Defaults to 0.
   */
  fallback?: number;
  /** Optional clamp applied to the committed value. */
  min?: number;
  max?: number;
  /** Round the committed value to this many decimals. Omit to keep full precision. */
  decimals?: number;
}

const clampValue = (value: number, min?: number, max?: number): number => {
  let next = value;
  if (typeof min === "number") next = Math.max(min, next);
  if (typeof max === "number") next = Math.min(max, next);
  return next;
};

/** A partially-typed entry the user must be allowed to keep in the field. */
const isIntermediate = (raw: string): boolean =>
  raw === "" || raw === "-" || raw === "." || raw === "-." || /[.]$/.test(raw);

/**
 * Numeric text field that lets the user clear the box and type freely —
 * including a leading minus sign — instead of snapping back to a default on
 * every keystroke. The committed value is always a number, so callers keep
 * their existing `(n: number) => void` handlers unchanged.
 */
const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  (
    { value, onChange, fallback = 0, min, max, decimals, className, onBlur, onKeyDown, ...props },
    ref
  ) => {
    // While the user is typing we hold their raw text; null means "show the prop".
    const [draft, setDraft] = React.useState<string | null>(null);

    const format = React.useCallback(
      (n: number): string => {
        if (!Number.isFinite(n)) return "";
        return typeof decimals === "number" ? n.toFixed(decimals) : String(n);
      },
      [decimals]
    );

    const displayValue = draft !== null ? draft : format(value);

    const commit = (raw: string) => {
      setDraft(null);
      const parsed = parseFloat(raw);
      const next = clampValue(Number.isNaN(parsed) ? fallback : parsed, min, max);
      if (next !== value) onChange(next);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setDraft(raw);

      // Keep partial input (""/"-"/"1.") on screen without pushing it upstream.
      if (isIntermediate(raw)) return;

      const parsed = parseFloat(raw);
      if (Number.isNaN(parsed)) return;

      // Live-update only when the typed text is already within range, so the
      // user isn't fighting a clamp while typing (e.g. "5" on the way to "50").
      const clamped = clampValue(parsed, min, max);
      if (clamped === parsed && clamped !== value) onChange(clamped);
    };

    return (
      <Input
        {...props}
        ref={ref}
        type="text"
        inputMode="decimal"
        value={displayValue}
        onChange={handleChange}
        onBlur={(e) => {
          commit(e.target.value);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          onKeyDown?.(e);
        }}
        className={cn(className)}
      />
    );
  }
);
NumberInput.displayName = "NumberInput";

export { NumberInput };
