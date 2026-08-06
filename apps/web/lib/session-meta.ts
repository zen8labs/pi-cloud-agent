import type { RunEvent } from "@pi-cloud-agent/protocol";
import { type FileChangeStat, fileChangeStats } from "./file-changes";

export type ChangeSummary = {
  files: FileChangeStat[];
  added: number;
  removed: number;
};

/** Aggregate write/edit tool calls across one or more turns into +/− totals. */
export function summarizeChanges(events: RunEvent[]): ChangeSummary {
  const byPath = new Map<string, FileChangeStat>();
  const order: string[] = [];
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const tool = String(event.data?.tool ?? "");
    const args = (event.data?.args as Record<string, unknown>) ?? {};
    const stat = fileChangeStats(tool, args);
    if (!stat) continue;
    const existing = byPath.get(stat.path);
    if (existing) {
      existing.added += stat.added;
      existing.removed += stat.removed;
      continue;
    }
    byPath.set(stat.path, { path: stat.path, added: stat.added, removed: stat.removed });
    order.push(stat.path);
  }
  const files = order.flatMap((path) => {
    const stat = byPath.get(path);
    return stat ? [stat] : [];
  });
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

/**
 * Best-effort current branch: start from the clone target, then advance whenever
 * the stream shows a checkout/switch or a successful `git.cloned` log.
 */
export function resolveBranch(initial: string | null, events: RunEvent[]): string | null {
  let branch = initial;
  for (const event of events) {
    const next = branchFromEvent(event);
    if (next) branch = next;
  }
  return branch;
}

function branchFromEvent(event: RunEvent): string | null {
  if (event.type === "log") {
    if (event.data?.event !== "git.cloned") return null;
    const branch = event.data.branch;
    return typeof branch === "string" && branch && branch !== "(default)" ? branch : null;
  }
  if (event.type !== "tool_call") return null;
  const tool = String(event.data?.tool ?? "").toLowerCase();
  if (tool !== "bash" && tool !== "shell") return null;
  const args = (event.data?.args as Record<string, unknown>) ?? {};
  const command =
    (typeof args.command === "string" ? args.command : null) ??
    (typeof args.cmd === "string" ? args.cmd : null);
  return command ? branchFromGitCommand(command) : null;
}

/** Last matching checkout/switch/rename in a shell command string. */
function branchFromGitCommand(command: string): string | null {
  const patterns = [
    /\bgit\s+switch\s+(?:--create|-c)\s+([^\s]+)/g,
    /\bgit\s+checkout\s+(?:-b|-B)\s+([^\s]+)/g,
    /\bgit\s+switch\s+(?!-)([^\s]+)/g,
    /\bgit\s+checkout\s+(?!-)([^\s]+)/g,
    /\bgit\s+branch\s+-M\s+([^\s]+)/g,
  ];
  let found: string | null = null;
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const name = match[1];
      if (name && !name.startsWith("-") && name !== ".") found = name;
    }
  }
  return found;
}
