"use client";

import type { RunDetail, RunEvent, SessionDetail } from "@pi-cloud-agent/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useRun } from "./useRun";

export interface SessionTurn {
  run: RunDetail;
  events: RunEvent[];
}

export function useSession(id: string) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [history, setHistory] = useState<Record<string, RunEvent[]>>({});
  const [error, setError] = useState<string | null>(null);
  const latest = useRun(session?.latestRunId ?? "");

  const refresh = useCallback(async () => {
    try {
      const detail = await api.getSession(id);
      const older = detail.runs.filter((run) => run.id !== detail.latestRunId);
      const entries = await Promise.all(
        older.map(async (run) => [run.id, await api.getEvents(run.id)] as const),
      );
      setSession(detail);
      setHistory(Object.fromEntries(entries));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
      run.id === session.latestRunId
        ? { run: latest.run ?? run, events: latest.events }
        : { run, events: history[run.id] ?? [] },
    );
  }, [history, latest.events, latest.run, session]);

  return { session, turns, error: error ?? latest.error, refresh };
}
