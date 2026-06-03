"use client";

import { memo, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { RotateCw, ImageIcon } from "lucide-react";
import type { ExtractorFrame } from "@/types/extractor";
import { isCueFrame, isImageFrame, imageGradientToCss } from "@/types/extractor";
import { resolveStorageUrl } from "@/lib/resolve-storage-url";

interface StaticFrameProps {
  frame: ExtractorFrame;
  screenshot: string | null;
  selected: boolean;
  onSelect: () => void;
  scale: number;
  onTransformStart: (e: React.MouseEvent, type: 'move' | 'resize' | 'rotate' | 'surface-pan', handle?: string) => void;
  previewMode?: boolean;
  /** Current product surface URL — previewed in dynamic-surface image frames. */
  productSurfaceUrl?: string | null;
  /** Wheel over a dynamic-surface frame → zoom the surface image. */
  onSurfaceWheel?: (deltaY: number) => void;
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
  productSurfaceUrl,
  onSurfaceWheel,
}: StaticFrameProps) {
  const isDynamicSurface = isImageFrame(frame) && (frame.imageSettings.dynamicSurface ?? false);

  // Surface-zoom wheel must use a NATIVE non-passive listener. React's onWheel is
  // registered as passive, so calling preventDefault() inside it is ignored and
  // logs "Unable to preventDefault inside passive event listener invocation".
  const surfaceWheelElRef = useRef<HTMLDivElement>(null);
  const onSurfaceWheelRef = useRef(onSurfaceWheel);
  useEffect(() => { onSurfaceWheelRef.current = onSurfaceWheel; }, [onSurfaceWheel]);
  const surfaceWheelActive = selected && !previewMode && isDynamicSurface;
  useEffect(() => {
    const el = surfaceWheelElRef.current;
    if (!el || !surfaceWheelActive) return;
    const handler = (e: WheelEvent) => {
      const cb = onSurfaceWheelRef.current;
      if (!cb) return;
      e.preventDefault();
      e.stopPropagation();
      cb(e.deltaY);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [surfaceWheelActive]);

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
              alt={`Khung ${frame.order + 1}`}
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
                  ...(frame.imageSettings.backgroundType === "gradient" && frame.imageSettings.backgroundGradient
                    ? { background: imageGradientToCss(frame.imageSettings.backgroundGradient) }
                    : { backgroundColor: frame.imageSettings.backgroundColor }),
                  opacity: frame.imageSettings.backgroundOpacity ?? 1,
                }}
              />
            )}
            {/* Image content layer — dynamic-surface frames preview the product
                surface with the same cover + pan/zoom as the canvas renderer. */}
            {(() => {
              const dyn = frame.imageSettings.dynamicSurface;
              const previewUrl = dyn ? productSurfaceUrl ?? null : frame.imageSettings.imageUrl;
              if (!previewUrl) return null;
              const opacity = frame.imageSettings.imageOpacity ?? frame.imageSettings.opacity ?? 1;
              const mixBlendMode = frame.imageSettings.blendMode as React.CSSProperties['mixBlendMode'];
              if (dyn) {
                // When this surface frame is NOT being edited (not selected, not in
                // preview mode), show a lightweight CAPTURED snapshot of its final
                // position instead of the live full-res surface — the heavy <img> is
                // unmounted, freeing memory and stopping the lag. The snapshot is
                // produced on deselect by FrameCanvas (captureSurfaceFrameSnapshot).
                if (!selected && !previewMode && screenshot) {
                  return (
                    <img
                      src={screenshot}
                      alt={`Surface Khung ${frame.order + 1}`}
                      draggable={false}
                      className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                    />
                  );
                }
                // Dynamic-surface preview = a plain <img> with a CSS transform for
                // pan/zoom — lightweight (browser decodes at display size, not the
                // full source). DEFAULT (scale=1, x=0, y=0): image WIDTH == frame
                // width and image BOTTOM aligned to frame bottom. We achieve that
                // with width:100% / height:auto (fit by width, keep ratio), anchored
                // to the bottom, then translate(% of frame)+scale on top.
                // drawSurfaceWithPan reproduces this exact math at export time.
                const pan = frame.imageSettings.surfacePan ?? { x: 0, y: 0, scale: 1 };
                const resolved = resolveStorageUrl(previewUrl);
                if (!resolved) return null;
                // Outer wrapper == frame size, so translate(%) is a fraction of the
                // FRAME (matches drawSurfaceWithPan's pan.x*destW / pan.y*destH).
                // Inner <img> fits by WIDTH (width:100%, height:auto) anchored to the
                // bottom, so scale=1 → width==frame, bottom==frame bottom.
                return (
                  <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                      transform: `translate(${pan.x * 100}%, ${pan.y * 100}%) scale(${Math.max(0.1, pan.scale)})`,
                      transformOrigin: "center bottom",
                    }}
                  >
                    <img
                      src={resolved}
                      alt={`Surface Khung ${frame.order + 1}`}
                      draggable={false}
                      style={{
                        position: "absolute",
                        left: 0,
                        bottom: 0,
                        width: "100%",
                        height: "auto",
                        opacity,
                        mixBlendMode,
                      }}
                    />
                  </div>
                );
              }
              return (
                <img
                  src={resolveStorageUrl(previewUrl)!}
                  alt={`Ảnh Khung ${frame.order + 1}`}
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  style={{
                    objectFit: frame.imageSettings.objectFit as React.CSSProperties['objectFit'],
                    opacity,
                    mixBlendMode,
                  }}
                  draggable={false}
                />
              );
            })()}
          </div>
        ) : (
          <div className="w-full h-full bg-muted/50 flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-muted-foreground/50" />
          </div>
        )}
      </div>

      {/* Dynamic surface: drag to pan the surface image inside the fixed frame,
          wheel to zoom. The frame itself is locked (no move/resize/rotate). */}
      {selected && !previewMode && isDynamicSurface && (
        <div
          ref={surfaceWheelElRef}
          className="absolute inset-0 cursor-move"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTransformStart(e, 'surface-pan');
          }}
        />
      )}

      {/* Move handle (whole frame) - only when selected and not in preview mode */}
      {selected && !previewMode && !isDynamicSurface && (
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
      {selected && !previewMode && !isDynamicSurface && handles.map((h) => (
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
      {selected && !previewMode && !isDynamicSurface && (
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
          {isCueFrame(frame) ? `${frame.cue.zoom.toFixed(1)}x` : isImageFrame(frame) && frame.imageSettings.dynamicSurface ? 'Surface' : 'Ảnh'}
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
  prev.previewMode === next.previewMode &&
  prev.productSurfaceUrl === next.productSurfaceUrl
);
