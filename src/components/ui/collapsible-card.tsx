"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleCardProps {
  title: string;
  icon?: React.ReactNode;
  defaultExpanded?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function CollapsibleCard({
  title,
  icon,
  defaultExpanded = true,
  className,
  children,
}: CollapsibleCardProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);

  return (
    <div className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
      </button>
      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          expanded ? "max-h-[1000px] opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className="p-4 pt-0">{children}</div>
      </div>
    </div>
  );
}
