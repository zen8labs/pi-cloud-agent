import { describe, expect, it } from "vitest";
import type { RunEvent } from "./events";
import { interpretRunEvents } from "./timeline";

const event = (
  seq: number,
  type: RunEvent["type"],
  data: Record<string, unknown>,
): RunEvent => ({
  seq,
  type,
  data,
  at: `2026-01-01T00:00:0${seq}.000Z`,
});

describe("interpretRunEvents", () => {
  it("assigns tokens and tools to turns without requiring debug turn-start logs", () => {
    const timeline = interpretRunEvents([
      event(1, "token", { content: "first" }),
      event(2, "log", { event: "agent.turn_end", turnNumber: 1, output: [] }),
      event(3, "tool_call", {
        callId: "call-1",
        tool: "read",
        status: "running",
        turnNumber: 1,
      }),
      event(4, "token", { content: "second" }),
      event(5, "log", { event: "agent.turn_end", turnNumber: 2, output: [] }),
    ]);

    expect(
      timeline.map((item) => [item.kind, "turnNumber" in item && item.turnNumber]),
    ).toEqual([
      ["token", 1],
      ["turn", 1],
      ["tool", 1],
      ["token", 2],
      ["turn", 2],
    ]);
  });

  it("counts every tool declared by a turn", () => {
    const [turn] = interpretRunEvents([
      event(1, "log", {
        event: "agent.turn_end",
        turnNumber: 1,
        output: [
          { type: "toolCall", name: "read" },
          { type: "toolCall", name: "read" },
        ],
      }),
    ]);

    expect(turn).toMatchObject({ kind: "turn", expectedToolCalls: 2, thinking: "" });
  });
});
