"use client";

import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import type { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import type { ExtractorFrame, HdriLayer, CueFrame, CueShadowConfig } from "@/types/extractor";
import { isCueFrame, isImageFrame, STUDIO_WHITE_HDRI, DEFAULT_CUE_SHADOW } from "@/types/extractor";
import type { CueHdriConfig } from "@/types/video-studio";
import { DEFAULT_CUE_HDRI } from "@/types/video-studio";
import { StaticFrame } from "./static-frame";
import { cn } from "@/lib/utils";
import { RotateCw } from "lucide-react";

/** Convert HdriLayer[] to CueHdriConfig for setCueHdri() */
function hdriLayersToCueHdri(layers: HdriLayer[]): CueHdriConfig {
  const primary = layers.find(l => l.enabled && l.hdriType !== STUDIO_WHITE_HDRI);
  if (primary) {
    return {
      hdriType: primary.hdriType,
      rotationX: primary.rotationX,
      rotationY: primary.rotationY,
      intensity: primary.intensity,
    };
  }
  return { ...DEFAULT_CUE_HDRI };
}

interface FrameCanvasProps {
  frames: ExtractorFrame[];
  selectedFrameId: string | null;
  hiddenFrameIds?: Set<string>;
  onSelectFrame: (id: string | null) => void;
  onFrameChange: (frame: ExtractorFrame) => void;
  sceneManager: SceneManager | null;
  frameScreenshots: Record<string, string>;
  onScreenshotCapture: (frameId: string, dataUrl: string) => void;
  extractorRef: React.MutableRefObject<ExtractorSceneManager | null>;
  extractorReady: boolean;
  /** Called once when the user finishes a drag/transform — commit to undo history. */
  onDragEnd?: () => void;
  /** When true, hides all frame borders, handles, labels, and canvas UI chrome. */
  previewMode?: boolean;
}

const CANVAS_SIZE = 2048;
const DISPLAY_SIZE = 600;

export function FrameCanvas({
  frames,
  selectedFrameId,
  hiddenFrameIds,
  onSelectFrame,
  onFrameChange,
  sceneManager,
  frameScreenshots,
  onScreenshotCapture,
  extractorRef,
  extractorReady,
  onDragEnd,
  previewMode = false,
}: FrameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeCanvasContainerRef = useRef<HTMLDivElement>(null);
  const canvasAttachedRef = useRef(false);
  const previousSelectedIdRef = useRef<string | null>(null);
  const wasDraggingRef = useRef(false);
  
  // Canvas zoom/pan state (Z + scroll to zoom, Z + drag to pan)
  const [canvasView, setCanvasView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const zKeyDownRef = useRef(false);
  const [zKeyDown, setZKeyDown] = useState(false);
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const wasPanningRef = useRef(false);

  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState<'move' | 'resize' | 'rotate' | 'cue-3d' | 'cue-pan' | null>(null);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [axisConstraint, setAxisConstraint] = useState<'x' | 'y' | null>(null);
  const dragStartRef = useRef({
    x: 0, y: 0,
    frameX: 0, frameY: 0, frameW: 0, frameH: 0, frameR: 0,
    centerX: 0, centerY: 0, startAngle: 0,
    cueSpinY: 0, cuePhi: 0, cueOffsetX: 0, cueOffsetY: 0,
    frameId: '',
  });
  
  // Track pressed keys for axis constraint (X or Y)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'x' && !axisConstraint) {
        setAxisConstraint('x');
      } else if (e.key.toLowerCase() === 'y' && !axisConstraint) {
        setAxisConstraint('y');
      }
      if (e.key.toLowerCase() === 'z' && !e.repeat) {
        zKeyDownRef.current = true;
        setZKeyDown(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'x' && axisConstraint === 'x') {
        setAxisConstraint(null);
      } else if (e.key.toLowerCase() === 'y' && axisConstraint === 'y') {
        setAxisConstraint(null);
      }
      if (e.key.toLowerCase() === 'z') {
        zKeyDownRef.current = false;
        setZKeyDown(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [axisConstraint]);
  
  const renderScale = DISPLAY_SIZE / CANVAS_SIZE;
  const interactionScale = renderScale * canvasView.zoom;
  const selectedFrame = frames.find(f => f.id === selectedFrameId && isCueFrame(f)) as CueFrame | undefined;

  // Z + scroll → zoom the canvas viewport (native handler to allow preventDefault on wheel)
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const handler = (e: WheelEvent) => {
      if (!zKeyDownRef.current) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = wrapper.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;

      setCanvasView(prev => {
        const newZoom = Math.max(0.25, Math.min(8, prev.zoom * zoomFactor));
        const ratio = newZoom / prev.zoom;
        return {
          zoom: newZoom,
          panX: mx * (1 - ratio) + prev.panX * ratio,
          panY: my * (1 - ratio) + prev.panY * ratio,
        };
      });
    };

    wrapper.addEventListener('wheel', handler, { passive: false });
    return () => wrapper.removeEventListener('wheel', handler);
  }, []);

  // Z + drag on background → pan the canvas
  const handleCanvasPanStart = useCallback((e: React.MouseEvent) => {
    if (!zKeyDownRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: canvasView.panX,
      panY: canvasView.panY,
    };
    setIsCanvasPanning(true);
  }, [canvasView.panX, canvasView.panY]);

  useEffect(() => {
    if (!isCanvasPanning) return;
    const handlePanMove = (e: MouseEvent) => {
      setCanvasView(prev => ({
        ...prev,
        panX: panStartRef.current.panX + (e.clientX - panStartRef.current.x),
        panY: panStartRef.current.panY + (e.clientY - panStartRef.current.y),
      }));
    };
    const handlePanEnd = () => {
      wasPanningRef.current = true;
      setIsCanvasPanning(false);
    };
    window.addEventListener('mousemove', handlePanMove);
    window.addEventListener('mouseup', handlePanEnd);
    return () => {
      window.removeEventListener('mousemove', handlePanMove);
      window.removeEventListener('mouseup', handlePanEnd);
    };
  }, [isCanvasPanning]);

  // Pause the 60 FPS WebGL loop when no CUE frame is selected — image frames don't need 3D rendering.
  // Use selectedFrame?.id (not the full object) so this only fires when frame identity changes,
  // not on every property update during drag.
  useEffect(() => {
    const extractor = extractorRef.current;
    if (!extractor || !extractorReady) return;
    if (selectedFrame) {
      extractor.startLivePreview();   // resume (guard inside prevents double-start)
    } else {
      extractor.stopLivePreview();    // pause — nothing to render in 3D
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFrame?.id, extractorReady]);  // intentionally omit extractorRef (stable ref object)

  // Capture screenshot when selection changes (deselecting a CUE frame)
  useEffect(() => {
    const prevId = previousSelectedIdRef.current;
    if (prevId && prevId !== selectedFrameId) {
      // Only capture from the 3D extractor when the PREVIOUS frame was a CUE frame
      const prevFrame = frames.find(f => f.id === prevId);
      if (prevFrame && isCueFrame(prevFrame) && extractorRef.current) {
        const screenshot = extractorRef.current.captureFrame('png');
        onScreenshotCapture(prevId, screenshot);
      }
    }
    previousSelectedIdRef.current = selectedFrameId;
  }, [selectedFrameId, extractorRef, onScreenshotCapture, frames]);

  // Attach/detach canvas to selected frame container
  useEffect(() => {
    const container = activeCanvasContainerRef.current;
    const extractor = extractorRef.current;
    
    console.log('[FrameCanvas] useEffect: container=', !!container, 'extractor=', !!extractor, 'selectedFrameId=', selectedFrameId, 'extractorReady=', extractorReady);
    
    // Wait for extractor to be ready (model and HDRI loaded)
    if (!container || !extractor || !selectedFrameId || !extractorReady) {
      canvasAttachedRef.current = false;
      return;
    }

    console.log('[FrameCanvas] All conditions met, applying frame settings...');
    
    // Attach canvas to the selected frame's container
    const canvas = extractor.getCanvas();
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';
    
    // Remove from previous parent if any
    if (canvas.parentElement && canvas.parentElement !== container) {
      canvas.parentElement.removeChild(canvas);
    }
    
    if (canvas.parentElement !== container) {
      container.appendChild(canvas);
    }
    canvasAttachedRef.current = true;

    // Apply frame settings to extractor (live preview loop handles rendering)
    if (selectedFrame) {
      extractor.resize(
        Math.round(selectedFrame.transform.width),
        Math.round(selectedFrame.transform.height)
      );
      extractor.setModelRotation(selectedFrame.cue.spinY);
      extractor.setCameraPhi(selectedFrame.cue.phi, 2);
      extractor.setCameraZoom(selectedFrame.cue.zoom);
      extractor.setModelOffset(selectedFrame.cue.offsetX, selectedFrame.cue.offsetY);
      // Use new multi-HDRI layers system
      if (selectedFrame.cue.hdriLayers && selectedFrame.cue.hdriLayers.length > 0) {
        extractor.setHdriLayers(selectedFrame.cue.hdriLayers, { applyCueEnv: true });
        extractor.setCueHdri(hdriLayersToCueHdri(selectedFrame.cue.hdriLayers));
      } else if (selectedFrame.cue.lightAngle !== undefined) {
        // Legacy fallback
        extractor.setHdriRotation(selectedFrame.cue.lightAngle);
      }
      // Apply studio shadow config
      extractor.setFrameShadow(selectedFrame.cue.studioShadow ?? DEFAULT_CUE_SHADOW);
    }

    return () => {
      // Don't remove canvas on cleanup - let it persist for next selection
    };
  }, [selectedFrameId, selectedFrame, extractorRef, extractorReady]);

  // Memoize hdriLayers to detect actual changes (not just reference changes)
  const hdriLayersKey = useMemo(() => {
    if (!selectedFrame?.cue.hdriLayers) return '';
    return JSON.stringify(selectedFrame.cue.hdriLayers);
  }, [selectedFrame?.cue.hdriLayers]);

  // Fast updates - model rotation, camera, zoom, offset (no HDRI)
  useEffect(() => {
    if (!extractorRef.current || !selectedFrame || !extractorReady) return;
    
    extractorRef.current.resize(
      Math.round(selectedFrame.transform.width),
      Math.round(selectedFrame.transform.height)
    );
    extractorRef.current.setModelRotation(selectedFrame.cue.spinY);
    extractorRef.current.setCameraPhi(selectedFrame.cue.phi, 2);
    extractorRef.current.setCameraZoom(selectedFrame.cue.zoom);
    extractorRef.current.setModelOffset(selectedFrame.cue.offsetX, selectedFrame.cue.offsetY);
  }, [
    selectedFrame?.id,
    selectedFrame?.transform.width,
    selectedFrame?.transform.height,
    selectedFrame?.cue.spinY,
    selectedFrame?.cue.phi,
    selectedFrame?.cue.zoom,
    selectedFrame?.cue.offsetX,
    selectedFrame?.cue.offsetY,
    extractorRef,
    extractorReady
  ]);

  // Slow updates - HDRI layers (debounced)
  useEffect(() => {
    if (!extractorRef.current || !selectedFrame || !extractorReady) return;
    if (!hdriLayersKey) return;
    
    // Debounce HDRI updates to avoid lag during slider drag
    const timeoutId = setTimeout(() => {
      if (selectedFrame.cue.hdriLayers && selectedFrame.cue.hdriLayers.length > 0) {
        extractorRef.current?.setHdriLayers(selectedFrame.cue.hdriLayers, { applyCueEnv: true });
        extractorRef.current?.setCueHdri(hdriLayersToCueHdri(selectedFrame.cue.hdriLayers));
      } else if (selectedFrame.cue.lightAngle !== undefined) {
        // Legacy fallback
        extractorRef.current?.setHdriRotation(selectedFrame.cue.lightAngle);
      }
    }, 100); // 100ms debounce
    
    return () => clearTimeout(timeoutId);
  }, [hdriLayersKey, selectedFrame?.cue.lightAngle, extractorRef, extractorReady]);

  // Studio shadow updates — apply whenever studioShadow config changes on the selected CueFrame
  useEffect(() => {
    if (!extractorRef.current || !selectedFrame || !extractorReady) return;
    if (!isCueFrame(selectedFrame)) return;
    const shadow: CueShadowConfig = selectedFrame.cue.studioShadow ?? DEFAULT_CUE_SHADOW;
    extractorRef.current.setFrameShadow(shadow);
  }, [
    selectedFrame?.id,
    // Stringify shadow config so deep equality works without a separate memo
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(selectedFrame && isCueFrame(selectedFrame) ? selectedFrame.cue.studioShadow : null),
    extractorRef,
    extractorReady,
  ]);
  const handleCanvasClick = (e: React.MouseEvent) => {
    // Ignore if we just finished dragging
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      return;
    }
    if (wasPanningRef.current) {
      wasPanningRef.current = false;
      return;
    }
    
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvas === 'background') {
      onSelectFrame(null);
    }
  };

  // Transform drag handlers (works for both CUE and IMAGE frames)
  const handleTransformStart = useCallback((
    e: React.MouseEvent, 
    type: 'move' | 'resize' | 'rotate', 
    handle?: string,
    frame?: ExtractorFrame
  ) => {
    if (!frame) return;
    
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    setDragType(type);
    setActiveHandle(handle || null);

    let centerX = 0, centerY = 0;
    if (containerRef.current) {
      const frameEl = containerRef.current.querySelector(`[data-frame-id="${frame.id}"]`);
      if (frameEl) {
        const rect = frameEl.getBoundingClientRect();
        centerX = rect.left + rect.width / 2;
        centerY = rect.top + rect.height / 2;
      }
    }

    const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
    const cue = isCueFrame(frame) ? frame.cue : null;

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      frameX: frame.transform.x,
      frameY: frame.transform.y,
      frameW: frame.transform.width,
      frameH: frame.transform.height,
      frameR: frame.transform.rotation,
      centerX,
      centerY,
      startAngle,
      cueSpinY: cue?.spinY ?? 0,
      cuePhi: cue?.phi ?? 0,
      cueOffsetX: cue?.offsetX ?? 0,
      cueOffsetY: cue?.offsetY ?? 0,
      frameId: frame.id,
    };
  }, []);

  // Cue 3D manipulation handlers (for selected frame inside area)
  // Like main preview: horizontal drag = model spin, vertical drag = camera up/down
  const handleCueStart = useCallback((e: React.MouseEvent) => {
    if (!selectedFrame) return;
    
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    
    // Left click = 3D control (spin + camera), Right click = pan model
    const type = e.button === 2 ? 'cue-pan' : 'cue-3d';
    setDragType(type);

    dragStartRef.current = {
      ...dragStartRef.current,
      x: e.clientX,
      y: e.clientY,
      cueSpinY: selectedFrame.cue.spinY,
      cuePhi: selectedFrame.cue.phi,
      cueOffsetX: selectedFrame.cue.offsetX,
      cueOffsetY: selectedFrame.cue.offsetY,
      frameId: selectedFrame.id,
    };
  }, [selectedFrame]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !dragType) return;

    const dx = (e.clientX - dragStartRef.current.x) / interactionScale;
    const dy = (e.clientY - dragStartRef.current.y) / interactionScale;
    const frame = frames.find(f => f.id === dragStartRef.current.frameId);
    if (!frame) return;

    // cue-3d and cue-pan only apply to CUE frames
    if ((dragType === 'cue-3d' || dragType === 'cue-pan') && !isCueFrame(frame)) return;

    if (dragType === 'move') {
      // Apply axis constraint along frame's LOCAL axes (respects rotation)
      let finalDx = dx;
      let finalDy = dy;
      
      if (axisConstraint) {
        // Convert frame rotation to radians
        const rotation = (frame.transform.rotation * Math.PI) / 180;
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        
        // Project mouse delta onto frame's local axes
        // Local X axis: (cos, sin), Local Y axis: (-sin, cos)
        const localX = dx * cos + dy * sin;   // projection onto frame's X axis
        const localY = -dx * sin + dy * cos;  // projection onto frame's Y axis
        
        if (axisConstraint === 'x') {
          // Move only along frame's local X axis (horizontal in frame space)
          finalDx = localX * cos;
          finalDy = localX * sin;
        } else {
          // Move only along frame's local Y axis (vertical in frame space)
          finalDx = localY * (-sin);
          finalDy = localY * cos;
        }
      }
      
      onFrameChange({
        ...frame,
        transform: {
          ...frame.transform,
          x: dragStartRef.current.frameX + finalDx,
          y: dragStartRef.current.frameY + finalDy,
        },
      });
    } else if (dragType === 'rotate') {
      const { centerX, centerY, startAngle, frameR } = dragStartRef.current;
      const currentAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
      const deltaAngle = (currentAngle - startAngle) * (180 / Math.PI);
      
      onFrameChange({
        ...frame,
        transform: {
          ...frame.transform,
          rotation: frameR + deltaAngle,
        },
      });
    } else if (dragType === 'resize' && activeHandle) {
      let newX = dragStartRef.current.frameX;
      let newY = dragStartRef.current.frameY;
      let newW = dragStartRef.current.frameW;
      let newH = dragStartRef.current.frameH;

      if (activeHandle.includes('w')) { newX += dx; newW -= dx; }
      if (activeHandle.includes('e')) { newW += dx; }
      if (activeHandle.includes('n')) { newY += dy; newH -= dy; }
      if (activeHandle.includes('s')) { newH += dy; }

      newW = Math.max(100, newW);
      newH = Math.max(100, newH);

      onFrameChange({
        ...frame,
        transform: { ...frame.transform, x: newX, y: newY, width: newW, height: newH },
      });
    } else if (dragType === 'cue-3d' && isCueFrame(frame)) {
      // Like main preview:
      // Horizontal drag (dx) -> spin model around Y axis
      // Vertical drag (dy) -> orbit camera up/down (phi angle)
      const spinSensitivity = 0.005;  // model rotation
      const phiSensitivity = 0.005;   // camera orbit
      
      const newSpinY = dragStartRef.current.cueSpinY + dx * spinSensitivity;
      // Phi: drag DOWN moves camera DOWN (phi increases = camera goes down), drag UP moves camera UP
      // This is NORMAL/intuitive: drag down = look down, drag up = look up
      const newPhi = Math.max(0.1, Math.min(Math.PI - 0.1, dragStartRef.current.cuePhi - dy * phiSensitivity));
      
      onFrameChange({
        ...frame,
        cue: {
          ...frame.cue,
          spinY: newSpinY,
          phi: newPhi,
        },
      });
    } else if (dragType === 'cue-pan' && isCueFrame(frame)) {
      // Right-drag: move model vertically only (Y axis), disable horizontal (X axis) movement
      const sensitivity = 0.002;
      onFrameChange({
        ...frame,
        cue: {
          ...frame.cue,
          // offsetX stays unchanged - no horizontal movement
          offsetY: dragStartRef.current.cueOffsetY - dy * sensitivity,
        },
      });
    }
  }, [isDragging, dragType, activeHandle, frames, onFrameChange, interactionScale, axisConstraint]);

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      wasDraggingRef.current = true;
      onDragEnd?.(); // commit the drag as a single undo step
    }
    setIsDragging(false);
    setDragType(null);
    setActiveHandle(null);
  }, [isDragging, onDragEnd]);

  const lastWheelRef = useRef(0);
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (zKeyDownRef.current) return; // Z held = canvas zoom, not cue zoom
    if (!selectedFrame) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheelRef.current < 150) return; // throttle — prevents trackpad momentum inertia
    lastWheelRef.current = now;
    const zoomDelta = e.deltaY > 0 ? -0.1 : 0.1;
    onFrameChange({
      ...selectedFrame,
      cue: { ...selectedFrame.cue, zoom: Math.max(0.5, Math.min(5, selectedFrame.cue.zoom + zoomDelta)) },
    });
  }, [selectedFrame, onFrameChange]);

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

  const handles: string[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
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

  return (
    <div
      ref={wrapperRef}
      className="flex-1 flex items-center justify-center p-4 bg-muted/20 overflow-hidden relative"
      style={{ cursor: zKeyDown ? (isCanvasPanning ? 'grabbing' : 'zoom-in') : undefined }}
      onMouseDown={handleCanvasPanStart}
    >
      {/* Canvas zoom indicator — fixed to wrapper, always visible */}
      {!previewMode && canvasView.zoom !== 1 && (
        <div
          className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded cursor-pointer z-50 hover:bg-black/80 pointer-events-auto"
          onClick={(e) => {
            e.stopPropagation();
            setCanvasView({ zoom: 1, panX: 0, panY: 0 });
          }}
        >
          🔍 {Math.round(canvasView.zoom * 100)}% — Reset
        </div>
      )}

      <div
        ref={containerRef}
        className="relative bg-background shadow-lg rounded-lg"
        style={{
          width: DISPLAY_SIZE,
          height: DISPLAY_SIZE,
          transform: `translate(${canvasView.panX}px, ${canvasView.panY}px) scale(${canvasView.zoom})`,
          transformOrigin: 'center center',
        }}
        onClick={handleCanvasClick}
      >
        {/* Canvas boundary indicator */}
        <div
          data-canvas="background"
          className="absolute inset-0 bg-[#1a1a1a] rounded-lg"
          style={{
            backgroundImage: `
              linear-gradient(45deg, #222 25%, transparent 25%),
              linear-gradient(-45deg, #222 25%, transparent 25%),
              linear-gradient(45deg, transparent 75%, #222 75%),
              linear-gradient(-45deg, transparent 75%, #222 75%)
            `,
            backgroundSize: '20px 20px',
            backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
          }}
        />
        
        {/* Clipping container for frame content - hides 3D content outside 2048x2048 bounds */}
        <div data-canvas="background" className="absolute inset-0 overflow-hidden rounded-lg z-0">
          {/* Render frames as static 2D (clipped).
              CUE frames that are selected are excluded here — handled by the 3D canvas below.
              IMAGE frames that are selected remain here so they stay visible with selection handles. */}
          {frames.filter(f => {
            if (hiddenFrameIds?.has(f.id)) return false;
            if (f.id === selectedFrameId && isCueFrame(f)) return false;
            return true;
          }).map((frame) => (
            <StaticFrame
              key={frame.id}
              frame={frame}
              screenshot={frameScreenshots[frame.id] || null}
              selected={frame.id === selectedFrameId}
              onSelect={() => onSelectFrame(frame.id)}
              scale={renderScale}
              onTransformStart={(e, type, handle) => handleTransformStart(e, type, handle, frame)}
              previewMode={previewMode}
            />
          ))}

          {/* Selected frame 3D canvas container (clipped) */}
          {selectedFrame && !hiddenFrameIds?.has(selectedFrame.id) && (
            <div
              data-frame-id={selectedFrame.id}
              className="absolute"
              style={{
                left: selectedFrame.transform.x * renderScale,
                top: selectedFrame.transform.y * renderScale,
                width: selectedFrame.transform.width * renderScale,
                height: selectedFrame.transform.height * renderScale,
                transform: `rotate(${selectedFrame.transform.rotation}deg)`,
                transformOrigin: 'center center',
              }}
            >
              {/* 3D Canvas container */}
              <div
                ref={activeCanvasContainerRef}
                className={cn(
                  "absolute inset-0 overflow-hidden rounded",
                  !previewMode && "border-2 border-primary pointer-events-none"
                )}
              >
                {/* WebGL canvas attached here */}
              </div>
            </div>
          )}
        </div>

        {/* Canvas border */}
        {!previewMode && (
          <div className="absolute inset-0 border-2 border-dashed border-muted-foreground/30 pointer-events-none rounded-lg z-10" />
        )}

        {/* Size indicator */}
        {!previewMode && (
          <div className="absolute top-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded pointer-events-none z-30">
            2048 × 2048
          </div>
        )}

        {/* Selected frame controls overlay (NOT clipped - handles stay visible) */}
        {!previewMode && selectedFrame && !hiddenFrameIds?.has(selectedFrame.id) && (
          <div
            className="absolute z-20 pointer-events-none"
            style={{
              left: selectedFrame.transform.x * renderScale,
              top: selectedFrame.transform.y * renderScale,
              width: selectedFrame.transform.width * renderScale,
              height: selectedFrame.transform.height * renderScale,
              transform: `rotate(${selectedFrame.transform.rotation}deg)`,
              transformOrigin: 'center center',
            }}
          >
            {/* Axis constraint lines - show when X or Y key is pressed */}
            {axisConstraint && (
              <>
                {/* Horizontal axis line (red) - when X is pressed, move only horizontally */}
                {axisConstraint === 'x' && (
                  <div
                    className="absolute pointer-events-none"
                    style={{
                      top: '50%',
                      left: -((selectedFrame.transform.x * renderScale) + 1000),
                      width: DISPLAY_SIZE + 2000,
                      height: 2,
                      backgroundColor: 'rgba(239, 68, 68, 0.8)',
                      transform: 'translateY(-50%)',
                    }}
                  />
                )}
                {/* Vertical axis line (green) - when Y is pressed, move only vertically */}
                {axisConstraint === 'y' && (
                  <div
                    className="absolute pointer-events-none"
                    style={{
                      left: '50%',
                      top: -((selectedFrame.transform.y * renderScale) + 1000),
                      width: 2,
                      height: DISPLAY_SIZE + 2000,
                      backgroundColor: 'rgba(34, 197, 94, 0.8)',
                      transform: 'translateX(-50%)',
                    }}
                  />
                )}
              </>
            )}

            {/* 3D interaction area - INSIDE the frame (inset from border) */}
            <div
              className="absolute inset-3 cursor-grab active:cursor-grabbing pointer-events-auto rounded"
              onMouseDown={handleCueStart}
              onWheel={handleWheel}
              onContextMenu={(e) => e.preventDefault()}
            />

            {/* Move border area - outer strip for dragging the frame */}
            <div
              className="absolute inset-0 pointer-events-auto cursor-move border-2 border-primary rounded"
              style={{ 
                clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, 12px 12px, 12px calc(100% - 12px), calc(100% - 12px) calc(100% - 12px), calc(100% - 12px) 12px, 12px 12px)'
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleTransformStart(e, 'move', undefined, selectedFrame);
              }}
            />

            {/* Resize handles */}
            {handles.map((h) => (
              <div
                key={h}
                className="absolute w-3 h-3 bg-primary rounded-sm border border-background z-20 pointer-events-auto"
                style={{
                  ...handlePositions[h],
                  cursor: handlePositions[h].cursor,
                  transform: h === 'n' || h === 's' ? 'translateX(-50%)' : h === 'e' || h === 'w' ? 'translateY(-50%)' : undefined,
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleTransformStart(e, 'resize', h, selectedFrame);
                }}
              />
            ))}

            {/* Rotation handles */}
            <div
              className="absolute -top-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-primary rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing z-20 pointer-events-auto"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleTransformStart(e, 'rotate', undefined, selectedFrame);
              }}
            >
              <RotateCw className="w-3 h-3 text-primary-foreground" />
            </div>
            <div
              className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-primary rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing z-20 pointer-events-auto"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleTransformStart(e, 'rotate', undefined, selectedFrame);
              }}
            >
              <RotateCw className="w-3 h-3 text-primary-foreground" />
            </div>

            {/* Frame label */}
            <div className="absolute bottom-1 left-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded pointer-events-none z-10">
              {selectedFrame.cue.zoom.toFixed(1)}x
            </div>
          </div>
        )}

        {/* Empty state */}
        {frames.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground pointer-events-none z-10">
            <div className="text-center">
              <p className="text-lg">Chưa có khung</p>
              <p className="text-sm">Thêm khung hoặc chọn mẫu để bắt đầu</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export { CANVAS_SIZE, DISPLAY_SIZE };
