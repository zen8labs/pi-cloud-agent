"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import {
  buildFileDiff,
  type DiffLine,
  type FileChangeStat,
  type FileDiff,
  fileChangeStats,
} from "@/lib/file-changes";
import { cn } from "@/lib/utils";

export type { FileChangeStat };
export { fileChangeStats };

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function ToolArgsView({
  tool,
  args,
  output = null,
}: {
  tool: string;
  args: Record<string, unknown>;
  output?: string | null;
}) {
  const shell = shellCommand(tool, args);
  if (shell !== null) return <ShellView command={shell} output={output ?? ""} />;

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

function shellCommand(tool: string, args: Record<string, unknown>): string | null {
  const name = tool.toLowerCase();
  if (name !== "bash" && name !== "shell") return null;
  return asString(args.command) ?? asString(args.cmd);
}

function ShellView({ command, output }: { command: string; output: string }) {
  return (
    <div className="ml-5 overflow-hidden rounded-md border border-border/80 bg-zinc-950 text-zinc-100 dark:bg-black/50">
      <div className="border-b border-white/10 px-2.5 py-1 text-[10px] font-medium tracking-wide text-zinc-400">
        Shell
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 font-mono text-[11px] leading-5">
        <span className="text-zinc-500">$ </span>
        <span className="text-zinc-100">{command}</span>
        {output ? <span className="text-zinc-400">{`\n${output}`}</span> : null}
      </pre>
    </div>
  );
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
