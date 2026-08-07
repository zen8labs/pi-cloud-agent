import type { RunEvent } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import { foldEvents } from "./foldActivityEvents";

function log(seq: number, event: string, fields: Record<string, unknown> = {}): RunEvent {
  return {
    seq,
    type: "log",
    data: { event, ...fields },
    at: `2026-08-05T00:00:0${seq}.000Z`,
  };
}

function token(seq: number, content: string): RunEvent {
  return {
    seq,
    type: "token",
    data: { content },
    at: `2026-08-05T00:00:0${seq}.000Z`,
  };
}

describe("foldEvents thinking", () => {
  it("renders thinking blocks carried by the completed turn output", () => {
    const blocks = foldEvents(
      [
        log(1, "agent.turn_end", {
          output: [
            { type: "thinking", thinking: "The user is asking what this does." },
            { type: "text", text: "Here is the answer." },
          ],
        }),
      ],
      null,
    );
    expect(blocks).toEqual([
      {
        key: "thinking-1",
        kind: "thinking",
        text: "The user is asking what this does.",
        at: "2026-08-05T00:00:01.000Z",
      },
    ]);
  });

  it("places completed-turn reasoning before that turn's streamed answer", () => {
    const blocks = foldEvents(
      [
        log(1, "agent.turn_start", { turnNumber: 1 }),
        token(2, "Here is the answer."),
        log(3, "agent.turn_end", {
          turnNumber: 1,
          output: [{ type: "thinking", thinking: "First, inspect the evidence." }],
        }),
      ],
      null,
    );

    expect(blocks.map((block) => block.kind)).toEqual(["thinking", "assistant"]);
    expect(blocks[0]).toMatchObject({
      kind: "thinking",
      text: "First, inspect the evidence.",
    });
    expect(blocks[1]).toMatchObject({ kind: "assistant", text: "Here is the answer." });
  });

  it("keeps identical reasoning when it genuinely recurs in a later turn", () => {
    const blocks = foldEvents(
      [
        log(1, "agent.turn_start", { turnNumber: 1 }),
        token(2, "First answer."),
        log(3, "agent.turn_end", {
          turnNumber: 1,
          output: [{ type: "thinking", thinking: "Let me check the tests." }],
        }),
        log(4, "agent.turn_start", { turnNumber: 2 }),
        token(5, "Second answer."),
        log(6, "agent.turn_end", {
          turnNumber: 2,
          output: [{ type: "thinking", thinking: "Let me check the tests." }],
        }),
      ],
      null,
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      "thinking",
      "assistant",
      "thinking",
      "assistant",
    ]);
    expect(
      blocks.filter((block) => block.kind === "thinking").map((block) => block.text),
    ).toEqual(["Let me check the tests.", "Let me check the tests."]);
  });

  it("does not render raw agent lifecycle logs", () => {
    const blocks = foldEvents(
      [
        log(1, "agent.session_created", { sessionId: "session-1" }),
        log(2, "agent.retry", { attempt: 1 }),
        log(3, "agent.session_checkpointed", { bytes: 42 }),
        log(4, "agent.session_complete", { sessionId: "session-1" }),
      ],
      null,
    );

    expect(blocks).toEqual([]);
  });

  it("does not render diff bookkeeping logs", () => {
    expect(foldEvents([log(1, "git.diff_base", { baseSha: "base-sha" })], null)).toEqual([]);
  });

  it("joins multiple reasoning parts from one completed turn", () => {
    const blocks = foldEvents(
      [
        log(1, "agent.turn_end", {
          turnNumber: 1,
          output: [
            { type: "thinking", thinking: "Check " },
            { type: "thinking", thinking: "tests." },
          ],
        }),
      ],
      null,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "thinking", text: "Check tests." });
  });
});
