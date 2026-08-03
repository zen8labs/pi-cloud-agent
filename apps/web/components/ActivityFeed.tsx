"use client";

import type { RunEvent, RunStatus } from "@pi-cloud-agent/protocol";
import { ChevronRightIcon, LoaderCircleIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useMemo } from "react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { ChangeStatsCard } from "@/components/ChangeStatsCard";
import { type FileChangeStat, fileChangeStats, ToolArgsView } from "@/components/ToolArgsView";
import { STATUS_LABELS } from "@/lib/format";

type ToolLine = {
  key: string;
  kind: "tool";
  tool: string;
  args: Record<string, unknown>;
  status: string;
  callId: string;
  output: string | null;
  at: string;
};

type LogLine = { key: string; kind: "log"; text: string; at: string };

type FlatBlock = { key: string } & (
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | ToolLine
  | LogLine
  | { kind: "status"; status: RunStatus; error?: string | null }
);

type WorkBlock = {
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

type Block = FlatBlock | WorkBlock | ChangesBlock;

function foldEvents(events: RunEvent[], userPrompt: string | null): Block[] {
  const flat: FlatBlock[] = userPrompt
    ? [{ key: "prompt", kind: "user", text: userPrompt }]
    : [];
  const tools = new Map<string, ToolLine>();
  for (const event of events) foldEvent(flat, tools, event);
  const visible = flat.filter((block) => block.kind !== "assistant" || block.text.trim());
  return appendChangeStats(groupWork(visible));
}

/** Aggregate write/edit tools into a trailing summary card for the turn. */
function appendChangeStats(blocks: Block[]): Block[] {
  const { files, createdOnly } = collectFileChanges(blocks);
  if (!files.length) return blocks;
  return [...blocks, { key: "changes", kind: "changes", files, createdOnly }];
}

function collectFileChanges(blocks: Block[]): {
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

function workTools(blocks: Block[]): ToolLine[] {
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
function groupWork(blocks: FlatBlock[]): Block[] {
  const grouped: Block[] = [];
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

function foldEvent(blocks: FlatBlock[], tools: Map<string, ToolLine>, event: RunEvent): void {
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
      foldLog(blocks, event);
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

function foldLog(blocks: FlatBlock[], event: RunEvent): void {
  const text = logText(event.data ?? {});
  if (text) blocks.push({ key: `log-${event.seq}`, kind: "log", text, at: event.at });
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

export function ActivityFeed({
  events,
  userPrompt,
  active,
}: {
  events: RunEvent[];
  userPrompt: string | null;
  active: boolean;
}) {
  const blocks = useMemo(() => foldEvents(events, userPrompt), [events, userPrompt]);
  if (!blocks.length) return <Empty active={active} />;

  // The trailing change-stats card is not live activity; stream state follows the block before it.
  let lastActivityIndex = blocks.length - 1;
  while (lastActivityIndex >= 0 && blocks[lastActivityIndex]?.kind === "changes") {
    lastActivityIndex -= 1;
  }

  return (
    <div className="flex flex-col gap-6">
      {blocks.map((block, index) => (
        <BlockView
          key={block.key}
          block={block}
          streaming={active && index === lastActivityIndex}
        />
      ))}
      {active && lastActivityIndex >= 0 && blocks[lastActivityIndex]?.kind !== "work" && (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Working…
        </div>
      )}
    </div>
  );
}

function BlockView({ block, streaming }: { block: Block; streaming: boolean }) {
  if (block.kind === "user") {
    return (
      <Message from="user">
        <MessageContent>{block.text}</MessageContent>
      </Message>
    );
  }
  if (block.kind === "assistant") {
    return (
      <Message from="assistant">
        <MessageContent>
          <MessageResponse>{block.text}</MessageResponse>
        </MessageContent>
      </Message>
    );
  }
  if (block.kind === "work") return <WorkGroup block={block} streaming={streaming} />;
  if (block.kind === "changes") {
    return <ChangeStatsCard files={block.files} createdOnly={block.createdOnly} />;
  }
  if (block.kind === "status") return <StatusDivider block={block} />;
  return null;
}

function WorkGroup({ block, streaming }: { block: WorkBlock; streaming: boolean }) {
  if (streaming) {
    return (
      <div>
        <div className="flex items-center gap-2 py-1 text-[13px] text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Working…
        </div>
        <WorkLines items={block.items} />
      </div>
    );
  }
  return (
    <details className="activity-line group">
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        Worked for {workDuration(block.startedAt, block.endedAt)}
      </summary>
      <WorkLines items={block.items} />
    </details>
  );
}

function WorkLines({ items }: { items: (ToolLine | LogLine)[] }) {
  return (
    <div className="ml-[7px] mt-1 flex flex-col border-l border-border/70 pl-3.5">
      {items.map((item) =>
        item.kind === "tool" ? (
          <ToolRow key={item.key} block={item} />
        ) : (
          <LogRow key={item.key} text={item.text} />
        ),
      )}
    </div>
  );
}

function ToolRow({ block }: { block: ToolLine }) {
  const failed = block.status === "error";
  const running = block.status !== "completed" && !failed;
  const summary = toolSummary(block.tool, block.args);
  const shell = isShellTool(block.tool);
  const label = (
    <>
      <span className="shrink-0 font-medium text-foreground/85">{toolVerb(block.tool)}</span>
      {summary ? (
        <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
      ) : null}
    </>
  );

  // Read already shows the path in the summary; expanding only repeats it as JSON.
  if (block.tool.toLowerCase() === "read") {
    return (
      <div className="flex min-w-0 items-center gap-1.5 py-1 text-[13px]">
        {running ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <XIcon className="size-3.5 shrink-0 text-[var(--status-failed)]" />
        ) : (
          <span className="size-3.5 shrink-0" aria-hidden />
        )}
        {label}
      </div>
    );
  }

  return (
    <details className="activity-line group/line">
      <summary className="flex min-w-0 cursor-pointer list-none select-none items-center gap-1.5 py-1 text-[13px]">
        {running ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <XIcon className="size-3.5 shrink-0 text-[var(--status-failed)]" />
        ) : shell ? (
          <SquareTerminalIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-open/line:rotate-90" />
        )}
        {label}
      </summary>
      <div className="py-1.5">
        <ToolArgsView tool={block.tool} args={block.args} output={block.output} />
      </div>
    </details>
  );
}

function isShellTool(tool: string): boolean {
  const name = tool.toLowerCase();
  return name === "bash" || name === "shell";
}

function LogRow({ text }: { text: string }) {
  const truncated = text.length > 110;
  const label = truncated ? `${text.slice(0, 107)}…` : text;
  if (!truncated) {
    return <p className="truncate py-1 font-mono text-xs text-muted-foreground/80">{label}</p>;
  }
  return (
    <details className="activity-line group/line">
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 py-1">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-open/line:rotate-90" />
        <span className="truncate font-mono text-xs text-muted-foreground/80">{label}</span>
      </summary>
      <pre className="ml-5 overflow-x-auto whitespace-pre-wrap py-1.5 font-mono text-[11px] leading-5 text-muted-foreground/80">
        {text}
      </pre>
    </details>
  );
}

function StatusDivider({ block }: { block: FlatBlock & { kind: "status" } }) {
  return (
    <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border/70" />
      <span className="flex items-center gap-1.5">
        <span
          className="size-1.5 rounded-full"
          style={{ background: `var(--status-${block.status})` }}
        />
        <span className="font-medium" style={{ color: `var(--status-${block.status})` }}>
          {STATUS_LABELS[block.status]}
        </span>
        {block.error ? <span>· {block.error}</span> : null}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function workDuration(startIso: string, endIso: string): string {
  const ms = Math.max(0, Date.parse(endIso) - Date.parse(startIso));
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const TOOL_VERBS: Record<string, string> = {
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  bash: "Ran",
  shell: "Ran",
  grep: "Searched",
  glob: "Found files",
  list: "Listed",
};

function toolVerb(tool: string): string {
  return TOOL_VERBS[tool.toLowerCase()] ?? tool;
}

function toolSummary(tool: string, args: Record<string, unknown>): string {
  const values = args as Record<string, string>;
  switch (tool.toLowerCase()) {
    case "read":
    case "edit":
    case "write":
      return values.filePath || values.path || "";
    case "bash":
    case "shell":
      return values.command || values.cmd || "";
    case "grep":
      return values.pattern ? `for “${values.pattern}”` : "";
    case "glob":
      return values.pattern || "";
    case "list":
      return values.path || "";
    default: {
      const first = Object.values(args)[0];
      return typeof first === "string" ? first : "";
    }
  }
}

function Empty({ active }: { active: boolean }) {
  return (
    <div className="grid min-h-72 place-items-center text-sm text-muted-foreground">
      {active ? "Waiting for Pi’s first event…" : "No activity was recorded."}
    </div>
  );
}
