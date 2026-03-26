"use client";

import { cn } from "@/lib/utils";
import { RotateCw, ImageIcon } from "lucide-react";
import type { ExtractorFrame } from "@/types/extractor";

interface StaticFrameProps {
  frame: ExtractorFrame;
  screenshot: string | null;
  selected: boolean;
  onSelect: () => void;
  scale: number;
  onTransformStart: (e: React.MouseEvent, type: 'move' | 'resize' | 'rotate', handle?: string) => void;
}

type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export function StaticFrame({
  frame,
  screenshot,
  selected,
  onSelect,
  scale,
  onTransformStart,
}: StaticFrameProps) {
  const handles: HandleType[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const handlePositions: Record<string, { top?: string; left?: string; right?: string; bottom?: string; cursor: string }> = {
    nw: { top: '-4px', left: '-4px', cursor: 'nw-resize' },
    n: { top: '-4px', left: '50%', cursor: 'n-resize' },
    ne: { top: '-4px', right: '-4px', cursor: 'ne-resize' },
    e: { top: '50%', right: '-4px', cursor: 'e-resize' },
    se: { bottom: '-4px', right: '-4px', cursor: 'se-resize' },
    s: { bottom: '-4px', left: '50%', cursor: 's-resize' },
    sw: { bottom: '-4px', left: '-4px', cursor: 'sw-resize' },
    w: { top: '50%', left: '-4px', cursor: 'w-resize' },
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect();
  };

  return (
    <div
      className={cn(
        "absolute",
        selected ? "z-10" : "z-0"
      )}
      style={{
        left: frame.transform.x * scale,
        top: frame.transform.y * scale,
        width: frame.transform.width * scale,
        height: frame.transform.height * scale,
        transform: `rotate(${frame.transform.rotation}deg)`,
        transformOrigin: 'center center',
      }}
      onMouseDown={handleMouseDown}
    >
      {/* Frame content */}
      <div
        className={cn(
          "absolute inset-0 overflow-hidden rounded",
          "border-2 transition-colors",
          selected ? "border-primary" : "border-muted-foreground/30 hover:border-muted-foreground/50"
        )}
      >
        {screenshot ? (
          <img
            src={screenshot}
            alt={`Frame ${frame.order + 1}`}
            className="w-full h-full object-cover pointer-events-none"
            draggable={false}
          />
        ) : (
          <div className="w-full h-full bg-muted/50 flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-muted-foreground/50" />
          </div>
        )}
      </div>

      {/* Move handle (whole frame) - only when selected */}
      {selected && (
        <div
          className="absolute inset-0 cursor-move"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTransformStart(e, 'move');
          }}
        />
      )}

      {/* Resize handles */}
      {selected && handles.map((h) => (
        <div
          key={h}
          className="absolute w-3 h-3 bg-primary rounded-sm border border-background"
          style={{
            ...handlePositions[h],
            cursor: handlePositions[h].cursor,
            transform: h === 'n' || h === 's' ? 'translateX(-50%)' : h === 'e' || h === 'w' ? 'translateY(-50%)' : undefined,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTransformStart(e, 'resize', h);
          }}
        />
      ))}

      {/* Rotation handles */}
      {selected && (
        <>
          <div
            className="absolute -top-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-primary rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onTransformStart(e, 'rotate');
            }}
          >
            <RotateCw className="w-3 h-3 text-primary-foreground" />
          </div>
          <div
            className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-primary rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onTransformStart(e, 'rotate');
            }}
          >
            <RotateCw className="w-3 h-3 text-primary-foreground" />
          </div>
        </>
      )}

      {/* Frame label */}
      <div className="absolute bottom-1 left-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded pointer-events-none">
        {frame.cue.zoom.toFixed(1)}x
      </div>
    </div>
  );
}
