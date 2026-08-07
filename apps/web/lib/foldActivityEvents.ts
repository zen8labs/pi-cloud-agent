"use client";

import {
  interpretRunEvents,
  type RunEvent,
  type RunStatus,
  type TimelineEvent,
} from "@pi-cloud-agent/protocol";
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

type FoldState = {
  assistantStartIndexes: Map<number, number>;
};

export function foldEvents(events: RunEvent[], userPrompt: string | null): ActivityBlock[] {
  const flat: FlatBlock[] = userPrompt
    ? [{ key: "prompt", kind: "user", text: userPrompt }]
    : [];
  const tools = new Map<string, ToolLine>();
  const state: FoldState = { assistantStartIndexes: new Map() };
  for (const event of interpretRunEvents(events)) foldEvent(flat, tools, state, event);
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
  state: FoldState,
  event: TimelineEvent,
): void {
  switch (event.kind) {
    case "token":
      foldToken(blocks, state, event);
      break;
    case "tool":
      foldTool(blocks, tools, event);
      break;
    case "status":
      foldStatus(blocks, event);
      break;
    case "turn":
      foldTurnThinking(blocks, state, event);
      break;
    case "log":
      foldLog(blocks, event);
      break;
    case "other":
      foldOther(blocks, event);
      break;
  }
}

function foldToken(
  blocks: FlatBlock[],
  state: FoldState,
  event: Extract<TimelineEvent, { kind: "token" }>,
): void {
  const { content, turnNumber } = event;
  const last = blocks.at(-1);
  if (!content) return;
  if (last?.kind === "assistant" && state.assistantStartIndexes.has(turnNumber)) {
    last.text += content;
  } else {
    if (!state.assistantStartIndexes.has(turnNumber)) {
      state.assistantStartIndexes.set(turnNumber, blocks.length);
    }
    blocks.push({ key: `assistant-${event.seq}`, kind: "assistant", text: content });
  }
}

function foldTool(
  blocks: FlatBlock[],
  tools: Map<string, ToolLine>,
  event: Extract<TimelineEvent, { kind: "tool" }>,
): void {
  const { callId } = event;
  const output = toolOutput(event.output);
  const existing = callId ? tools.get(callId) : undefined;
  if (existing) {
    existing.status = event.status || existing.status;
    existing.at = event.at;
    if (output !== null) existing.output = output;
    return;
  }
  const block: ToolLine = {
    key: `tool-${callId || event.seq}`,
    kind: "tool",
    tool: event.tool,
    args: (event.args as Record<string, unknown>) ?? {},
    status: event.status,
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
function foldStatus(
  blocks: FlatBlock[],
  event: Extract<TimelineEvent, { kind: "status" }>,
): void {
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

function foldLog(blocks: FlatBlock[], event: Extract<TimelineEvent, { kind: "log" }>): void {
  if (event.name.startsWith("agent.")) return;
  const text = logText(event.data);
  if (text) blocks.push({ key: `log-${event.seq}`, kind: "log", text, at: event.at });
}

function foldOther(
  blocks: FlatBlock[],
  event: Extract<TimelineEvent, { kind: "other" }>,
): void {
  const text = logText(event.data);
  if (text) blocks.push({ key: `log-${event.seq}`, kind: "log", text, at: event.at });
}

function foldTurnThinking(
  blocks: FlatBlock[],
  state: FoldState,
  event: Extract<TimelineEvent, { kind: "turn" }>,
): void {
  const assistantStartIndex = state.assistantStartIndexes.get(event.turnNumber);
  state.assistantStartIndexes.delete(event.turnNumber);
  if (!event.thinking) return;

  const block: FlatBlock = {
    key: `thinking-${event.seq}`,
    kind: "thinking",
    text: event.thinking,
    at: event.at,
  };
  if (assistantStartIndex === undefined) blocks.push(block);
  else blocks.splice(assistantStartIndex, 0, block);
}

function logText(data: Record<string, unknown>): string {
  const named = data.event ?? data.message;
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
