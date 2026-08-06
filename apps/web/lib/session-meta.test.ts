import type { RunEvent } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import { resolveBranch, summarizeChanges } from "./session-meta";

function event(type: RunEvent["type"], data: Record<string, unknown>, seq = 1): RunEvent {
  return { seq, at: "2026-01-01T00:00:00.000Z", type, data };
}

describe("summarizeChanges", () => {
  it("aggregates write and edit tool calls by path", () => {
    const summary = summarizeChanges([
      event("tool_call", {
        tool: "write",
        args: { path: "a.ts", content: "one\ntwo\n" },
      }),
      event("tool_call", {
        tool: "edit",
        args: { path: "a.ts", oldText: "one\n", newText: "one\nthree\n" },
      }),
      event("tool_call", {
        tool: "write",
        args: { path: "b.ts", content: "x\n" },
      }),
    ]);
    expect(summary.files).toHaveLength(2);
    expect(summary.added).toBeGreaterThan(0);
    expect(summary.removed).toBeGreaterThan(0);
  });
});

describe("resolveBranch", () => {
  it("keeps the initial branch when nothing changes it", () => {
    expect(resolveBranch("main", [])).toBe("main");
  });

  it("advances from git.cloned logs and checkout commands", () => {
    expect(
      resolveBranch("main", [
        event("log", { event: "git.cloned", branch: "main" }),
        event("tool_call", {
          tool: "bash",
          args: { command: "git checkout -b feature/pr" },
        }),
      ]),
    ).toBe("feature/pr");
  });

  it("ignores default-placeholder clone branches", () => {
    expect(
      resolveBranch("main", [event("log", { event: "git.cloned", branch: "(default)" })]),
    ).toBe("main");
  });
});
