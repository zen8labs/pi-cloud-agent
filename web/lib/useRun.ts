"use client";

import { useEffect, useRef, useState } from "react";
import { api, streamUrl } from "./api";
import { type AgentEvent, type RunDetail, type RunStatus } from "./types";

// Event names the controller streams as agent activity (each carries `id: seq`).
const FEED_EVENTS = ["token", "tool_call", "log", "finding", "subagent_event"] as const;

/**
 * Live view of a single run over a resumable SSE stream.
 *
 * The browser's native `EventSource` holds one connection and auto-reconnects;
 * because the controller tags every frame with `id: <seq>`, a reconnect resumes
 * from the exact last-seen event (via the standard `Last-Event-ID` header) — no
 * gaps, no duplicates. The append-only event log is the source of truth, so a
 * fresh page load replays full history then tails live.
 *
 * Run metadata (repo, prompt, findings) is fetched once over REST and refreshed
 * when a finding lands or the run ends; live status arrives as `status` frames.
 */
export function useRun(id: string) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const status = useRef<RunStatus | null>(null);
  // Dedupe by the event log's sequence id. The browser may hold more than one
  // EventSource at once (React StrictMode double-invokes effects in dev; a
  // reconnect can briefly overlap), and each replays history — so the same seq
  // can arrive twice. Seq is globally unique per run, so this is exact.
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    let alive = true;
    status.current = null;
    seen.current = new Set();
    setEvents([]);
    setRun(null);
    setError(null);

    // Authoritative metadata + findings (status is overlaid from the stream).
    const loadDetail = async () => {
      try {
        const detail = await api.getRun(id);
        if (!alive) return;
        setRun({ ...detail, status: status.current ?? detail.status });
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    loadDetail();

    const es = new EventSource(streamUrl(id));

    const append = (type: string) => (ev: MessageEvent) => {
      if (!alive) return;
      const seq = ev.lastEventId ? Number(ev.lastEventId) : 0;
      if (seen.current.has(seq)) return; // already delivered (overlapping stream)
      seen.current.add(seq);
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(ev.data);
      } catch {
        /* keep empty */
      }
      setEvents((prev) => [...prev, { seq, type, data, at: new Date().toISOString() }]);
    };
    for (const t of FEED_EVENTS) es.addEventListener(t, append(t));

    es.addEventListener("status", (ev) => {
      if (!alive) return;
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { status: RunStatus; error?: string };
        status.current = d.status;
        setRun((prev) =>
          prev ? { ...prev, status: d.status, error: d.error ?? prev.error } : prev,
        );
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("finding", () => void loadDetail());

    es.addEventListener("end", () => {
      void loadDetail();
      es.close();
    });

    // NOTE: SSE reserves the "error" event name. A server-sent agent error is a
    // MessageEvent *with* data; a transport/connection drop is a bare Event with
    // none. Only the former is a real agent error — the latter just means
    // EventSource is reconnecting (and will resume from Last-Event-ID).
    es.addEventListener("error", (ev) => {
      if (!alive) return;
      const msg = (ev as MessageEvent).data;
      if (!msg) return; // transport hiccup → let EventSource auto-reconnect
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(msg);
      } catch {
        /* ignore */
      }
      setEvents((prev) => [
        ...prev,
        { seq: 0, type: "error", data, at: new Date().toISOString() },
      ]);
      if (data.message === "run not found") {
        setError("run not found");
        es.close();
      }
    });

    return () => {
      alive = false;
      es.close();
    };
  }, [id]);

  return { run, events, error };
}
