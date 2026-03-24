"use client";

import { useRef, useEffect, useCallback } from "react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import type { FramePosition, FrameKey } from "@/types/extractor";
import { FRAME_LABELS } from "@/types/extractor";
import { cn } from "@/lib/utils";

interface InteractiveFrameProps {
  frameKey: FrameKey;
  position: FramePosition;
  onPositionChange: (position: FramePosition) => void;
  sceneManager: SceneManager | null;
  selected: boolean;
  onSelect: () => void;
  size: number; // Frame size in pixels (e.g., 300)
}

export function InteractiveFrame({
  frameKey,
  position,
  onPositionChange,
  sceneManager,
  selected,
  onSelect,
  size,
}: InteractiveFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const extractorRef = useRef<ExtractorSceneManager | null>(null);
  const isDraggingRef = useRef(false);
  const dragTypeRef = useRef<'orbit' | 'pan' | null>(null);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  // Apply position to extractor
  const applyPosition = useCallback((pos: FramePosition) => {
    if (!extractorRef.current) return;
    
    // Different targetY based on frame type
    const targetY = frameKey === 'bottomBump' ? -1 : frameKey === 'topCap' ? 1 : 0;
    
    extractorRef.current.setCameraOrbit(pos.cameraOrbitX, pos.cameraOrbitY, pos.cameraDistance, targetY);
    extractorRef.current.setCameraZoom(pos.zoom);
    extractorRef.current.setModelOffset(pos.modelOffsetX, pos.modelOffsetY);
    extractorRef.current.setDirectionalLight(pos.lightAngle);
  }, [frameKey]);

  // Initialize extractor
  useEffect(() => {
    if (!sceneManager) return;

    const extractor = new ExtractorSceneManager(size, size);
    extractorRef.current = extractor;

    // Clone model
    const model = sceneManager.getModelForClone();
    if (model) {
      extractor.setModel(model);
    }

    // Load HDRI
    const hdriUrl = sceneManager.getCurrentHdriUrl();
    extractor.loadHDRI(hdriUrl);

    // Enable transparency
    extractor.setTransparentBackground(true);

    // Mount canvas
    if (containerRef.current) {
      const canvas = extractor.getCanvas();
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(canvas);
    }

    // Apply initial position
    applyPosition(position);

    return () => {
      if (extractorRef.current) {
        extractorRef.current.dispose();
        extractorRef.current = null;
      }
    };
  }, [sceneManager, size, applyPosition, position]);

  // Update when position changes
  useEffect(() => {
    applyPosition(position);
  }, [position, applyPosition]);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onSelect();
    isDraggingRef.current = true;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
    
    // Left button = orbit, Right button = pan model
    dragTypeRef.current = e.button === 2 ? 'pan' : 'orbit';
  }, [onSelect]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;

    const deltaX = e.clientX - lastMouseRef.current.x;
    const deltaY = e.clientY - lastMouseRef.current.y;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };

    if (dragTypeRef.current === 'orbit') {
      // Left-drag: orbit camera
      const sensitivity = 0.01;
      onPositionChange({
        ...position,
        cameraOrbitX: position.cameraOrbitX + deltaX * sensitivity,
        cameraOrbitY: Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, position.cameraOrbitY - deltaY * sensitivity)),
      });
    } else if (dragTypeRef.current === 'pan') {
      // Right-drag: move model
      const sensitivity = 0.005;
      onPositionChange({
        ...position,
        modelOffsetX: position.modelOffsetX + deltaX * sensitivity,
        modelOffsetY: position.modelOffsetY - deltaY * sensitivity,
      });
    }
  }, [position, onPositionChange]);

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    dragTypeRef.current = null;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const zoomDelta = e.deltaY > 0 ? -0.1 : 0.1;
    const newZoom = Math.max(0.5, Math.min(5, position.zoom + zoomDelta));
    onPositionChange({ ...position, zoom: newZoom });
  }, [position, onPositionChange]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); // Prevent right-click menu
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative bg-transparent rounded-lg overflow-hidden cursor-grab active:cursor-grabbing",
        "border-2 transition-all duration-200",
        selected ? "border-primary ring-2 ring-primary/50" : "border-muted hover:border-muted-foreground/50"
      )}
      style={{ width: size, height: size }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={handleContextMenu}
      onClick={onSelect}
    >
      {/* Zoom indicator */}
      <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded">
        {position.zoom.toFixed(1)}x
      </div>
      
      {/* Frame label */}
      <div className="absolute top-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded">
        {FRAME_LABELS[frameKey]}
      </div>
    </div>
  );
}
