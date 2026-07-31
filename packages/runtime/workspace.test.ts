import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";
import { runSetupScript } from "./workspace";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

const config: RuntimeConfig = {
  runId: "run-1",
  controlPlaneUrl: "https://controller.test",
  callbackToken: "callback-token-value-1234",
  prompt: "test",
  profile: "general",
  model: {
    provider: "aigateway",
    name: "test-model",
    baseUrl: "https://gateway.test/v1",
    contextWindow: 1000,
    maxTokens: 100,
  },
  repo: {
    owner: "acme",
    name: "widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    defaultBranch: "main",
    headBranch: "main",
    headSha: "",
    baseSha: "",
    path: "/workspace/widgets",
  },
  git: { username: "x-access-token", hasToken: false },
};

function fakeReporter(): Reporter {
  return {
    event: vi.fn(),
    log: vi.fn(),
    status: vi.fn(),
    flush: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("repository setup", () => {
  it("reports a process killed at the timeout as failed, never complete", async () => {
    vi.useFakeTimers();
    vi.mocked(existsSync).mockReturnValue(true);

    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      child.emit("close", null, "SIGKILL");
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);

    const reporter = fakeReporter();
    const pending = runSetupScript(config, reporter);
    await vi.advanceTimersByTimeAsync(300_000);
    await pending;

    expect(reporter.log).not.toHaveBeenCalledWith("setup.complete");
    expect(reporter.log).toHaveBeenCalledWith(
      "setup.failed",
      expect.objectContaining({ timedOut: true, signal: "SIGKILL" }),
    );
  });
});
