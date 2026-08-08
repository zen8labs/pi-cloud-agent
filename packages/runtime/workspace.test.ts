import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { SANDBOX_ENV } from "@pi-cloud-agent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";
import { runSetupScript } from "./setup";
import { gitDiff, gitRevision, trimCommandOutput } from "./workspace";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const config: RuntimeConfig = {
  runId: "run-1",
  sessionId: "",
  sessionBaseSha: "",
  workspaceResumed: false,
  debugEvents: false,
  controlPlaneUrl: "https://controller.test",
  callbackToken: "callback-token-value-1234",
  prompt: "test",
  appSetupScript: "",
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

type MockChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

function addMockChild(
  children: MockChild[],
  output: string,
  code: number,
  stderr = "",
): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  children.push(child);
  queueMicrotask(() => {
    if (output) child.stdout.emit("data", Buffer.from(output));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code, null);
  });
  return child;
}

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
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("repository setup", () => {
  it("runs the app-managed setup script", async () => {
    vi.mocked(spawn).mockImplementationOnce(
      () => addMockChild([], "configured environment ready", 0) as never,
    );
    const reporter = fakeReporter();

    await runSetupScript({ ...config, appSetupScript: "pnpm install" }, reporter);

    expect(spawn).toHaveBeenCalledWith(
      "bash",
      ["-e", "-u", "-o", "pipefail", "-c", "pnpm install"],
      expect.objectContaining({ cwd: config.repo.path }),
    );
    expect(reporter.log).toHaveBeenCalledWith("setup.started", {
      script: "app environment setting",
    });
    expect(reporter.log).toHaveBeenCalledWith("setup.complete");
  });

  it("does nothing when no app-managed script is configured", async () => {
    const reporter = fakeReporter();

    await runSetupScript(config, reporter);

    expect(spawn).not.toHaveBeenCalled();
    expect(reporter.log).toHaveBeenCalledWith("setup.skipped", { reason: "no script" });
  });

  it("runs setup without model or callback credentials", async () => {
    vi.stubEnv(SANDBOX_ENV.callbackToken, "callback-secret");
    vi.stubEnv(SANDBOX_ENV.modelApiKey, "model-secret");
    vi.stubEnv(SANDBOX_ENV.modelAuthJson, "model-oauth-secret");
    vi.stubEnv(SANDBOX_ENV.mcpConfig, "plugin-secret");
    vi.stubEnv(SANDBOX_ENV.scmToken, "forge-secret");
    vi.mocked(spawn).mockImplementationOnce(
      () => addMockChild([], "dependencies ready", 0) as never,
    );
    const reporter = fakeReporter();

    await runSetupScript({ ...config, appSetupScript: "pnpm install" }, reporter);

    const options = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(options?.env).not.toHaveProperty(SANDBOX_ENV.callbackToken);
    expect(options?.env).not.toHaveProperty(SANDBOX_ENV.modelApiKey);
    expect(options?.env).not.toHaveProperty(SANDBOX_ENV.modelAuthJson);
    expect(options?.env).not.toHaveProperty(SANDBOX_ENV.mcpConfig);
    expect(options?.env).toHaveProperty(SANDBOX_ENV.scmToken, "forge-secret");
    expect(reporter.log).toHaveBeenCalledWith("setup.started", {
      script: "app environment setting",
    });
    expect(reporter.log).toHaveBeenCalledWith("setup.complete");
  });

  it("fails the run when app-managed setup exits non-zero", async () => {
    vi.mocked(spawn).mockImplementationOnce(
      () => addMockChild([], "", 17, "dependency install failed") as never,
    );
    const reporter = fakeReporter();

    await expect(
      runSetupScript({ ...config, appSetupScript: "pnpm install" }, reporter),
    ).rejects.toThrow("repository setup exited with code 17: dependency install failed");
    expect(reporter.log).toHaveBeenCalledWith(
      "setup.failed",
      expect.objectContaining({ exitCode: 17, timedOut: false }),
    );
    expect(reporter.log).not.toHaveBeenCalledWith("setup.complete");
  });

  it("fails the run when app-managed setup reaches its timeout", async () => {
    vi.useFakeTimers();
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
    const pending = runSetupScript({ ...config, appSetupScript: "pnpm install" }, reporter);
    const assertion = expect(pending).rejects.toThrow(
      "repository setup timed out after 300 seconds",
    );
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;

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
    const children: MockChild[] = [];

    vi.mocked(spawn)
      .mockImplementationOnce(
        () => addMockChild(children, "fatal: Needed a single revision", 128) as never,
      )
      .mockImplementationOnce(() => addMockChild(children, "hello.ts\0", 0) as never)
      .mockImplementationOnce(
        () =>
          addMockChild(
            children,
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

  it("drops an incomplete path when the untracked-file list is truncated", async () => {
    const children: MockChild[] = [];

    vi.mocked(spawn)
      .mockImplementationOnce(
        () => addMockChild(children, "fatal: Needed a single revision", 128) as never,
      )
      .mockImplementationOnce(
        () => addMockChild(children, `good.ts\0${"partial-path".repeat(30_000)}`, 0) as never,
      )
      .mockImplementationOnce(() => addMockChild(children, "", 1) as never);

    const snapshot = await gitDiff(config.repo.path, null);

    expect(snapshot.truncated).toBe(true);
    expect(children).toHaveLength(3);
    expect(vi.mocked(spawn).mock.calls[2]?.[1]).toContain("good.ts");
    expect(vi.mocked(spawn).mock.calls[2]?.[1]).not.toContain("partial-path");
  });

  it("bounds untracked diff processes and accumulated output", async () => {
    const children: MockChild[] = [];
    const files = `${Array.from({ length: 257 }, (_, index) => `file-${index}.txt`).join("\0")}\0`;
    const patch = `diff --git a/file-0.txt b/file-0.txt\n${"x".repeat(2_100_000)}`;

    vi.mocked(spawn)
      .mockImplementationOnce(() => addMockChild(children, "head-sha\n", 0) as never)
      .mockImplementationOnce(() => addMockChild(children, "", 0) as never)
      .mockImplementationOnce(() => addMockChild(children, files, 0) as never);
    for (let index = 0; index < 256; index += 1) {
      vi.mocked(spawn).mockImplementationOnce(
        () => addMockChild(children, index === 0 ? patch : "", 1) as never,
      );
    }

    const snapshot = await gitDiff(config.repo.path, "base-sha");

    expect(snapshot.truncated).toBe(true);
    expect(children).toHaveLength(4);
  });

  it("keeps a valid prefix and marks an oversized tracked patch", async () => {
    const children: MockChild[] = [];
    const oversizedPatch = `diff --git a/large.txt b/large.txt\n${"a".repeat(2_100_000)}`;
    vi.mocked(spawn)
      .mockImplementationOnce(() => addMockChild(children, "head-sha\n", 0) as never)
      .mockImplementationOnce(() => addMockChild(children, oversizedPatch, 0) as never)
      .mockImplementationOnce(() => addMockChild(children, "", 0) as never);

    const snapshot = await gitDiff(config.repo.path, "base-sha");

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.patch).toMatch(/^diff --git a\/large\.txt b\/large\.txt/);
    expect(snapshot.patch).toContain("[diff truncated by the runtime]");
  });

  it("keeps git warnings out of the machine-readable patch", async () => {
    const children: MockChild[] = [];
    const patch =
      "diff --git a/hello.ts b/hello.ts\n--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-old\n+new\n";
    vi.mocked(spawn)
      .mockImplementationOnce(
        () => addMockChild(children, "head-sha\n", 0, "warning: safe.directory\n") as never,
      )
      .mockImplementationOnce(
        () => addMockChild(children, patch, 0, "warning: line ending\n") as never,
      )
      .mockImplementationOnce(
        () => addMockChild(children, "", 0, "warning: unrelated\n") as never,
      );

    const snapshot = await gitDiff(config.repo.path, "base-sha");

    expect(snapshot.patch).toBe(patch);
    expect(snapshot.patch).not.toContain("warning:");
  });

  it("decodes a UTF-8 character split across output chunks", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as never);

    const output = Buffer.from("head-é\n");
    const split = output.indexOf(0xc3) + 1;
    const pending = gitRevision(config.repo.path);
    child.stdout.emit("data", output.subarray(0, split));
    child.stdout.emit("data", output.subarray(split));
    child.emit("close", 0, null);

    await expect(pending).resolves.toBe("head-é");
  });
});
