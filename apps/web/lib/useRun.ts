"use client";

import type { RunDetail, RunEvent, RunStatus } from "@pi-cloud-agent/protocol";
import { useEffect, useState } from "react";
import { api, streamUrl } from "./api";

/** Event types the controller streams as agent activity. Each carries `id: seq`. */
const FEED_EVENTS = ["token", "tool_call", "log"] as const;

/**
 * Mutable state shared by the stream handlers of one effect run. Created fresh
 * per subscription, so a remount or a new run id never sees stale dedupe state.
 */
type StreamCtx = {
  alive: boolean;
  // Dedupe by sequence number. More than one EventSource can briefly overlap —
  // React strict mode double-invokes effects, and a reconnect replays — and seq
  // is unique per run, so this is exact rather than heuristic.
  seen: Set<number>;
  liveStatus: RunStatus | null;
  setEvents: React.Dispatch<React.SetStateAction<RunEvent[]>>;
  setRun: React.Dispatch<React.SetStateAction<RunDetail | null>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
};

/** A malformed frame carries no payload; it should not break the feed. */
function parseFrameData(raw: MessageEvent): Record<string, unknown> {
  try {
    return JSON.parse(raw.data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function feedHandler(type: RunEvent["type"], ctx: StreamCtx) {
  return (raw: MessageEvent) => {
    if (!ctx.alive) return;
    const seq = raw.lastEventId ? Number(raw.lastEventId) : 0;
    if (ctx.seen.has(seq)) return;
    ctx.seen.add(seq);
    const data = parseFrameData(raw);
    ctx.setEvents((prev) => [...prev, { seq, type, data, at: new Date().toISOString() }]);
  };
}

function statusHandler(ctx: StreamCtx) {
  return (raw: MessageEvent) => {
    if (!ctx.alive) return;
    const data = parseFrameData(raw) as { status?: RunStatus; error?: string | null };
    // An unparseable status frame is ignored; the next one supersedes it.
    if (!data.status) return;
    ctx.liveStatus = data.status;
    const { status, error } = data;
    ctx.setRun((prev) => (prev ? { ...prev, status, error: error ?? prev.error } : prev));
  };
}

/**
 * SSE reserves the name "error" for both meanings. A server-sent agent error is
 * a MessageEvent *with* data; a dropped connection is a bare Event with none —
 * and that one just means EventSource is reconnecting, which it will do from
 * Last-Event-ID.
 */
function errorHandler(ctx: StreamCtx, source: EventSource) {
  return (raw: Event) => {
    if (!ctx.alive) return;
    const body = (raw as MessageEvent).data;
    if (!body) return;
    const data = parseFrameData(raw as MessageEvent);
    if (data.message === "run not found") {
      ctx.setError("run not found");
      source.close();
    }
  };
}

/**
 * A live view of one run over a resumable stream.
 *
 * The browser's `EventSource` holds the connection and reconnects on its own;
 * because every frame is tagged with the event log's sequence number, a reconnect
 * resumes from the exact last-seen event through the standard `Last-Event-ID`
 * header. The append-only log is the source of truth, so a fresh page load
 * replays the full history and then tails — one code path, not two.
 */
/** REST fetch of the run row; the stream's status wins where both have one. */
function detailLoader(id: string, ctx: StreamCtx) {
  return async () => {
    try {
      const detail = await api.getRun(id);
      if (!ctx.alive) return;
      ctx.setRun({ ...detail, status: ctx.liveStatus ?? detail.status });
    } catch (cause) {
      if (ctx.alive) ctx.setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
}

export function useRun(id: string) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctx: StreamCtx = {
      alive: true,
      seen: new Set(),
      liveStatus: null,
      setEvents,
      setRun,
      setError,
    };
    setEvents([]);
    setRun(null);
    setError(null);

    const loadDetail = detailLoader(id, ctx);
    void loadDetail();

    const source = new EventSource(streamUrl(id));
    for (const type of FEED_EVENTS) source.addEventListener(type, feedHandler(type, ctx));
    source.addEventListener("status", statusHandler(ctx));
    source.addEventListener("end", () => {
      void loadDetail();
      source.close();
    });
    source.addEventListener("error", errorHandler(ctx, source));

    return () => {
      ctx.alive = false;
      source.close();
    };
  }, [id]);

  return { run, events, error };
}
