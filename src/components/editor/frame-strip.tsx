"use client";

import { useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Target, ImageIcon, Eye, EyeOff, Trash2, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ExtractorFrame } from "@/types/extractor";
import { isCueFrame } from "@/types/extractor";
import { cn } from "@/lib/utils";

interface FrameStripProps {
  frames: ExtractorFrame[];
  selectedFrameId: string | null;
  hiddenFrameIds: Set<string>;
  frameScreenshots: Record<string, string>;
  onSelectFrame: (id: string) => void;
  onReorderFrames: (frames: ExtractorFrame[]) => void;
  onToggleVisibility: (id: string) => void;
  onDeleteFrame: (id: string) => void;
}

interface SortableStripItemProps {
  frame: ExtractorFrame;
  index: number;
  isSelected: boolean;
  isHidden: boolean;
  screenshot?: string;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onDelete: () => void;
}

function SortableStripItem({
  frame,
  index,
  isSelected,
  isHidden,
  screenshot,
  onSelect,
  onToggleVisibility,
  onDelete,
}: SortableStripItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: frame.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isCue = isCueFrame(frame);

  const getThumbnailStyle = (): React.CSSProperties => {
    if (isCue) {
      if (screenshot) {
        return {
          backgroundImage: `url(${screenshot})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        };
      }
      return {
        background: "linear-gradient(135deg, #4a5568 0%, #2d3748 50%, #1a202c 100%)",
      };
    } else {
      const s = frame.imageSettings;
      if (s.imageUrl) {
        return {
          backgroundImage: `url(${s.imageUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        };
      }
      return { backgroundColor: s.backgroundColor };
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative flex-shrink-0 flex flex-col rounded-md border bg-card transition-all select-none cursor-pointer group",
        "w-[88px]",
        isSelected
          ? "border-primary ring-2 ring-primary/30"
          : "border-border hover:border-muted-foreground/50",
        isDragging && "opacity-50 shadow-lg z-50",
        isHidden && "opacity-40"
      )}
      onClick={onSelect}
    >
      {/* Thumbnail */}
      <div
        className="w-full h-[52px] rounded-t-md overflow-hidden"
        style={getThumbnailStyle()}
      >
        {/* Type badge */}
        <div className="absolute top-1 left-1 bg-black/60 rounded px-1 py-0.5 flex items-center gap-0.5">
          {isCue ? (
            <Target className="w-2.5 h-2.5 text-white" />
          ) : (
            <ImageIcon className="w-2.5 h-2.5 text-white" />
          )}
        </div>
      </div>

      {/* Label row */}
      <div className="flex items-center justify-between px-1.5 py-1 gap-1">
        {/* Drag handle */}
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-muted-foreground shrink-0 touch-none"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="w-3 h-3" />
        </div>

        <span className="text-[10px] font-medium text-muted-foreground flex-1 truncate leading-none">
          {index + 1} · {isCue ? "Cue" : "Img"}
        </span>

        {/* Action buttons - visible on hover/selected */}
        <div
          className={cn(
            "flex items-center gap-0.5 shrink-0 transition-opacity",
            isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0"
            onClick={onToggleVisibility}
            title={isHidden ? "Show" : "Hide"}
          >
            {isHidden ? (
              <EyeOff className="w-2.5 h-2.5 text-muted-foreground" />
            ) : (
              <Eye className="w-2.5 h-2.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 text-destructive hover:text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <Trash2 className="w-2.5 h-2.5" />
          </Button>
        </div>
      </div>

      {/* Active indicator bar */}
      {isSelected && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-b-md" />
      )}
    </div>
  );
}

export function FrameStrip({
  frames,
  selectedFrameId,
  hiddenFrameIds,
  frameScreenshots,
  onSelectFrame,
  onReorderFrames,
  onToggleVisibility,
  onDeleteFrame,
}: FrameStripProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [frameToDelete, setFrameToDelete] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const sortedFrames = [...frames].sort((a, b) => a.order - b.order);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = sortedFrames.findIndex((f) => f.id === active.id);
      const newIndex = sortedFrames.findIndex((f) => f.id === over.id);
      const reordered = arrayMove(sortedFrames, oldIndex, newIndex).map(
        (frame, i) => ({ ...frame, order: i })
      );
      onReorderFrames(reordered);
    }
  };

  const handleDeleteClick = (id: string) => {
    setFrameToDelete(id);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (frameToDelete) onDeleteFrame(frameToDelete);
    setDeleteDialogOpen(false);
    setFrameToDelete(null);
  };

  if (frames.length === 0) {
    return (
      <div className="border-t bg-muted/20 px-4 py-3 flex items-center justify-center">
        <span className="text-xs text-muted-foreground">
          No frames yet — add a frame to get started.
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="border-t bg-background/95 backdrop-blur-sm px-3 py-2 flex items-center gap-1.5 overflow-x-auto shrink-0">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sortedFrames.map((f) => f.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex items-center gap-2">
              {sortedFrames.map((frame, index) => (
                <SortableStripItem
                  key={frame.id}
                  frame={frame}
                  index={index}
                  isSelected={frame.id === selectedFrameId}
                  isHidden={hiddenFrameIds.has(frame.id)}
                  screenshot={frameScreenshots[frame.id]}
                  onSelect={() => onSelectFrame(frame.id)}
                  onToggleVisibility={() => onToggleVisibility(frame.id)}
                  onDelete={() => handleDeleteClick(frame.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Frame</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this frame? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
