"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { setUserMode } from "./actions";

interface ModeToggleProps {
  userId: string;
  enabled: boolean;
}

export function ModeToggle({ userId, enabled }: ModeToggleProps) {
  const [isMode, setIsMode] = useState(enabled);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !isMode;
    setError(null);
    startTransition(async () => {
      try {
        const result = await setUserMode(userId, next);
        if (result?.error) {
          // Do NOT flip — surface the real reason.
          setError(result.error);
          return;
        }
        setIsMode(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Lỗi không xác định");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={isMode ? "secondary" : "outline"}
          disabled={pending}
          onClick={toggle}
          className="gap-1.5"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isMode ? (
            <ShieldOff className="h-3.5 w-3.5" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          {isMode ? "Thu hồi Mode" : "Cấp quyền Mode"}
        </Button>
        {isMode && <span className="text-xs font-medium text-green-500">Mode</span>}
      </div>
      {error && (
        <span className="text-xs text-destructive max-w-[260px] break-words">{error}</span>
      )}
    </div>
  );
}
