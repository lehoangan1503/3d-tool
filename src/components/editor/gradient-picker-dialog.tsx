"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Search } from "lucide-react";
import type { ImageGradient } from "@/types/extractor";

interface UiGradient {
  name: string;
  colors: string[];
}

const GRADIENTS_URL =
  "https://raw.githubusercontent.com/ghosh/uiGradients/master/gradients.json";

let cachedGradients: UiGradient[] | null = null;

interface GradientPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (gradient: ImageGradient) => void;
  currentAngle: number;
}

export function GradientPickerDialog({
  open,
  onClose,
  onSelect,
  currentAngle,
}: GradientPickerDialogProps) {
  const [gradients, setGradients] = useState<UiGradient[]>(cachedGradients ?? []);
  const [loading, setLoading] = useState(!cachedGradients);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open || cachedGradients) return;
    let cancelled = false;
    setLoading(true);
    fetch(GRADIENTS_URL)
      .then((r) => r.json())
      .then((data: UiGradient[]) => {
        if (cancelled) return;
        cachedGradients = data;
        setGradients(data);
      })
      .catch(console.error)
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return gradients;
    const q = search.toLowerCase();
    return gradients.filter((g) => g.name.toLowerCase().includes(q));
  }, [gradients, search]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Choose Gradient</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search gradients…"
            className="pl-8 h-8 text-xs"
          />
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto grid grid-cols-3 gap-2 py-2">
            {filtered.map((g) => (
              <button
                key={g.name}
                type="button"
                className="group relative rounded-lg overflow-hidden border border-border/50 hover:border-primary/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => {
                  onSelect({ name: g.name, colors: g.colors, angle: currentAngle });
                  onClose();
                }}
              >
                <div
                  className="h-16 w-full"
                  style={{
                    background: `linear-gradient(${currentAngle}deg, ${g.colors.join(", ")})`,
                  }}
                />
                <span className="block px-1.5 py-1 text-[10px] text-muted-foreground truncate text-center">
                  {g.name}
                </span>
              </button>
            ))}
            {filtered.length === 0 && !loading && (
              <div className="col-span-3 text-center text-xs text-muted-foreground py-8">
                No gradients found
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
