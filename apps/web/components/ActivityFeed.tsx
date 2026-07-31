"use client";

import type { RunEvent, RunStatus } from "@pi-cloud-agent/protocol";
import {
  CheckIcon,
  CircleIcon,
  FileTextIcon,
  FolderSearchIcon,
  LoaderCircleIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo } from "react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { STATUS_LABELS } from "@/lib/format";

type ToolBlock = {
  key: string;
  kind: "tool";
  tool: string;
  args: Record<string, unknown>;
  status: string;
  callId: string;
};

type Block = { key: string } & (
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | ToolBlock
  | { kind: "log"; text: string }
  | { kind: "status"; status: RunStatus; error?: string | null }
);

function foldEvents(events: RunEvent[], userPrompt: string | null): Block[] {
  const blocks: Block[] = userPrompt ? [{ key: "prompt", kind: "user", text: userPrompt }] : [];
  const tools = new Map<string, ToolBlock>();
  for (const event of events) foldEvent(blocks, tools, event);
  return blocks.filter((block) => block.kind !== "assistant" || block.text.trim());
}

function foldEvent(blocks: Block[], tools: Map<string, ToolBlock>, event: RunEvent): void {
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

function foldToken(blocks: Block[], event: RunEvent): void {
  const content = String(event.data?.content ?? "");
  const last = blocks.at(-1);
  if (!content) return;
  if (last?.kind === "assistant") last.text += content;
  else blocks.push({ key: `assistant-${event.seq}`, kind: "assistant", text: content });
}

function foldTool(blocks: Block[], tools: Map<string, ToolBlock>, event: RunEvent): void {
  const callId = String(event.data?.callId ?? "");
  const existing = callId ? tools.get(callId) : undefined;
  if (existing) {
    existing.status = String(event.data?.status ?? existing.status);
    return;
  }
  const block: ToolBlock = {
    key: `tool-${callId || event.seq}`,
    kind: "tool",
    tool: String(event.data?.tool ?? "tool"),
    args: (event.data?.args as Record<string, unknown>) ?? {},
    status: String(event.data?.status ?? "running"),
    callId,
  };
  if (callId) tools.set(callId, block);
  blocks.push(block);
}

function foldStatus(blocks: Block[], event: RunEvent): void {
  const detail = String(event.data?.detail ?? "");
  blocks.push({
    key: `status-${event.seq}`,
    kind: "status",
    status: event.data?.status === "done" ? "succeeded" : "failed",
    error: detail || null,
  });
}

function foldLog(blocks: Block[], event: RunEvent): void {
  const text = logText(event.data ?? {});
  if (text) blocks.push({ key: `log-${event.seq}`, kind: "log", text });
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

  return (
    <div className="flex flex-col gap-7">
      {blocks.map((block) => (
        <BlockView key={block.key} block={block} />
      ))}
      {active && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          Pi is working…
        </div>
      )}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
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
  if (block.kind === "tool") return <ToolLine block={block} />;
  if (block.kind === "log") return <LogRow text={block.text} />;
  return (
    <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        <CircleIcon className="size-2.5" fill={`var(--status-${block.status}-dot)`} />
        {STATUS_LABELS[block.status]}
        {block.error ? ` · ${block.error}` : ""}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function ToolLine({ block }: { block: ToolBlock }) {
  const failed = block.status === "error";
  const running = block.status !== "completed" && !failed;
  const summary = toolSummary(block.tool, block.args);
  const Icon = toolIcon(block.tool);
  return (
    <details className="activity-line group">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-1.5 text-[13px] text-muted-foreground">
        {running ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
        ) : failed ? (
          <CircleIcon className="size-2.5 shrink-0 fill-destructive text-destructive" />
        ) : (
          <Icon className="size-3.5 shrink-0" />
        )}
        <span className="shrink-0 font-medium text-foreground/75">{toolVerb(block.tool)}</span>
        {summary && <span className="truncate text-muted-foreground/75">{summary}</span>}
        <span className="ml-auto hidden shrink-0 text-[11px] text-muted-foreground/50 group-open:block">
          hide details
        </span>
      </summary>
      <pre className="ml-5 max-h-64 overflow-auto whitespace-pre-wrap py-2 pl-0 font-mono text-[11px] leading-5 text-muted-foreground/70">
        {JSON.stringify(block.args, null, 2)}
      </pre>
    </details>
  );
}

function LogRow({ text }: { text: string }) {
  const label = text.length > 96 ? `${text.slice(0, 93)}…` : text;
  return (
    <details className="activity-line group">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-[13px] text-muted-foreground">
        <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
        <span className="truncate text-muted-foreground/80">{label}</span>
      </summary>
      {label !== text && (
        <pre className="ml-5 overflow-x-auto whitespace-pre-wrap py-2 font-mono text-[11px] leading-5 text-muted-foreground/70">
          {text}
        </pre>
      )}
    </details>
  );
}

const TOOL_VERBS: Record<string, string> = {
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  bash: "Ran",
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

function toolIcon(tool: string) {
  switch (tool.toLowerCase()) {
    case "read":
      return FileTextIcon;
    case "edit":
    case "write":
      return PencilIcon;
    case "bash":
      return TerminalIcon;
    case "grep":
      return SearchIcon;
    case "glob":
    case "list":
      return FolderSearchIcon;
    default:
      return WrenchIcon;
  }
}

function Empty({ active }: { active: boolean }) {
  return (
    <div className="grid min-h-72 place-items-center text-sm text-muted-foreground">
      {active ? "Waiting for Pi’s first event…" : "No activity was recorded."}
    </div>
  );
}
