import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";
import { gitDiff, gitRevision, runSetupScript, trimCommandOutput } from "./workspace";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

const config: RuntimeConfig = {
  runId: "run-1",
  sessionId: "",
  sessionBaseSha: "",
  workspaceResumed: false,
  debugEvents: false,
  controlPlaneUrl: "https://controller.test",
  callbackToken: "callback-token-value-1234",
  prompt: "test",
  model: {
    provider: "test-provider",
    name: "test-model",
    api: "openai-completions",
    authType: "api_key",
    authJson: "",
    baseUrl: "https://gateway.test/v1",
    contextWindow: 1000,
    maxTokens: 100,
    thinkingLevel: "medium",
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
  mcpConfig: null,
};

function fakeReporter(): Reporter {
  return {
    event: vi.fn(),
    log: vi.fn(),
    status: vi.fn(),
    modelCredential: vi.fn(async () => true),
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

describe("git snapshots", () => {
  it("keeps the beginning of oversized command output and records truncation", () => {
    expect(trimCommandOutput("0123456789", 5, "head")).toEqual({
      output: "01234",
      truncated: true,
    });
    expect(trimCommandOutput("01234", 5, "head")).toEqual({
      output: "01234",
      truncated: false,
    });
    expect(trimCommandOutput("0123456789", 5)).toEqual({
      output: "56789",
      truncated: true,
    });
  });

  it("treats an unborn HEAD as a missing revision", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as never);

    const pending = gitRevision(config.repo.path);
    child.stderr.emit("data", Buffer.from("fatal: Needed a single revision"));
    child.emit("close", 128, null);

    await expect(pending).resolves.toBeNull();
  });

  it("captures files when a repository has no baseline commit", async () => {
    const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }> = [];
    const addChild = (output: string, code: number) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      queueMicrotask(() => {
        if (output) child.stdout.emit("data", Buffer.from(output));
        child.emit("close", code, null);
      });
      return child;
    };

    vi.mocked(spawn)
      .mockImplementationOnce(() => addChild("fatal: Needed a single revision", 128) as never)
      .mockImplementationOnce(() => addChild("hello.ts\0", 0) as never)
      .mockImplementationOnce(
        () =>
          addChild(
            "diff --git a/hello.ts b/hello.ts\nnew file mode 100644\n--- /dev/null\n+++ b/hello.ts\n@@ -0,0 +1 @@\n+hello\n",
            1,
          ) as never,
      );

    await expect(gitDiff(config.repo.path, null)).resolves.toMatchObject({
      baseSha: null,
      headSha: null,
      files: 1,
      added: 1,
      removed: 0,
    });
    expect(children).toHaveLength(3);
  });

  it("keeps a valid prefix and marks an oversized tracked patch", async () => {
    const addChild = (output: string, code: number) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        if (output) child.stdout.emit("data", Buffer.from(output));
        child.emit("close", code, null);
      });
      return child;
    };

    const oversizedPatch = `diff --git a/large.txt b/large.txt\n${"a".repeat(2_100_000)}`;
    vi.mocked(spawn)
      .mockImplementationOnce(() => addChild("head-sha\n", 0) as never)
      .mockImplementationOnce(() => addChild(oversizedPatch, 0) as never)
      .mockImplementationOnce(() => addChild("", 0) as never);

    const snapshot = await gitDiff(config.repo.path, "base-sha");

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.patch).toMatch(/^diff --git a\/large\.txt b\/large\.txt/);
    expect(snapshot.patch).toContain("[diff truncated by the runtime]");
  });
});
