"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

type ResizeSide = "left" | "right";

export function SidebarResizeHandle({
  side,
  currentSize,
  minSize,
  maxSize,
  onResize,
  onReset,
}: {
  side: ResizeSide;
  currentSize: number;
  minSize: number;
  maxSize: number;
  onResize: (size: number) => void;
  onReset: () => void;
}) {
  const dragging = useRef(false);

  const resizeFromPointer = (clientX: number) => {
    const size = side === "left" ? clientX : window.innerWidth - clientX;
    onResize(size);
  };

  const step = (direction: -1 | 1) => {
    onResize(currentSize + direction * 16);
  };

  return (
    <hr
      aria-label={`${side === "left" ? "Navigation" : "Changes"} sidebar resize handle`}
      aria-orientation="vertical"
      aria-valuemax={maxSize}
      aria-valuemin={minSize}
      aria-valuenow={currentSize}
      className={cn(
        "absolute inset-y-0 m-0 w-1 cursor-col-resize border-0 bg-transparent p-0 touch-none transition-colors hover:bg-ring/50 focus-visible:bg-ring/70 focus-visible:outline-none",
        side === "left" ? "-right-px" : "-left-px",
      )}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "Home") {
          event.preventDefault();
          onResize(minSize);
        } else if (event.key === "End") {
          event.preventDefault();
          onResize(maxSize);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          step(side === "left" ? -1 : 1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          step(side === "left" ? 1 : -1);
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeFromPointer(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragging.current) resizeFromPointer(event.clientX);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      tabIndex={0}
    />
  );
}
