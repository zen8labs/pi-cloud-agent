import { describe, expect, it, vi } from "vitest";

const { snapshotForce, snapshotRemove, sourceRemove } = vi.hoisted(() => ({
  sourceRemove: vi.fn<() => Promise<void>>(),
  snapshotForce: vi.fn(),
  snapshotRemove: vi.fn<() => Promise<void>>(),
}));

vi.mock("microsandbox", () => {
  class MicrosandboxError extends Error {
    code = "io";
  }

  class SandboxNotFoundError extends Error {}

  class SandboxStillRunningError extends Error {}

  const source = {
    status: "stopped",
    stop: vi.fn<() => Promise<void>>(),
    kill: vi.fn<() => Promise<void>>(),
    remove: sourceRemove,
  };

  const Sandbox = { get: vi.fn(async () => source), builder: vi.fn() };

  const snapshotBuilder = {
    destDir: () => snapshotBuilder,
    fromSandbox: () => snapshotBuilder,
    force: snapshotForce,
    recordIntegrity: () => snapshotBuilder,
    create: vi.fn(async () => ({
      path: "/snapshots/session-test",
      sizeBytes: 1024n,
    })),
  };
  snapshotForce.mockReturnValue(snapshotBuilder);
  const Snapshot = {
    builder: vi.fn(() => snapshotBuilder),
    remove: snapshotRemove,
    open: vi.fn(),
  };

  const NetworkPolicy = { builder: vi.fn() };

  return {
    MicrosandboxError,
    NetworkPolicy,
    Sandbox,
    SandboxNotFoundError,
    SandboxStillRunningError,
    Snapshot,
  };
});

import { createMicroSandboxProvider } from "./microsandbox";

describe("microSandbox checkpoints", () => {
  it("keeps a valid snapshot when removing the stopped source fails", async () => {
    sourceRemove.mockRejectedValueOnce(new Error("source cleanup unavailable"));
    snapshotRemove.mockResolvedValue(undefined);

    const provider = createMicroSandboxProvider({
      MICROSANDBOX_SNAPSHOT_DIR: "/tmp/pi-cloud-agent-test-snapshots",
    });
    const workspace = await provider.suspend({ provider: "microsandbox", id: "live-1" });

    expect(workspace).toEqual({
      provider: "microsandbox",
      id: "/snapshots/session-test",
      sizeBytes: 1024,
    });
    await expect(
      provider.finalizeSuspend({ provider: "microsandbox", id: "live-1" }, workspace),
    ).rejects.toThrow("source cleanup unavailable");
    expect(snapshotForce).toHaveBeenCalled();
    expect(snapshotRemove).not.toHaveBeenCalled();
  });
});
