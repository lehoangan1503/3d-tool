"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Copies a row's UUID to the clipboard.
 *
 * Exists for the render API. An agent is told to name its targets ("render
 * nhóm NOVERA-D"), and names are all it ever needs — until two rows share one.
 * The API refuses an ambiguous name on purpose rather than picking a row, and
 * its 400 lists the candidate ids; but the operator still has to work out
 * WHICH of those ids is the layout they meant, and only this screen shows the
 * thumbnail next to it.
 *
 * So: the id lives on the card, next to the picture of the thing it names.
 * When `meo` appears four times, the operator copies the id off the right one
 * and hands that to the agent instead of the name.
 *
 * Shown as the last 4 characters rather than the full UUID — enough to tell
 * two cards apart at a glance, and it fits a card footer. The full value is in
 * the tooltip and, of course, on the clipboard.
 */

interface CopyIdButtonProps {
  id: string;
  /**
   * What kind of thing this is, for the tooltip ("Copy id nhóm"). Optional
   * because on a product card there is nothing else it could be.
   */
  label?: string;
  className?: string;
}

export function CopyIdButton({ id, label, className }: CopyIdButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy(event: React.MouseEvent | React.KeyboardEvent) {
    // Cards are frequently links or buttons themselves — copying an id must
    // not also navigate into the editor or open a dialog.
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Blocked outside a secure context. The title attribute still carries
      // the full id, so it can be read and selected manually.
    }
  }

  /**
   * A span, not a button — deliberately.
   *
   * The reference-group card is itself a <button> (the whole tile opens the
   * group editor), and a button inside a button is invalid HTML that React
   * flags as a hydration error. The card's own delete control already solves
   * this the same way, so this matches it: ARIA role plus a keyboard handler
   * give it the semantics a <button> would have contributed anyway.
   */
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={copy}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") copy(event);
      }}
      title={copied ? "Đã copy!" : `${label ? `Copy id ${label}` : "Copy id"}: ${id}`}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors cursor-pointer shrink-0 ${
        className ?? ""
      }`}
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      {/* Last 4 of the UUID: two cards with the same name still differ here,
          which is the case this button exists for. */}
      <span>…{id.slice(-4)}</span>
    </span>
  );
}
