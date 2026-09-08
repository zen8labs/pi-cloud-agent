import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildTemplate,
  sandboxConnect,
  sandboxKill,
  templateExists,
  templateFactory,
  templateBuilder,
  sandboxCreate,
  templateLookup,
  templateDelete,
} = vi.hoisted(() => {
  const builder = {
    fromImage: vi.fn(),
    setStartCmd: vi.fn(),
  };
  builder.fromImage.mockReturnValue(builder);
  builder.setStartCmd.mockReturnValue(builder);
  return {
    buildTemplate: vi.fn(async (_template: unknown, _name: string): Promise<void> => undefined),
    sandboxConnect: vi.fn(),
    sandboxKill: vi.fn(async (): Promise<void> => undefined),
    templateExists: vi.fn(async () => false),
    templateFactory: vi.fn(() => builder),
    templateBuilder: builder,
    sandboxCreate: vi.fn(),
    templateLookup: vi.fn(async () => ({
      data: { templateID: "disposable-id" },
      response: { status: 200 },
    })),
    templateDelete: vi.fn(async () => ({ response: { status: 204 } })),
  };
});

vi.mock("e2b", () => ({
  Sandbox: { create: sandboxCreate, connect: sandboxConnect, kill: sandboxKill },
  ConnectionConfig: class {},
  ApiClient: class {
    api = { GET: templateLookup, DELETE: templateDelete };
  },
  SandboxNotFoundError: class SandboxNotFoundError extends Error {},
  Template: Object.assign(templateFactory, {
    build: buildTemplate,
    exists: templateExists,
  }),
}));

import { createE2BProvider } from "./e2b";

const preflightSpec = {
  runId: "test",
  image: "ubuntu:22.04",
  timeoutSeconds: 60,
  env: {},
  secrets: {},
  command: "true",
};

describe("E2B image resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["build", "create", "install"])(
    "cleans up its private preflight template after %s fails",
    async (failure) => {
      if (failure === "build") buildTemplate.mockRejectedValueOnce(new Error("build failed"));
      if (failure === "create") sandboxCreate.mockRejectedValueOnce(new Error("create failed"));
      if (failure === "install")
        sandboxCreate.mockResolvedValueOnce({
          sandboxId: "test-sandbox",
          commands: { run: vi.fn().mockRejectedValue(new Error("install failed")) },
        });
      const provider = createE2BProvider({ E2B_API_KEY: "test-key" });
      await expect(provider.execute?.(preflightSpec)).rejects.toThrow(
        "environment test failed",
      );
      expect(templateDelete).toHaveBeenCalledWith("/templates/{templateID}", {
        params: { path: { templateID: "disposable-id" } },
      });
      expect(sandboxKill).toHaveBeenCalledTimes(failure === "install" ? 1 : 0);
    },
  );

  it("never deletes an existing template used for preflight", async () => {
    sandboxCreate.mockRejectedValueOnce(new Error("create failed"));
    const provider = createE2BProvider({ E2B_API_KEY: "test-key" });
    await expect(
      provider.execute?.({ ...preflightSpec, image: "pi-cloud-agent" }),
    ).rejects.toThrow();
    expect(templateLookup).not.toHaveBeenCalled();
    expect(templateDelete).not.toHaveBeenCalled();
  });

  it("keeps a concurrent session build separate from disposable preflight", async () => {
    let release = () => {};
    buildTemplate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    sandboxCreate.mockRejectedValueOnce(new Error("create failed"));
    const provider = createE2BProvider({ E2B_API_KEY: "test-key" });
    const pinned = provider.resolveImage("ubuntu:22.04");
    try {
      await expect(provider.execute?.(preflightSpec)).rejects.toThrow();
      expect(buildTemplate).toHaveBeenCalledTimes(2);
      expect(templateLookup).toHaveBeenCalledWith("/templates/aliases/{alias}", {
        params: { path: { alias: buildTemplate.mock.calls[1]?.[1] } },
      });
    } finally {
      release();
      await pinned;
    }
  });

  it("surfaces template cleanup failure instead of hiding the leaked resource", async () => {
    sandboxCreate.mockRejectedValueOnce(new Error("create failed"));
    templateDelete.mockRejectedValueOnce(new Error("cleanup unavailable"));
    const provider = createE2BProvider({ E2B_API_KEY: "test-key" });
    await expect(provider.execute?.(preflightSpec)).rejects.toThrow("cleanup unavailable");
  });

  it("refreshes a republished image tag instead of permanently reusing its old template", async () => {
    const provider = createE2BProvider({ E2B_API_KEY: "test-key" });
    const image = "ghcr.io/acme/widgets:latest";

    const first = await provider.resolveImage(image);
    const second = await provider.resolveImage(image);

    expect(second).not.toBe(first);
    expect(buildTemplate).toHaveBeenCalledTimes(2);
    expect(buildTemplate).toHaveBeenNthCalledWith(
      1,
      templateBuilder,
      expect.stringMatching(/^pi-cloud-agent-[0-9a-f]{16}-[0-9a-f]{12}$/),
      { apiKey: "test-key", skipCache: true },
    );
  });

  it("shares an in-flight build without turning it into a permanent cache", async () => {
    let releaseBuild: () => void = () => undefined;
    buildTemplate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseBuild = resolve;
        }),
    );
    const provider = createE2BProvider({ E2B_API_KEY: "test-key" });
    const image = "docker.io/acme/widgets:dev";

    const first = provider.resolveImage(image);
    const second = provider.resolveImage(image);
    releaseBuild();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(buildTemplate).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a stale template when materialization fails", async () => {
    buildTemplate.mockRejectedValueOnce(new Error("template build failed"));
    templateExists.mockResolvedValueOnce(true);
    const provider = createE2BProvider({ E2B_API_KEY: "test-key" });

    await expect(provider.resolveImage("ghcr.io/acme/widgets:latest")).rejects.toThrow(
      "template build failed",
    );
    expect(templateExists).not.toHaveBeenCalled();
  });

  it("preserves a paused workspace when runtime preparation fails", async () => {
    sandboxConnect.mockResolvedValueOnce({
      sandboxId: "paused-1",
      commands: { run: vi.fn().mockRejectedValue(new Error("command launch failed")) },
    });
    const provider = createE2BProvider({ E2B_API_KEY: "test-key" });

    await expect(
      provider.resume(
        { provider: "e2b", id: "paused-1" },
        {
          runId: "run-1",
          image: "template-1",
          timeoutSeconds: 60,
          env: {},
          secrets: {},
          command: "cd /opt/pi-cloud-agent && ./bin/node --import tsx ./run.js",
        },
      ),
    ).rejects.toMatchObject({ name: "SandboxError" });
    expect(sandboxKill).not.toHaveBeenCalled();
  });
});
