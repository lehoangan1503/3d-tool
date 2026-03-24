"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import type { ExtractorFrame } from "@/types/extractor";
import { cn } from "@/lib/utils";
import { RotateCw } from "lucide-react";

interface DraggableFrameProps {
  frame: ExtractorFrame;
  onFrameChange: (frame: ExtractorFrame) => void;
  sceneManager: SceneManager | null;
  selected: boolean;
  onSelect: () => void;
  scale: number; // Canvas scale factor (e.g., 0.3 for 600px display of 2048)
}

type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export function DraggableFrame({
  frame,
  onFrameChange,
  sceneManager,
  selected,
  onSelect,
  scale,
}: DraggableFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState<'move' | 'resize' | 'rotate' | 'cue-orbit' | 'cue-pan' | null>(null);
  const [activeHandle, setActiveHandle] = useState<HandleType | null>(null);
  const dragStartRef = useRef({ x: 0, y: 0, frameX: 0, frameY: 0, frameW: 0, frameH: 0, frameR: 0, cueOrbitX: 0, cueOrbitY: 0, cueOffsetX: 0, cueOffsetY: 0 });

  // Initialize extractor
  useEffect(() => {
    if (!sceneManager) return;

    const extractor = new ExtractorSceneManager(
      Math.round(frame.transform.width),
      Math.round(frame.transform.height)
    );
    extractorRef.current = extractor;

    const model = sceneManager.getModelForClone();
    if (model) extractor.setModel(model);

    const hdriUrl = sceneManager.getCurrentHdriUrl();
    extractor.loadHDRI(hdriUrl);
    extractor.setTransparentBackground(true);

    if (containerRef.current) {
      const canvas = extractor.getCanvas();
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none'; // Let parent handle events
      containerRef.current.appendChild(canvas);
    }

    return () => {
      if (extractorRef.current) {
        extractorRef.current.dispose();
        extractorRef.current = null;
      }
    };
  }, [sceneManager]);

  // Update extractor when frame changes
  useEffect(() => {
    if (!extractorRef.current) return;
    
    extractorRef.current.resize(
      Math.round(frame.transform.width),
      Math.round(frame.transform.height)
    );
    extractorRef.current.setCameraOrbit(frame.cue.orbitX, frame.cue.orbitY, 2, 0);
    extractorRef.current.setCameraZoom(frame.cue.zoom);
    extractorRef.current.setModelOffset(frame.cue.offsetX, frame.cue.offsetY);
    extractorRef.current.setDirectionalLight(frame.cue.lightAngle);
  }, [frame]);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent, type: 'move' | 'cue', handle?: HandleType) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      frameX: frame.transform.x,
      frameY: frame.transform.y,
      frameW: frame.transform.width,
      frameH: frame.transform.height,
      frameR: frame.transform.rotation,
      cueOrbitX: frame.cue.orbitX,
      cueOrbitY: frame.cue.orbitY,
      cueOffsetX: frame.cue.offsetX,
      cueOffsetY: frame.cue.offsetY,
    };

    if (handle === 'rotate') {
      setDragType('rotate');
      setActiveHandle('rotate');
    } else if (handle) {
      setDragType('resize');
      setActiveHandle(handle);
    } else if (type === 'cue') {
      setDragType(e.button === 2 ? 'cue-pan' : 'cue-orbit');
    } else {
      setDragType('move');
    }
  }, [frame, onSelect]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !dragType) return;

    const dx = (e.clientX - dragStartRef.current.x) / scale;
    const dy = (e.clientY - dragStartRef.current.y) / scale;

    if (dragType === 'move') {
      onFrameChange({
        ...frame,
        transform: {
          ...frame.transform,
          x: dragStartRef.current.frameX + dx,
          y: dragStartRef.current.frameY + dy,
        },
      });
    } else if (dragType === 'rotate') {
      // Calculate rotation based on mouse position relative to frame center
      const centerX = dragStartRef.current.frameX + dragStartRef.current.frameW / 2;
      const centerY = dragStartRef.current.frameY + dragStartRef.current.frameH / 2;
      const startAngle = Math.atan2(
        dragStartRef.current.y / scale - centerY,
        dragStartRef.current.x / scale - centerX
      );
      const currentAngle = Math.atan2(
        e.clientY / scale - centerY,
        e.clientX / scale - centerX
      );
      const deltaAngle = (currentAngle - startAngle) * (180 / Math.PI);
      
      onFrameChange({
        ...frame,
        transform: {
          ...frame.transform,
          rotation: dragStartRef.current.frameR + deltaAngle,
        },
      });
    } else if (dragType === 'resize' && activeHandle) {
      let newX = dragStartRef.current.frameX;
      let newY = dragStartRef.current.frameY;
      let newW = dragStartRef.current.frameW;
      let newH = dragStartRef.current.frameH;

      // Resize based on handle
      if (activeHandle.includes('w')) { newX += dx; newW -= dx; }
      if (activeHandle.includes('e')) { newW += dx; }
      if (activeHandle.includes('n')) { newY += dy; newH -= dy; }
      if (activeHandle.includes('s')) { newH += dy; }

      // Minimum size
      newW = Math.max(100, newW);
      newH = Math.max(100, newH);

      onFrameChange({
        ...frame,
        transform: { ...frame.transform, x: newX, y: newY, width: newW, height: newH },
      });
    } else if (dragType === 'cue-orbit') {
      const sensitivity = 0.01;
      onFrameChange({
        ...frame,
        cue: {
          ...frame.cue,
          orbitX: dragStartRef.current.cueOrbitX + dx * sensitivity,
          orbitY: Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, dragStartRef.current.cueOrbitY - dy * sensitivity)),
        },
      });
    } else if (dragType === 'cue-pan') {
      const sensitivity = 0.005;
      onFrameChange({
        ...frame,
        cue: {
          ...frame.cue,
          offsetX: dragStartRef.current.cueOffsetX + dx * sensitivity,
          offsetY: dragStartRef.current.cueOffsetY - dy * sensitivity,
        },
      });
    }
  }, [isDragging, dragType, activeHandle, frame, onFrameChange, scale]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragType(null);
    setActiveHandle(null);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const zoomDelta = e.deltaY > 0 ? -0.1 : 0.1;
    onFrameChange({
      ...frame,
      cue: { ...frame.cue, zoom: Math.max(0.5, Math.min(5, frame.cue.zoom + zoomDelta)) },
    });
  }, [frame, onFrameChange]);

  // Global mouse events
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const handles: HandleType[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const handlePositions: Record<HandleType, { top?: string; left?: string; right?: string; bottom?: string; cursor: string }> = {
    nw: { top: '-4px', left: '-4px', cursor: 'nw-resize' },
    n: { top: '-4px', left: '50%', cursor: 'n-resize' },
    ne: { top: '-4px', right: '-4px', cursor: 'ne-resize' },
    e: { top: '50%', right: '-4px', cursor: 'e-resize' },
    se: { bottom: '-4px', right: '-4px', cursor: 'se-resize' },
    s: { bottom: '-4px', left: '50%', cursor: 's-resize' },
    sw: { bottom: '-4px', left: '-4px', cursor: 'sw-resize' },
    w: { top: '50%', left: '-4px', cursor: 'w-resize' },
    rotate: { top: '-30px', left: '50%', cursor: 'grab' },
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
    >
      {/* Frame border */}
      <div
        ref={containerRef}
        className={cn(
          "absolute inset-0 overflow-hidden rounded",
          "border-2 transition-colors",
          selected ? "border-primary" : "border-muted-foreground/30 hover:border-muted-foreground/50"
        )}
        onMouseDown={(e) => handleMouseDown(e, 'cue')}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Move handle (whole frame) */}
      <div
        className="absolute inset-0 cursor-move"
        onMouseDown={(e) => handleMouseDown(e, 'move')}
        style={{ pointerEvents: selected ? 'auto' : 'none' }}
      />

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
          onMouseDown={(e) => handleMouseDown(e, 'move', h)}
        />
      ))}

      {/* Rotation handle */}
      {selected && (
        <div
          className="absolute -top-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-primary rounded-full flex items-center justify-center cursor-grab"
          onMouseDown={(e) => handleMouseDown(e, 'move', 'rotate')}
        >
          <RotateCw className="w-3 h-3 text-primary-foreground" />
        </div>
      )}

      {/* Frame label */}
      <div className="absolute bottom-1 left-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
        {frame.cue.zoom.toFixed(1)}x
      </div>
    </div>
  );
}
