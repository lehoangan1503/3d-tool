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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Target, ImageIcon, Eye, EyeOff, Trash2, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface FramesListProps {
  frames: ExtractorFrame[];
  selectedFrameId: string | null;
  hiddenFrameIds: Set<string>;
  onSelectFrame: (id: string) => void;
  onReorderFrames: (frames: ExtractorFrame[]) => void;
  onToggleVisibility: (id: string) => void;
  onDeleteFrame: (id: string) => void;
  onRenameFrame?: (id: string, name: string) => void;
}

interface SortableFrameItemProps {
  frame: ExtractorFrame;
  index: number;
  isSelected: boolean;
  isHidden: boolean;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onDelete: () => void;
  onRename?: (name: string) => void;
}

function SortableFrameItem({
  frame,
  index,
  isSelected,
  isHidden,
  onSelect,
  onToggleVisibility,
  onDelete,
  onRename,
}: SortableFrameItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: frame.id });

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(frame.name || "");

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isCue = isCueFrame(frame);

  const defaultLabel = `Frame ${index + 1} · ${isCue ? "Cue" : "Image"}`;
  const displayLabel = frame.name || defaultLabel;

  const commitRename = () => {
    const trimmed = renameValue.trim();
    onRename?.(trimmed);
    setIsRenaming(false);
  };

  const cancelRename = () => {
    setRenameValue(frame.name || "");
    setIsRenaming(false);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-1.5 px-1.5 py-1 rounded bg-card transition-all select-none cursor-pointer",
        isSelected
          ? "border-2 border-blue-500 bg-blue-500/10 shadow-[0_0_0_2px_rgb(59_130_246/0.25)]"
          : "border border-border hover:border-muted-foreground/50",
        isDragging && "opacity-50 shadow-md",
        isHidden && "opacity-50"
      )}
      onClick={isRenaming ? undefined : onSelect}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-3 h-3" />
      </div>

      {/* Label / rename input */}
      {isRenaming ? (
        <div
          className="flex items-center gap-1 flex-1 min-w-0"
          onClick={(e) => e.stopPropagation()}
        >
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            className="h-5 flex-1 text-[11px] px-1 py-0 min-w-0"
            autoFocus
            placeholder={defaultLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") cancelRename();
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-green-500 hover:text-green-400 shrink-0"
            onClick={commitRename}
          >
            <Check className="w-2.5 h-2.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={cancelRename}
          >
            <X className="w-2.5 h-2.5" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {isCue ? (
            <Target className="w-3 h-3 text-muted-foreground shrink-0" />
          ) : (
            <ImageIcon className="w-3 h-3 text-muted-foreground shrink-0" />
          )}
          <span
            className={cn(
              "text-[11px] font-medium truncate flex-1",
              isSelected && "text-blue-600 dark:text-blue-400"
            )}
          >
            {displayLabel}
          </span>
          {onRename && (
            <button
              className="opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-foreground transition-opacity"
              title="Rename frame"
              onClick={(e) => {
                e.stopPropagation();
                setRenameValue(frame.name || "");
                setIsRenaming(true);
              }}
            >
              <Pencil className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
      )}

      {/* Controls */}
      <div
        className="flex items-center gap-0.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={onToggleVisibility}
          title={isHidden ? "Show frame" : "Hide frame"}
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
          className="h-5 w-5 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={onDelete}
          title="Delete frame"
        >
          <Trash2 className="w-2.5 h-2.5" />
        </Button>
      </div>
    </div>
  );
}

export function FramesList({
  frames,
  selectedFrameId,
  hiddenFrameIds,
  onSelectFrame,
  onReorderFrames,
  onToggleVisibility,
  onDeleteFrame,
  onRenameFrame,
}: FramesListProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [frameToDelete, setFrameToDelete] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = frames.findIndex((f) => f.id === active.id);
      const newIndex = frames.findIndex((f) => f.id === over.id);

      const reorderedFrames = arrayMove(frames, oldIndex, newIndex).map(
        (frame, index) => ({
          ...frame,
          order: index,
        })
      );

      onReorderFrames(reorderedFrames);
    }
  };

  const handleDeleteClick = (id: string) => {
    setFrameToDelete(id);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (frameToDelete) {
      onDeleteFrame(frameToDelete);
    }
    setDeleteDialogOpen(false);
    setFrameToDelete(null);
  };

  // Sort frames by order for display
  const sortedFrames = [...frames].sort((a, b) => a.order - b.order);

  if (frames.length === 0) {
    return (
      <div className="border-t bg-muted/30 p-4">
        <div className="text-center text-sm text-muted-foreground">
          No frames yet. Click &ldquo;Add Frame&rdquo; to get started.
        </div>
      </div>
    );
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sortedFrames.map((f) => f.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-1">
            {sortedFrames.map((frame, index) => (
              <SortableFrameItem
                key={frame.id}
                frame={frame}
                index={index}
                isSelected={frame.id === selectedFrameId}
                isHidden={hiddenFrameIds.has(frame.id)}
                onSelect={() => onSelectFrame(frame.id)}
                onToggleVisibility={() => onToggleVisibility(frame.id)}
                onDelete={() => handleDeleteClick(frame.id)}
                onRename={onRenameFrame ? (name) => onRenameFrame(frame.id, name) : undefined}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Frame</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this frame? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
