import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";
import { gitDiff, gitRevision, prepareCheckout, trimCommandOutput } from "./workspace";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({ rm: vi.fn(async () => undefined) }));

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
    baseCloneUrl: "https://github.com/acme/widgets.git",
    defaultBranch: "main",
    headBranch: "main",
    headSha: "",
    baseSha: "",
    path: "/workspace/widgets",
  },
  git: { username: "x-access-token", hasToken: false },
  mcpConfig: null,
  githubReview: null,
  githubComment: null,
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

function queueChild(children: MockChild[], output: string, code: number): void {
  vi.mocked(spawn).mockImplementationOnce(() => addMockChild(children, output, code) as never);
}

afterEach(() => {
  vi.resetAllMocks();
});

function testReporter() {
  return {
    event: vi.fn(),
    log: vi.fn(),
    status: vi.fn(async () => {}),
    modelCredential: vi.fn(async () => false),
    review: vi.fn(async () => undefined),
    comment: vi.fn(async () => undefined),
    flush: vi.fn(async () => {}),
  } satisfies Reporter;
}

describe("checkout preparation", () => {
  it("reuses a resumed checkout without cloning again", async () => {
    const children: MockChild[] = [];
    const reporter = testReporter();
    vi.mocked(existsSync).mockReturnValue(true);
    queueChild(children, "https://github.com/acme/widgets.git\n", 0);

    const result = await prepareCheckout({ ...config, workspaceResumed: true }, reporter);

    expect(result).toBe("resumed");
    expect(children).toHaveLength(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe("git");
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(["remote", "get-url", "origin"]);
    expect(reporter.log).toHaveBeenCalledWith("git.workspace_resumed", {
      path: config.repo.path,
    });
    expect(reporter.log).not.toHaveBeenCalledWith("git.cloned", expect.anything());
    expect(rm).not.toHaveBeenCalled();
  });

  it("clones on a cold start instead of trusting a preloaded checkout", async () => {
    const children: MockChild[] = [];
    const reporter = testReporter();
    // A repository image may contain a stale path; only the provider resume bit
    // authorizes reusing it.
    vi.mocked(existsSync).mockReturnValue(true);
    queueChild(children, "", 0);

    const result = await prepareCheckout({ ...config, workspaceResumed: false }, reporter);

    expect(result).toBe("created");
    expect(children).toHaveLength(1);
    expect(rm).toHaveBeenCalledWith(config.repo.path, {
      recursive: true,
      force: true,
    });
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([
      "clone",
      "--depth",
      "100",
      "--branch",
      "main",
      config.repo.cloneUrl,
      config.repo.path,
    ]);
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
