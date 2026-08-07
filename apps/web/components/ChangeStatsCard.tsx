"use client";

import { ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { useState } from "react";
import type { FileChangeStat } from "@/components/ToolArgsView";
import { cn } from "@/lib/utils";

const VISIBLE_COUNT = 3;

export function ChangeStatsCard({
  files,
  createdOnly,
  onFileClick,
}: {
  files: FileChangeStat[];
  createdOnly: boolean;
  onFileClick?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!files.length) return null;

  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const hidden = Math.max(0, files.length - VISIBLE_COUNT);
  const visible = expanded ? files : files.slice(0, VISIBLE_COUNT);
  const noun = files.length === 1 ? "file" : "files";
  const title = createdOnly
    ? `Created ${files.length} ${noun}`
    : `Edited ${files.length} ${noun}`;

  return (
    <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/80 bg-muted/50 text-muted-foreground">
          <SquarePenIcon className="size-3.5" />
        </span>
        <span className="text-sm font-medium text-foreground/90">{title}</span>
        <span className="font-mono text-xs">
          {added > 0 ? (
            <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
          ) : null}
          {added > 0 && removed > 0 ? <span className="text-muted-foreground"> </span> : null}
          {removed > 0 ? (
            <span className="text-red-600 dark:text-red-400">-{removed}</span>
          ) : null}
        </span>
      </div>
      <ul className="border-t border-border/70 px-3.5 py-1.5">
        {visible.map((file) => (
          <li key={file.path} className="min-w-0 text-[13px]">
            <button
              type="button"
              onClick={() => onFileClick?.(file.path)}
              aria-label={`Open changes for ${file.path}`}
              className={cn(
                "flex w-full min-w-0 items-center justify-between gap-3 py-1 text-left",
                onFileClick && "cursor-pointer rounded-sm transition-colors hover:bg-accent/60",
              )}
            >
              <span className="min-w-0 truncate font-mono text-xs text-foreground/80">
                {file.path}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{file.added}</span>
                <span className="text-muted-foreground"> </span>
                <span className="text-red-600 dark:text-red-400">-{file.removed}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center justify-center gap-1 border-t border-border/70 px-3.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Show {hidden} more {hidden === 1 ? "file" : "files"}
          <ChevronDownIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
