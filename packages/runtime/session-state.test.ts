import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";
import { loadSessionManager } from "./session-state";

const openSession = { kind: "open" };
const fetchMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    inMemory: vi.fn(),
    open: vi.fn(async () => openSession),
    create: vi.fn(),
  },
}));

const config = {
  runId: "run-2",
  controlPlaneUrl: "https://controller.test",
  callbackToken: "callback-token",
  sessionId: "session-1",
  repo: { path: "/workspace/widgets" },
} as RuntimeConfig;

const reporter = { log: vi.fn() } as unknown as Reporter;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("session checkpoint restore", () => {
  it("retries a transient 502 from the control plane tunnel", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(502, { error: "bad gateway" }))
      .mockResolvedValueOnce(jsonResponse(200, { content: '{"type":"session"}\n' }));

    const pending = loadSessionManager(config, reporter);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe(openSession);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reporter.log).toHaveBeenCalledWith("agent.session_restored", {
      sessionId: "session-1",
    });
  });

  it("fails after the control plane stays unreachable", async () => {
    fetchMock.mockResolvedValue(jsonResponse(502, { error: "bad gateway" }));

    const pending = loadSessionManager(config, reporter);
    const expectation = expect(pending).rejects.toThrow(
      /could not restore Pi checkpoint: HTTP 502/,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
