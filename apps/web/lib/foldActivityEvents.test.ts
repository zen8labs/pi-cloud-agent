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

  it("keeps one Thought block for a finished thinking payload", () => {
    const blocks = foldEvents(
      [log(1, "agent.thinking", { content: "The user is asking what this does." })],
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

  it("concatenates legacy per-word thinking_delta logs into one Thought block", () => {
    const blocks = foldEvents(
      [
        log(1, "agent.message_update", { updateType: "thinking_delta", delta: "The" }),
        log(2, "agent.message_update", { updateType: "thinking_delta", delta: " user" }),
        log(3, "agent.message_update", { updateType: "thinking_delta", delta: " asked." }),
      ],
      null,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "thinking",
      text: "The user asked.",
    });
  });
});
