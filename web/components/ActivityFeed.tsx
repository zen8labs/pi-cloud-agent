"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, RunStatus } from "@/lib/types";
import { STATUS_META } from "@/lib/format";
import { MarkdownMessage } from "@/components/MarkdownMessage";

/* ── Subagent session model ──────────────────────────────────────────────── */

export type SubagentSession = {
  sessionId: string;
  description: string;
  status: "running" | "done";
};

export function extractSubagents(events: AgentEvent[]): SubagentSession[] {
  const sessions = new Map<string, SubagentSession>();
  for (const e of events) {
    if (e.type !== "subagent_event") continue;
    const d = e.data || {};
    const sid = String(d.subagent_session_id ?? "");
    if (!sid) continue;
    const eventType = String(d.event_type ?? "");
    if (eventType === "start") {
      sessions.set(sid, {
        sessionId: sid,
        description: String(d.task_description ?? `Task ${sessions.size + 1}`),
        status: "running",
      });
    } else if (eventType === "done") {
      const existing = sessions.get(sid);
      if (existing) existing.status = "done";
    }
  }
  return Array.from(sessions.values());
}

/* ── Fold the flat event log into renderable blocks ──────────────────────── */

type ToolBlock = {
  kind: "tool";
  tool: string;
  args: Record<string, unknown>;
  status: string;
  callId: string;
  isTask?: boolean;
};

type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | ToolBlock
  | { kind: "log"; text: string }
  | { kind: "status"; status: RunStatus; error?: string | null }
  | { kind: "finding"; severity: string; title: string; file: string; line: number | null }
  | { kind: "error"; text: string };

function foldEvents(
  events: AgentEvent[],
  userPrompt: string | null,
  showLogs: boolean,
  selectedSubagentId: string | null,
): Block[] {
  const blocks: Block[] = [];
  if (!selectedSubagentId && userPrompt) blocks.push({ kind: "user", text: userPrompt });
  const toolByCall = new Map<string, ToolBlock>();

  for (const e of events) {
    // ── Subagent event routing ───────────────────────────────────────────
    if (e.type === "subagent_event") {
      const d = e.data || {};
      const sid = String(d.subagent_session_id ?? "");
      const innerType = String(d.event_type ?? "");
      if (innerType === "start" || innerType === "done") continue;

      if (selectedSubagentId) {
        // In subagent view: only show this subagent's events.
        if (sid !== selectedSubagentId) continue;
        foldInnerEvent(innerType, d, blocks, toolByCall, showLogs);
      }
      // In main view: task tool_calls already represent the subagent — skip inner events.
      continue;
    }

    // ── Main session events ──────────────────────────────────────────────
    if (selectedSubagentId) continue; // main-session events hidden in subagent view

    const d = e.data || {};
    switch (e.type) {
      case "token": {
        const content = String(d.content ?? "");
        if (!content) break;
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "assistant") last.text += content;
        else blocks.push({ kind: "assistant", text: content });
        break;
      }
      case "tool_call": {
        const callId = String(d.callId ?? "");
        const args = (d.args as Record<string, unknown>) || {};
        const status = String(d.status ?? "");
        const isTask = String(d.tool ?? "") === "task";
        const existing = callId ? toolByCall.get(callId) : undefined;
        if (existing) {
          existing.status = status;
          if (Object.keys(args).length) existing.args = args;
          break;
        }
        const block: ToolBlock = {
          kind: "tool",
          tool: String(d.tool ?? "tool"),
          args,
          status,
          callId,
          isTask,
        };
        if (callId) toolByCall.set(callId, block);
        blocks.push(block);
        break;
      }
      case "finding": {
        blocks.push({
          kind: "finding",
          severity: String(d.severity ?? "nit"),
          title: String(d.title ?? "Finding"),
          file: String(d.file ?? ""),
          line: (d.line as number) ?? null,
        });
        break;
      }
      case "status": {
        const s = String(d.status ?? "") as RunStatus;
        if (s) blocks.push({ kind: "status", status: s, error: d.error as string | null });
        break;
      }
      case "error": {
        blocks.push({ kind: "error", text: String(d.message ?? d.error ?? "error") });
        break;
      }
      case "done":
      case "end":
        break;
      case "log":
      default: {
        const text = logText(d);
        if (!text) break;
        if (!showLogs && isVerbose(text)) break;
        blocks.push({ kind: "log", text });
        break;
      }
    }
  }
  return blocks.filter((b) => b.kind !== "assistant" || b.text.trim().length > 0);
}

function foldInnerEvent(
  innerType: string,
  d: Record<string, unknown>,
  blocks: Block[],
  toolByCall: Map<string, ToolBlock>,
  showLogs: boolean,
): void {
  switch (innerType) {
    case "token": {
      const content = String(d.content ?? "");
      if (!content) return;
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "assistant") last.text += content;
      else blocks.push({ kind: "assistant", text: content });
      return;
    }
    case "tool_call": {
      const callId = String(d.callId ?? "");
      const args = (d.args as Record<string, unknown>) || {};
      const status = String(d.status ?? "");
      const existing = callId ? toolByCall.get(callId) : undefined;
      if (existing) {
        existing.status = status;
        if (Object.keys(args).length) existing.args = args;
        return;
      }
      const block: ToolBlock = {
        kind: "tool",
        tool: String(d.tool ?? "tool"),
        args,
        status,
        callId,
      };
      if (callId) toolByCall.set(callId, block);
      blocks.push(block);
      return;
    }
    case "log": {
      const text = logText(d);
      if (!text || (!showLogs && isVerbose(text))) return;
      blocks.push({ kind: "log", text });
      return;
    }
    case "error": {
      blocks.push({ kind: "error", text: String(d.message ?? d.error ?? "error") });
      return;
    }
  }
}

function isVerbose(text: string): boolean {
  return text.includes("opencode.stdout");
}

function logText(d: Record<string, unknown>): string {
  const event = String(d.event ?? "");
  if (event === "step_start" || event === "step_finish") return "";
  const msg = d.message ?? d.event ?? d.line ?? d.text;
  if (msg) return String(msg);
  const keys = Object.keys(d);
  return keys.length ? keys.map((k) => `${k}=${fmt(d[k])}`).join(" ") : "";
}

function fmt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function logLabel(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 56 && !trimmed.includes(" run_id=")) return trimmed;

  const eventToken = trimmed.match(/^[\w.]+/)?.[0];
  if (eventToken && eventToken.includes(".") && trimmed.startsWith(eventToken)) {
    return eventToken;
  }

  if (trimmed.includes("=")) {
    const keys = trimmed.split(/\s+/).map((part) => part.split("=")[0]).filter(Boolean);
    if (keys.length <= 2) return keys.join(" · ");
    return `${keys[0]} · ${keys[1]} +${keys.length - 2}`;
  }

  return trimmed.length > 56 ? `${trimmed.slice(0, 53)}…` : trimmed;
}

function toolSummary(tool: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string>;
  switch (tool) {
    case "read":
      return a.filePath || a.path || "";
    case "edit":
    case "write":
      return a.filePath || a.path || "";
    case "bash":
      return a.command || a.cmd || "";
    case "grep":
      return a.pattern ? `"${a.pattern}"` : "";
    case "glob":
      return a.pattern || "";
    case "list":
      return a.path || "";
    default: {
      const first = Object.values(args)[0];
      return typeof first === "string" ? first : "";
    }
  }
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

/* ── Rendering ───────────────────────────────────────────────────────────── */

export function ActivityFeed({
  events,
  userPrompt,
  active,
  showLogs = false,
  selectedSubagentId = null,
}: {
  events: AgentEvent[];
  userPrompt: string | null;
  active: boolean;
  showLogs?: boolean;
  selectedSubagentId?: string | null;
}) {
  const blocks = useMemo(
    () => foldEvents(events, userPrompt, showLogs, selectedSubagentId),
    [events, userPrompt, showLogs, selectedSubagentId],
  );
  const endRef = useRef<HTMLDivElement>(null);
  const count = blocks.length;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [count]);

  if (blocks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-faint)]">
        {active ? "Waiting for the agent to start…" : "No activity recorded."}
      </div>
    );
  }

  return (
    <div className="message-stream flex flex-col">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
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
    case "status": {
      const meta = STATUS_META[block.status] ?? STATUS_META.queued;
      return (
        <div className="flex items-center justify-center gap-2 py-1">
          <span className="h-px w-8 bg-[var(--color-line)]" />
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-faint)]">
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
            {block.error ? ` — ${block.error}` : ""}
          </span>
          <span className="h-px w-8 bg-[var(--color-line)]" />
        </div>
      );
    }
    case "finding": {
      const icon =
        block.severity === "blocker" ? "🛑" : block.severity === "warning" ? "⚠️" : "💡";
      return (
        <div className="activity-card mb-2 px-3.5 py-2.5">
          <div className="flex items-start gap-2 text-sm">
            <span>{icon}</span>
            <div>
              <div className="font-medium">{block.title}</div>
              {block.file && (
                <div className="mt-0.5 font-mono text-[11px] text-[var(--color-faint)]">
                  {block.file}
                  {block.line != null ? `:${block.line}` : ""}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }
    case "error":
      return (
        <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {block.text}
        </div>
      );
  }
}

function CollapsibleLog({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const label = logLabel(text);
  const expandable = label !== text;

  if (!expandable) {
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
        onClick={() => setOpen((v) => !v)}
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
  if (block.isTask) return <TaskRow block={block} />;

  const verb = TOOL_VERB[block.tool] ?? block.tool;
  const summary = toolSummary(block.tool, block.args);
  const failed = block.status === "error";
  const done = block.status === "completed";
  const running = !done && !failed;

  return (
    <div className="activity-row">
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {failed ? (
          <span className="text-red-500">✕</span>
        ) : done ? (
          <span className="text-emerald-500">✓</span>
        ) : (
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-accent)]" />
        )}
      </span>
      <span className="font-medium text-[var(--color-ink)]">{verb}</span>
      {summary && (
        <code className="activity-row-code">{summary}</code>
      )}
      {failed && <span className="text-xs text-red-500">failed</span>}
      {running && <span className="text-[11px] text-[var(--color-faint)]">running…</span>}
    </div>
  );
}

function TaskRow({ block }: { block: ToolBlock }) {
  const desc = String(
    (block.args as Record<string, string>).description ||
      (block.args as Record<string, string>).prompt ||
      "",
  );
  const failed = block.status === "error";
  const done = block.status === "completed";
  const running = !done && !failed;

  return (
    <div className="activity-row activity-row--task">
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {failed ? (
          <span className="text-red-500">✕</span>
        ) : done ? (
          <span className="text-emerald-500">✓</span>
        ) : (
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-accent)]" />
        )}
      </span>
      <span className="font-medium text-[var(--color-ink)]">task</span>
      {desc && <span className="activity-row-code truncate max-w-xs">{desc}</span>}
      {running && <span className="text-[11px] text-[var(--color-faint)]">running…</span>}
      {failed && <span className="text-xs text-red-500">failed</span>}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`activity-chevron ${open ? "activity-chevron--open" : ""}`}
      aria-hidden
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
    <div className="activity-row text-[var(--color-faint)]">
      <span className="flex gap-1">
        <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-faint)]" />
        <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-faint)] [animation-delay:0.2s]" />
        <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-faint)] [animation-delay:0.4s]" />
      </span>
      working…
    </div>
  );
}
