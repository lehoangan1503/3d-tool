"use client";

import { useRef } from "react";
import type { SceneManager } from "@/lib/three/scene-manager";
import type { ExtractorFrame } from "@/types/extractor";
import { DraggableFrame } from "./draggable-frame";

interface FrameCanvasProps {
  frames: ExtractorFrame[];
  selectedFrameId: string | null;
  onSelectFrame: (id: string | null) => void;
  onFrameChange: (frame: ExtractorFrame) => void;
  sceneManager: SceneManager | null;
}

const CANVAS_SIZE = 2048;
const DISPLAY_SIZE = 600; // Display size in pixels

export function FrameCanvas({
  frames,
  selectedFrameId,
  onSelectFrame,
  onFrameChange,
  sceneManager,
}: FrameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Scale factor: how much to shrink 2048 to fit display
  const scale = DISPLAY_SIZE / CANVAS_SIZE;

  const handleCanvasClick = (e: React.MouseEvent) => {
    // Only deselect if clicking directly on canvas background
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvas === 'background') {
      onSelectFrame(null);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4 bg-muted/20 overflow-auto">
      {/* Outer container for centering */}
      <div
        ref={containerRef}
        className="relative bg-background shadow-lg rounded-lg overflow-hidden"
        style={{
          width: DISPLAY_SIZE,
          height: DISPLAY_SIZE,
        }}
        onClick={handleCanvasClick}
      >
        {/* Canvas boundary indicator */}
        <div
          data-canvas="background"
          className="absolute inset-0 bg-[#1a1a1a]"
          style={{
            // Checkerboard pattern to indicate transparency
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

        {/* Canvas border */}
        <div className="absolute inset-0 border-2 border-dashed border-muted-foreground/30 pointer-events-none" />

        {/* Size indicator */}
        <div className="absolute top-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded pointer-events-none">
          2048 × 2048
        </div>

        {/* Render all frames */}
        {frames.map((frame) => (
          <DraggableFrame
            key={frame.id}
            frame={frame}
            onFrameChange={onFrameChange}
            sceneManager={sceneManager}
            selected={frame.id === selectedFrameId}
            onSelect={() => onSelectFrame(frame.id)}
            scale={scale}
          />
        ))}

        {/* Empty state */}
        {frames.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground pointer-events-none">
            <div className="text-center">
              <p className="text-lg">No frames yet</p>
              <p className="text-sm">Add a frame or select a template to start</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Export constants for use in other components
export { CANVAS_SIZE, DISPLAY_SIZE };
