"use client";

import type { RunEvent, RunStatus } from "@pi-cloud-agent/protocol";
import { type FileChangeStat, fileChangeStats } from "@/components/ToolArgsView";

export type ToolLine = {
  key: string;
  kind: "tool";
  tool: string;
  args: Record<string, unknown>;
  status: string;
  callId: string;
  output: string | null;
  at: string;
};

export type LogLine = { key: string; kind: "log"; text: string; at: string };

export type FlatBlock = { key: string } & (
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string; at: string }
  | ToolLine
  | LogLine
  | { kind: "status"; status: RunStatus; error?: string | null }
);

export type WorkBlock = {
  key: string;
  kind: "work";
  items: (ToolLine | LogLine)[];
  startedAt: string;
  endedAt: string;
};

type ChangesBlock = {
  key: string;
  kind: "changes";
  files: FileChangeStat[];
  createdOnly: boolean;
};

export type ActivityBlock = FlatBlock | WorkBlock | ChangesBlock;

export function foldEvents(events: RunEvent[], userPrompt: string | null): ActivityBlock[] {
  const flat: FlatBlock[] = userPrompt
    ? [{ key: "prompt", kind: "user", text: userPrompt }]
    : [];
  const tools = new Map<string, ToolLine>();
  const finalizedThinking = new Set<string>();
  for (const event of events) foldEvent(flat, tools, finalizedThinking, event);
  const visible = flat.filter(
    (block) => (block.kind !== "assistant" && block.kind !== "thinking") || block.text.trim(),
  );
  return appendChangeStats(groupWork(visible));
}

/** Aggregate write/edit tools into a trailing summary card for the turn. */
function appendChangeStats(blocks: ActivityBlock[]): ActivityBlock[] {
  const { files, createdOnly } = collectFileChanges(blocks);
  if (!files.length) return blocks;
  return [...blocks, { key: "changes", kind: "changes", files, createdOnly }];
}

function collectFileChanges(blocks: ActivityBlock[]): {
  files: FileChangeStat[];
  createdOnly: boolean;
} {
  const byPath = new Map<string, FileChangeStat>();
  const order: string[] = [];
  let sawEdit = false;
  let sawWrite = false;
  for (const item of workTools(blocks)) {
    const name = item.tool.toLowerCase();
    if (name === "edit") sawEdit = true;
    if (name === "write") sawWrite = true;
    mergeFileStat(byPath, order, fileChangeStats(item.tool, item.args));
  }
  const files = order.flatMap((path) => {
    const stat = byPath.get(path);
    return stat ? [stat] : [];
  });
  return { files, createdOnly: sawWrite && !sawEdit };
}

function workTools(blocks: ActivityBlock[]): ToolLine[] {
  const tools: ToolLine[] = [];
  for (const block of blocks) {
    if (block.kind !== "work") continue;
    for (const item of block.items) {
      if (item.kind === "tool") tools.push(item);
    }
  }
  return tools;
}

function mergeFileStat(
  byPath: Map<string, FileChangeStat>,
  order: string[],
  stat: FileChangeStat | null,
): void {
  if (!stat) return;
  const existing = byPath.get(stat.path);
  if (existing) {
    existing.added += stat.added;
    existing.removed += stat.removed;
    return;
  }
  byPath.set(stat.path, { path: stat.path, added: stat.added, removed: stat.removed });
  order.push(stat.path);
}

/** Consecutive tool and log lines collapse into one "Worked for …" group, like Codex. */
function groupWork(blocks: FlatBlock[]): ActivityBlock[] {
  const grouped: ActivityBlock[] = [];
  for (const block of blocks) {
    const last = grouped.at(-1);
    if (block.kind === "tool" || block.kind === "log") {
      if (last?.kind === "work") {
        last.items.push(block);
        last.endedAt = block.at;
      } else {
        grouped.push({
          key: `work-${block.key}`,
          kind: "work",
          items: [block],
          startedAt: block.at,
          endedAt: block.at,
        });
      }
    } else {
      grouped.push(block);
    }
  }
  return grouped;
}

function foldEvent(
  blocks: FlatBlock[],
  tools: Map<string, ToolLine>,
  finalizedThinking: Set<string>,
  event: RunEvent,
): void {
  switch (event.type) {
    case "token":
      foldToken(blocks, event);
      break;
    case "tool_call":
      foldTool(blocks, tools, event);
      break;
    case "status":
      foldStatus(blocks, event);
      break;
    default:
      foldLog(blocks, finalizedThinking, event);
  }
}

function foldToken(blocks: FlatBlock[], event: RunEvent): void {
  const content = String(event.data?.content ?? "");
  const last = blocks.at(-1);
  if (!content) return;
  if (last?.kind === "assistant") last.text += content;
  else blocks.push({ key: `assistant-${event.seq}`, kind: "assistant", text: content });
}

function foldTool(blocks: FlatBlock[], tools: Map<string, ToolLine>, event: RunEvent): void {
  const callId = String(event.data?.callId ?? "");
  const output = toolOutput(event.data?.output);
  const existing = callId ? tools.get(callId) : undefined;
  if (existing) {
    existing.status = String(event.data?.status ?? existing.status);
    existing.at = event.at;
    if (output !== null) existing.output = output;
    return;
  }
  const block: ToolLine = {
    key: `tool-${callId || event.seq}`,
    kind: "tool",
    tool: String(event.data?.tool ?? "tool"),
    args: (event.data?.args as Record<string, unknown>) ?? {},
    status: String(event.data?.status ?? "running"),
    callId,
    output,
    at: event.at,
  };
  if (callId) tools.set(callId, block);
  blocks.push(block);
}

function toolOutput(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The stream reports "done"/"error"; the mirrored terminal event carries a RunStatus. */
function foldStatus(blocks: FlatBlock[], event: RunEvent): void {
  const raw = String(event.data?.status ?? "");
  const status: RunStatus =
    raw === "done" ? "succeeded" : raw === "error" ? "failed" : (raw as RunStatus);
  if (status === "succeeded") return;
  const detail = String(event.data?.detail ?? "");
  blocks.push({
    key: `status-${event.seq}`,
    kind: "status",
    status,
    error: detail || null,
  });
}

function foldLog(blocks: FlatBlock[], finalizedThinking: Set<string>, event: RunEvent): void {
  const data = event.data ?? {};
  if (data.event === "agent.turn_end") {
    foldTurnThinking(blocks, finalizedThinking, data.output, event);
    return;
  }
  const thinking = thinkingContent(data);
  if (thinking !== null) {
    foldThinking(blocks, finalizedThinking, thinking, event);
    return;
  }
  const text = logText(data);
  if (text) blocks.push({ key: `log-${event.seq}`, kind: "log", text, at: event.at });
}

/** Current runs carry reasoning in the durable turn result instead of a debug log. */
function foldTurnThinking(
  blocks: FlatBlock[],
  finalizedThinking: Set<string>,
  value: unknown,
  event: RunEvent,
): void {
  if (!Array.isArray(value)) return;
  const content = value
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const record = part as Record<string, unknown>;
      return record.type === "thinking" && typeof record.thinking === "string"
        ? [record.thinking]
        : [];
    })
    .join("");
  if (!content) return;

  const last = blocks.at(-1);
  if (last?.kind === "thinking" && !finalizedThinking.has(last.key) && last.text === content) {
    last.at = event.at;
    finalizedThinking.add(last.key);
    return;
  }
  const key = `thinking-${event.seq}`;
  blocks.push({ key, kind: "thinking", text: content, at: event.at });
  finalizedThinking.add(key);
}

/** New runs emit one agent.thinking; older runs logged each thinking_delta. */
function thinkingContent(data: Record<string, unknown>): string | null {
  if (data.event === "agent.thinking") return String(data.content ?? "");
  if (data.event === "agent.message_update" && data.updateType === "thinking_delta") {
    return String(data.delta ?? "");
  }
  return null;
}

function foldThinking(
  blocks: FlatBlock[],
  finalizedThinking: Set<string>,
  content: string,
  event: RunEvent,
): void {
  if (!content) return;
  const last = blocks.at(-1);
  if (last?.kind === "thinking" && !finalizedThinking.has(last.key)) {
    last.text += content;
    last.at = event.at;
    return;
  }
  blocks.push({ key: `thinking-${event.seq}`, kind: "thinking", text: content, at: event.at });
}

function logText(data: Record<string, unknown>): string {
  const named = data.event ?? data.message;
  // Usage telemetry repeats after every step; the raw stream link keeps it.
  if (named === "agent.turn_end") return "";
  if (!named)
    return Object.entries(data)
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ");
  const details = Object.entries(data)
    .filter(([key, value]) => key !== "event" && value !== null && value !== "")
    .map(([key, value]) => `${key}=${format(value)}`);
  return details.length ? `${String(named)} ${details.join(" ")}` : String(named);
}

function format(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
