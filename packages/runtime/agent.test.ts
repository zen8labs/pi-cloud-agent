import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createAgentEventHandler } from "./agent";
import type { Reporter } from "./reporter";

function recordingReporter(): Reporter {
  return {
    event: vi.fn(),
    log: vi.fn(),
    status: vi.fn(),
    modelCredential: vi.fn(),
    flush: vi.fn(),
  };
}

it("does not enqueue high-frequency progress that the controller discards", () => {
  const reporter = recordingReporter();
  const handle = createAgentEventHandler(reporter);

  handle({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "pnpm test" },
    partialResult: { content: [{ type: "text", text: "many chunks" }] },
  } as AgentSessionEvent);
  handle({ type: "bash_execution_update", id: "bash-1", delta: "one chunk" });

  expect(reporter.event).not.toHaveBeenCalled();
  expect(reporter.log).not.toHaveBeenCalled();
});

it("does not serialize unknown harness event objects", () => {
  const reporter = recordingReporter();
  const handle = createAgentEventHandler(reporter);
  const event = { type: "future_event" } as unknown as AgentSessionEvent;

  handle(event);

  expect(reporter.event).not.toHaveBeenCalled();
  expect(reporter.log).not.toHaveBeenCalled();
});

it("relays debug lifecycle events through the reporter policy boundary", () => {
  const reporter = recordingReporter();
  const handle = createAgentEventHandler(reporter);

  handle({ type: "message_start", message: { role: "assistant" } } as AgentSessionEvent);
  handle({ type: "message_end", message: { role: "assistant" } } as AgentSessionEvent);

  expect(reporter.log).toHaveBeenCalledTimes(2);
  expect(reporter.log).toHaveBeenNthCalledWith(1, "agent.message_start", {
    role: "assistant",
  });
  expect(reporter.log).toHaveBeenNthCalledWith(2, "agent.message_end", {
    role: "assistant",
  });
});
