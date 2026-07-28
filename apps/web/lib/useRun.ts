"use client";

import type { RunDetail, RunEvent, RunStatus } from "@pi-cloud-agent/protocol";
import { useEffect, useRef, useState } from "react";
import { api, streamUrl } from "./api";

/** Event types the controller streams as agent activity. Each carries `id: seq`. */
const FEED_EVENTS = ["token", "tool_call", "log"] as const;

/**
 * A live view of one run over a resumable stream.
 *
 * The browser's `EventSource` holds the connection and reconnects on its own;
 * because every frame is tagged with the event log's sequence number, a reconnect
 * resumes from the exact last-seen event through the standard `Last-Event-ID`
 * header. The append-only log is the source of truth, so a fresh page load
 * replays the full history and then tails — one code path, not two.
 */
export function useRun(id: string) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const liveStatus = useRef<RunStatus | null>(null);
  // Dedupe by sequence number. More than one EventSource can briefly overlap —
  // React strict mode double-invokes effects, and a reconnect replays — and seq
  // is unique per run, so this is exact rather than heuristic.
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    let alive = true;
    liveStatus.current = null;
    seen.current = new Set();
    setEvents([]);
    setRun(null);
    setError(null);

    const loadDetail = async () => {
      try {
        const detail = await api.getRun(id);
        if (!alive) return;
        // The stream is ahead of REST for status, so it wins where both have it.
        setRun({ ...detail, status: liveStatus.current ?? detail.status });
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void loadDetail();

    const source = new EventSource(streamUrl(id));

    const append = (type: RunEvent["type"]) => (raw: MessageEvent) => {
      if (!alive) return;
      const seq = raw.lastEventId ? Number(raw.lastEventId) : 0;
      if (seen.current.has(seq)) return;
      seen.current.add(seq);
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(raw.data);
      } catch {
        // A malformed frame should not break the feed.
      }
      setEvents((prev) => [...prev, { seq, type, data, at: new Date().toISOString() }]);
    };
    for (const type of FEED_EVENTS) source.addEventListener(type, append(type));

    source.addEventListener("status", (raw) => {
      if (!alive) return;
      try {
        const data = JSON.parse((raw as MessageEvent).data) as {
          status: RunStatus;
          error?: string | null;
        };
        liveStatus.current = data.status;
        setRun((prev) =>
          prev ? { ...prev, status: data.status, error: data.error ?? prev.error } : prev,
        );
      } catch {
        // Ignore an unparseable status frame; the next one supersedes it.
      }
    });

    source.addEventListener("end", () => {
      void loadDetail();
      source.close();
    });

    // SSE reserves the name "error" for both meanings. A server-sent agent error
    // is a MessageEvent *with* data; a dropped connection is a bare Event with
    // none — and that one just means EventSource is reconnecting, which it will
    // do from Last-Event-ID.
    source.addEventListener("error", (raw) => {
      if (!alive) return;
      const body = (raw as MessageEvent).data;
      if (!body) return;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(body);
      } catch {
        // Fall through with an empty payload.
      }
      if (data.message === "run not found") {
        setError("run not found");
        source.close();
      }
    });

    return () => {
      alive = false;
      source.close();
    };
  }, [id]);

  return { run, events, error };
}
