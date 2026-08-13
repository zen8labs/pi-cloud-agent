"use client";

import type { RunDetail, RunEvent, SessionDetail } from "@pi-cloud-agent/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useRun } from "./useRun";

export interface SessionTurn {
  run: RunDetail;
  events: RunEvent[];
}

export function sessionRunView(turns: SessionTurn[], activeRunId: string | null | undefined) {
  const latest = turns.at(-1)?.run ?? null;
  const activeRun = turns.find((turn) => turn.run.id === activeRunId)?.run ?? null;
  const queuedRuns = turns
    .map((turn) => turn.run)
    .filter((run) => run.status === "queued" && run.id !== activeRunId);
  const visibleTurns = turns.filter((turn) => {
    if (turn.run.id === activeRunId) return true;
    if (turn.run.status === "queued") return false;
    const deletedBeforeStart =
      turn.run.status === "cancelled" &&
      turn.run.sandboxStoppedAt === null &&
      turn.events.length === 0;
    return !deletedBeforeStart;
  });
  return {
    activeRun,
    queuedRuns,
    visibleTurns,
    displayRun: activeRun ?? visibleTurns.at(-1)?.run ?? latest,
    latest,
  };
}

export function useSession(id: string) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [history, setHistory] = useState<Record<string, RunEvent[]>>({});
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<Record<string, RunEvent[]>>({});
  const refreshingRef = useRef(false);
  const active = useRun(session?.activeRunId ?? "");

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const detail = await api.getSession(id);
      const inactive = detail.runs.filter((run) => run.id !== detail.activeRunId);
      const entries = await Promise.all(
        inactive.map(async (run) => {
          const existing = historyRef.current[run.id] ?? [];
          const afterSeq = existing.at(-1)?.seq ?? 0;
          const incoming = await api.getEvents(run.id, afterSeq);
          return [run.id, mergeEvents(existing, incoming)] as const;
        }),
      );
      const nextHistory = Object.fromEntries(entries);
      historyRef.current = nextHistory;
      setSession(detail);
      setHistory(nextHistory);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      refreshingRef.current = false;
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const turns = useMemo<SessionTurn[]>(() => {
    if (!session) return [];
    return session.runs.map((run) =>
      run.id === session.activeRunId
        ? { run: active.run ?? run, events: active.events }
        : { run, events: history[run.id] ?? [] },
    );
  }, [active.events, active.run, history, session]);

  return { session, turns, error: error ?? active.error, refresh };
}

export function mergeEvents(existing: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (incoming.length === 0) return existing;
  const bySequence = new Map(existing.map((event) => [event.seq, event]));
  for (const event of incoming) {
    if (!bySequence.has(event.seq)) bySequence.set(event.seq, event);
  }
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}
