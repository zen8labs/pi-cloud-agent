import type { RunDetail, RunEvent, RunStatus } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import { mergeEvents, type SessionTurn, sessionRunView } from "./useSession";

function event(seq: number, content: string): RunEvent {
  return { seq, type: "log", data: { event: content }, at: `2026-08-07T00:00:0${seq}Z` };
}

function turn(id: string, status: RunStatus, events: RunEvent[] = []): SessionTurn {
  const run: RunDetail = {
    id,
    status,
    provider: "test",
    repo: "owner/repo",
    model: "test-model",
    modelConnectionId: null,
    thinkingLevel: "medium",
    error: null,
    createdAt: "2026-08-07T00:00:00Z",
    updatedAt: "2026-08-07T00:00:00Z",
    sessionId: "session-1",
    turnNumber: Number(id),
    prompt: `turn ${id}`,
    branch: "main",
    headSha: null,
    sandboxStoppedAt: null,
  };
  return { run, events };
}

describe("sessionRunView", () => {
  it("does not turn a deleted queued message into a conversation turn", () => {
    const active = turn("1", "running", [event(1, "started")]);
    const deleted = turn("2", "cancelled");

    const view = sessionRunView([active, deleted], active.run.id);

    expect(view.queuedRuns).toEqual([]);
    expect(view.visibleTurns).toEqual([active]);
  });
});

describe("mergeEvents", () => {
  it("appends incremental events in sequence order", () => {
    expect(mergeEvents([event(1, "one")], [event(3, "three"), event(2, "two")])).toEqual([
      event(1, "one"),
      event(2, "two"),
      event(3, "three"),
    ]);
  });

  it("deduplicates an overlapping poll without replacing existing data", () => {
    expect(
      mergeEvents([event(1, "one"), event(2, "old")], [event(2, "old"), event(3, "three")]),
    ).toEqual([event(1, "one"), event(2, "old"), event(3, "three")]);
  });
});
