"use client";

import type { RunEvent, RunStatus } from "@pi-cloud-agent/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { STATUS_LABELS } from "@/lib/format";

/**
 * Fold an append-only event log into something readable.
 *
 * The log is the source of truth and it is flat, so this is where it becomes a
 * conversation: token events coalesce into one assistant message, and the two
 * halves of a tool call (start, then end) merge into a single row by call id.
 */

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

/**
 * Keys come from the event log rather than from array position, so a block keeps
 * its identity as later events stream in and React does not remount a growing
 * assistant message on every token.
 */
function blockKey(block: Block): string {
  return block.key;
}

function foldEvents(events: RunEvent[], userPrompt: string | null): Block[] {
  const blocks: Block[] = [];
  if (userPrompt) blocks.push({ key: "prompt", kind: "user", text: userPrompt });
  const toolByCall = new Map<string, ToolBlock>();

  for (const event of events) {
    const data = event.data ?? {};
    switch (event.type) {
      case "token": {
        const content = String(data.content ?? "");
        if (!content) break;
        const last = blocks.at(-1);
        if (last?.kind === "assistant") last.text += content;
        else blocks.push({ key: `assistant-${event.seq}`, kind: "assistant", text: content });
        break;
      }
      case "tool_call": {
        const callId = String(data.callId ?? "");
        const args = (data.args as Record<string, unknown>) ?? {};
        const status = String(data.status ?? "");
        const existing = callId ? toolByCall.get(callId) : undefined;
        if (existing) {
          // The end event carries no args, so keep the ones from the start.
          existing.status = status;
          break;
        }
        const block: ToolBlock = {
          key: `tool-${callId || event.seq}`,
          kind: "tool",
          tool: String(data.tool ?? "tool"),
          args,
          status,
          callId,
        };
        if (callId) toolByCall.set(callId, block);
        blocks.push(block);
        break;
      }
      case "status": {
        const detail = String(data.detail ?? "");
        blocks.push({
          key: `status-${event.seq}`,
          kind: "status",
          status: data.status === "done" ? "succeeded" : "failed",
          error: detail || null,
        });
        break;
      }
      default: {
        const text = logText(data);
        if (text) blocks.push({ key: `log-${event.seq}`, kind: "log", text });
        break;
      }
    }
  }

  return blocks.filter((block) => block.kind !== "assistant" || block.text.trim().length > 0);
}

function logText(data: Record<string, unknown>): string {
  const named = data.event ?? data.message;
  if (named) {
    const rest = Object.entries(data)
      .filter(([key, value]) => key !== "event" && value !== null && value !== "")
      .map(([key, value]) => `${key}=${format(value)}`);
    return rest.length > 0 ? `${String(named)} ${rest.join(" ")}` : String(named);
  }
  const keys = Object.keys(data);
  return keys.length > 0 ? keys.map((key) => `${key}=${format(data[key])}`).join(" ") : "";
}

function format(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Collapse a long log line to its leading event name, keeping detail on demand. */
function logLabel(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 56) return trimmed;
  const eventToken = trimmed.match(/^[\w.]+/)?.[0];
  if (eventToken?.includes(".")) return eventToken;
  return `${trimmed.slice(0, 53)}…`;
}

const TOOL_VERB: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  bash: "Run",
  grep: "Search",
  glob: "Glob",
  list: "List",
};

function toolSummary(tool: string, args: Record<string, unknown>): string {
  const values = args as Record<string, string>;
  switch (tool) {
    case "read":
    case "edit":
    case "write":
      return values.filePath || values.path || "";
    case "bash":
      return values.command || values.cmd || "";
    case "grep":
      return values.pattern ? `"${values.pattern}"` : "";
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
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the tail as new blocks arrive. The count is the trigger, not a value
  // the effect reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: block count is the trigger
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [blocks.length]);

  if (blocks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center py-20">
        <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
          {active ? "waiting for the agent…" : "no activity recorded"}
        </p>
      </div>
    );
  }

  return (
    <div className="message-stream flex flex-col">
      {blocks.map((block) => (
        <BlockView key={blockKey(block)} block={block} />
      ))}
      {active && <Working />}
      <div ref={endRef} />
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "user":
      return (
        <div className="message-user">
          <div className="message-user-bubble">{block.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="message-assistant">
          <MarkdownMessage content={block.text} />
        </div>
      );
    case "tool":
      return <ToolRow block={block} />;
    case "log":
      return <CollapsibleLog text={block.text} />;
    case "status":
      return (
        <div className="flex items-center gap-3 py-1.5">
          <span className="h-px flex-1 bg-[var(--color-line)]" />
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: `var(--status-${block.status}-dot)` }}
            />
            {STATUS_LABELS[block.status]}
            {block.error ? ` — ${block.error}` : ""}
          </span>
          <span className="h-px flex-1 bg-[var(--color-line)]" />
        </div>
      );
  }
}

function CollapsibleLog({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const label = logLabel(text);

  if (label === text) {
    return (
      <div className="activity-row activity-row--log">
        <span className="activity-row-text">{text}</span>
      </div>
    );
  }

  return (
    <div className="activity-row activity-row--log">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="activity-row-toggle"
        aria-expanded={open}
      >
        <Chevron open={open} />
        <span className="activity-row-label">{label}</span>
      </button>
      {open && <pre className="activity-row-detail">{text}</pre>}
    </div>
  );
}

function ToolRow({ block }: { block: ToolBlock }) {
  const verb = TOOL_VERB[block.tool] ?? block.tool;
  const summary = toolSummary(block.tool, block.args);
  const failed = block.status === "error";
  const done = block.status === "completed";

  return (
    <div className="activity-row">
      <span className="flex h-3 w-3 shrink-0 items-center justify-center">
        {failed ? (
          <span className="font-mono text-[10px] text-red-400">✕</span>
        ) : done ? (
          <span className="font-mono text-[10px] text-emerald-400">✓</span>
        ) : (
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-blue)]" />
        )}
      </span>
      <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {verb}
      </span>
      {summary && <code className="activity-row-code">{summary}</code>}
      {!done && !failed && (
        <span className="font-mono text-[10px] text-[var(--color-faint)]">running…</span>
      )}
      {failed && <span className="font-mono text-[10px] text-red-400">failed</span>}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`activity-chevron ${open ? "activity-chevron--open" : ""}`}
      aria-hidden="true"
    >
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Working() {
  return (
    <div className="activity-row">
      <span className="flex items-center gap-1">
        <span className="h-1 w-1 animate-pulse-dot rounded-full bg-[var(--color-faint)]" />
        <span className="h-1 w-1 animate-pulse-dot rounded-full bg-[var(--color-faint)] [animation-delay:0.2s]" />
        <span className="h-1 w-1 animate-pulse-dot rounded-full bg-[var(--color-faint)] [animation-delay:0.4s]" />
      </span>
      <span className="font-mono text-[10px] text-[var(--color-faint)]">working…</span>
    </div>
  );
}
