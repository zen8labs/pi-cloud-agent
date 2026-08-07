import type { RunEvent } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import { mergeEvents } from "./useSession";

function event(seq: number, content: string): RunEvent {
  return { seq, type: "log", data: { event: content }, at: `2026-08-07T00:00:0${seq}Z` };
}

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
