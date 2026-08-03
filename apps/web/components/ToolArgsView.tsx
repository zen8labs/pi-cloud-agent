"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

type DiffKind = "add" | "del";

type DiffLine = {
  key: string;
  kind: DiffKind;
  text: string;
  lineNo: number;
};

type FileDiff = {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  copyText: string;
};

type EditHunk = { oldText: string; newText: string };

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toolPath(args: Record<string, unknown>): string {
  return asString(args.path) ?? asString(args.filePath) ?? asString(args.file_path) ?? "file";
}

function splitLines(text: string): string[] {
  if (!text) return [""];
  const parts = text.split("\n");
  // A trailing newline is a terminator, not an empty final line.
  if (parts.length > 1 && parts.at(-1) === "") parts.pop();
  return parts;
}

function linesFromText(text: string, kind: DiffKind, keyPrefix: string): DiffLine[] {
  return splitLines(text).map((line, index) => {
    const lineNo = index + 1;
    return {
      key: `${keyPrefix}-${kind}-${lineNo}`,
      kind,
      text: line,
      lineNo,
    };
  });
}

function parseEditHunks(args: Record<string, unknown>): EditHunk[] {
  const raw = args.edits;
  const hunks: EditHunk[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const oldText = asString(record.oldText);
      const newText = asString(record.newText);
      if (oldText === null || newText === null) continue;
      hunks.push({ oldText, newText });
    }
  }
  const legacyOld = asString(args.oldText);
  const legacyNew = asString(args.newText);
  if (legacyOld !== null && legacyNew !== null) {
    hunks.push({ oldText: legacyOld, newText: legacyNew });
  }
  return hunks;
}

function buildWriteDiff(args: Record<string, unknown>): FileDiff | null {
  const content = asString(args.content);
  if (content === null) return null;
  const lines = linesFromText(content, "add", "write");
  return {
    path: toolPath(args),
    lines,
    added: lines.length,
    removed: 0,
    copyText: content,
  };
}

function buildEditDiff(args: Record<string, unknown>): FileDiff | null {
  const hunks = parseEditHunks(args);
  if (!hunks.length) return null;
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  const copyParts: string[] = [];
  for (const [hunkIndex, hunk] of hunks.entries()) {
    const prefix = `edit-${hunkIndex}`;
    const del = linesFromText(hunk.oldText, "del", prefix);
    const add = linesFromText(hunk.newText, "add", prefix);
    lines.push(...del, ...add);
    removed += del.length;
    added += add.length;
    copyParts.push(hunk.newText);
  }
  return {
    path: toolPath(args),
    lines,
    added,
    removed,
    copyText: copyParts.join("\n"),
  };
}

function buildFileDiff(tool: string, args: Record<string, unknown>): FileDiff | null {
  switch (tool.toLowerCase()) {
    case "write":
      return buildWriteDiff(args);
    case "edit":
      return buildEditDiff(args);
    default:
      return null;
  }
}

export type FileChangeStat = {
  path: string;
  added: number;
  removed: number;
};

/** Line-level +/− for one write/edit tool call; null when the args are not a file change. */
export function fileChangeStats(
  tool: string,
  args: Record<string, unknown>,
): FileChangeStat | null {
  const diff = buildFileDiff(tool, args);
  if (!diff) return null;
  return { path: diff.path, added: diff.added, removed: diff.removed };
}

export function ToolArgsView({ tool, args }: { tool: string; args: Record<string, unknown> }) {
  const diff = buildFileDiff(tool, args);
  if (!diff) {
    return (
      <pre className="ml-5 max-h-64 overflow-auto whitespace-pre-wrap py-1.5 font-mono text-[11px] leading-5 text-muted-foreground/80">
        {JSON.stringify(args, null, 2)}
      </pre>
    );
  }
  return <FileDiffView diff={diff} />;
}

function FileDiffView({ diff }: { diff: FileDiff }) {
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-border/80 bg-muted/30">
      <div className="flex items-center gap-2 border-b border-border/80 px-2.5 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-foreground/85">
          {diff.path}
        </span>
        <span className="shrink-0 font-mono text-[11px]">
          {diff.added > 0 ? (
            <span className="text-emerald-600 dark:text-emerald-400">+{diff.added}</span>
          ) : null}
          {diff.added > 0 && diff.removed > 0 ? (
            <span className="text-muted-foreground"> </span>
          ) : null}
          {diff.removed > 0 ? (
            <span className="text-red-600 dark:text-red-400">-{diff.removed}</span>
          ) : null}
        </span>
        <div className="ml-auto">
          <CopyButton text={diff.copyText} />
        </div>
      </div>
      <div className="max-h-64 overflow-auto font-mono text-[11px] leading-5">
        {diff.lines.map((line) => (
          <DiffLineRow key={line.key} line={line} />
        ))}
      </div>
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const isAdd = line.kind === "add";
  return (
    <div className={cn("flex min-w-0", isAdd ? "bg-emerald-500/15" : "bg-red-500/15")}>
      <span
        className={cn("w-1 shrink-0", isAdd ? "bg-emerald-500/70" : "bg-red-500/70")}
        aria-hidden
      />
      <span
        className={cn(
          "w-8 shrink-0 select-none pr-1.5 text-right tabular-nums",
          isAdd
            ? "text-emerald-700/80 dark:text-emerald-400/80"
            : "text-red-700/80 dark:text-red-400/80",
        )}
      >
        {line.lineNo}
      </span>
      <span
        className={cn(
          "w-3 shrink-0 select-none text-center",
          isAdd ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400",
        )}
      >
        {isAdd ? "+" : "-"}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 text-foreground/90">
        {line.text}
      </span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail in non-secure contexts; leave the icon unchanged.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label={copied ? "Copied" : "Copy"}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}
