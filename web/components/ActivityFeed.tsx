"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, RunStatus } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/format";
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

/* ── Block types ─────────────────────────────────────────────────────────── */

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
    if (e.type === "subagent_event") {
      const d = e.data || {};
      const sid = String(d.subagent_session_id ?? "");
      const innerType = String(d.event_type ?? "");
      if (innerType === "start" || innerType === "done") continue;

      if (selectedSubagentId) {
        if (sid !== selectedSubagentId) continue;
        foldInnerEvent(innerType, d, blocks, toolByCall, showLogs);
      }
      continue;
    }

    if (selectedSubagentId) continue;

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
    case "read": return a.filePath || a.path || "";
    case "edit":
    case "write": return a.filePath || a.path || "";
    case "bash": return a.command || a.cmd || "";
    case "grep": return a.pattern ? `"${a.pattern}"` : "";
    case "glob": return a.pattern || "";
    case "list": return a.path || "";
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
      <div className="flex h-full items-center justify-center py-20">
        <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
          {active ? "waiting for agent…" : "no activity recorded"}
        </p>
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
      const k = block.status as string;
      return (
        <div className="flex items-center gap-3 py-1.5">
          <span className="h-px flex-1 bg-[var(--color-line)]" />
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: `var(--status-${k}-dot)` }}
            />
            {STATUS_LABELS[block.status] ?? block.status}
            {block.error ? ` — ${block.error}` : ""}
          </span>
          <span className="h-px flex-1 bg-[var(--color-line)]" />
        </div>
      );
    }
    case "finding": {
      const severity = block.severity;
      const severityColor =
        severity === "blocker"
          ? "border-red-500/40 text-red-400"
          : severity === "warning"
          ? "border-amber-500/40 text-amber-400"
          : "border-[var(--color-line-strong)] text-[var(--color-muted)]";
      const severityMark =
        severity === "blocker" ? "!!" : severity === "warning" ? "!" : "·";

      return (
        <div className={`activity-card mb-2 border-l-2 px-3.5 py-2.5 ${severityColor}`}>
          <div className="flex items-start gap-2">
            <span className="mt-px shrink-0 font-mono text-[11px]">{severityMark}</span>
            <div>
              <div className="text-[13px] font-medium text-[var(--color-ink)]">{block.title}</div>
              {block.file && (
                <div className="mt-0.5 font-mono text-[10px] text-[var(--color-faint)]">
                  {block.file}{block.line != null ? `:${block.line}` : ""}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }
    case "error":
      return (
        <div className="mb-2 border border-red-500/30 bg-red-500/8 px-3.5 py-2.5 font-mono text-[12px] text-red-400">
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
      <span className="flex h-3 w-3 shrink-0 items-center justify-center">
        {failed ? (
          <span className="font-mono text-[10px] text-red-400">✕</span>
        ) : done ? (
          <span className="font-mono text-[10px] text-emerald-400">✓</span>
        ) : (
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-blue)]" />
        )}
      </span>
      <span className="font-mono text-[11px] font-medium text-[var(--color-muted)] uppercase tracking-wide">
        {verb}
      </span>
      {summary && (
        <code className="activity-row-code">{summary}</code>
      )}
      {running && (
        <span className="font-mono text-[10px] text-[var(--color-faint)]">running…</span>
      )}
      {failed && (
        <span className="font-mono text-[10px] text-red-400">failed</span>
      )}
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
    <div className="activity-row" style={{ borderLeft: "2px solid var(--color-blue)" }}>
      <span className="flex h-3 w-3 shrink-0 items-center justify-center">
        {failed ? (
          <span className="font-mono text-[10px] text-red-400">✕</span>
        ) : done ? (
          <span className="font-mono text-[10px] text-emerald-400">✓</span>
        ) : (
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-[var(--color-blue)]" />
        )}
      </span>
      <span className="font-mono text-[11px] font-medium text-[var(--color-blue)] uppercase tracking-wide">
        task
      </span>
      {desc && (
        <span className="activity-row-code max-w-xs truncate">{desc}</span>
      )}
      {running && (
        <span className="font-mono text-[10px] text-[var(--color-faint)]">running…</span>
      )}
      {failed && (
        <span className="font-mono text-[10px] text-red-400">failed</span>
      )}
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
