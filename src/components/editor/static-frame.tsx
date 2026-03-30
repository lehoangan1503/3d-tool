"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";
import { RotateCw, ImageIcon } from "lucide-react";
import type { ExtractorFrame } from "@/types/extractor";
import { isCueFrame, isImageFrame } from "@/types/extractor";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";

interface StaticFrameProps {
  frame: ExtractorFrame;
  screenshot: string | null;
  selected: boolean;
  onSelect: () => void;
  scale: number;
  onTransformStart: (e: React.MouseEvent, type: 'move' | 'resize' | 'rotate', handle?: string) => void;
  previewMode?: boolean;
}

type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export function StaticFrameInner({
  frame,
  screenshot,
  selected,
  onSelect,
  scale,
  onTransformStart,
  previewMode = false,
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
      data-frame-id={frame.id}
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
          !previewMode && "border-2 transition-colors",
          !previewMode && (selected ? "border-primary" : "border-muted-foreground/30 hover:border-muted-foreground/50")
        )}
      >
        {isCueFrame(frame) ? (
          /* CUE frame: show screenshot or placeholder */
          screenshot ? (
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
          )
        ) : isImageFrame(frame) ? (
          /* IMAGE frame: background layer + image layer, independently controlled */
          <div className="w-full h-full relative overflow-hidden">
            {/* Background fill layer */}
            {(frame.imageSettings.backgroundEnabled ?? true) && (
              <div
                className="absolute inset-0"
                style={{
                  backgroundColor: frame.imageSettings.backgroundColor,
                  opacity: frame.imageSettings.backgroundOpacity ?? 1,
                }}
              />
            )}
            {/* Image content layer */}
            {frame.imageSettings.imageUrl ? (
              <img
                src={resolveStorageUrl(frame.imageSettings.imageUrl)!}
                alt={`Image Frame ${frame.order + 1}`}
                className="absolute inset-0 w-full h-full pointer-events-none"
                style={{
                  objectFit: frame.imageSettings.objectFit as React.CSSProperties['objectFit'],
                  opacity: frame.imageSettings.imageOpacity ?? frame.imageSettings.opacity ?? 1,
                  mixBlendMode: frame.imageSettings.blendMode as React.CSSProperties['mixBlendMode'],
                }}
                draggable={false}
              />
            ) : null}
          </div>
        ) : (
          <div className="w-full h-full bg-muted/50 flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-muted-foreground/50" />
          </div>
        )}
      </div>

      {/* Move handle (whole frame) - only when selected and not in preview mode */}
      {selected && !previewMode && (
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
      {selected && !previewMode && handles.map((h) => (
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
      {selected && !previewMode && (
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
      {!previewMode && (
        <div className="absolute bottom-1 left-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded pointer-events-none">
          {isCueFrame(frame) ? `${frame.cue.zoom.toFixed(1)}x` : 'Image'}
        </div>
      )}
    </div>
  );
}

/**
 * Memoized StaticFrame — only re-renders when frame data, screenshot, selection state,
 * or scale actually changes. Callback identity is intentionally excluded from the
 * comparator because FrameCanvas creates inline arrow functions in .map() on every render;
 * those callbacks always have stable behaviour even when their reference is new.
 */
export const StaticFrame = memo(StaticFrameInner, (prev, next) =>
  prev.frame === next.frame &&
  prev.screenshot === next.screenshot &&
  prev.selected === next.selected &&
  prev.scale === next.scale &&
  prev.previewMode === next.previewMode
);
