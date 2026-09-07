import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildTemplate, templateExists, templateFactory, templateBuilder } = vi.hoisted(() => {
  const builder = {
    fromImage: vi.fn(),
    setStartCmd: vi.fn(),
  };
  builder.fromImage.mockReturnValue(builder);
  builder.setStartCmd.mockReturnValue(builder);
  return {
    buildTemplate: vi.fn(async (): Promise<void> => undefined),
    templateExists: vi.fn(async () => false),
    templateFactory: vi.fn(() => builder),
    templateBuilder: builder,
  };
});

vi.mock("e2b", () => ({
  Sandbox: {},
  SandboxNotFoundError: class SandboxNotFoundError extends Error {},
  Template: Object.assign(templateFactory, {
    build: buildTemplate,
    exists: templateExists,
  }),
}));

import { createE2BProvider } from "./e2b";

describe("E2B image resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refreshes a republished image tag instead of permanently reusing its old template", async () => {
    const provider = createE2BProvider({ E2B_API_KEY: "test-key" });
    const image = "ghcr.io/acme/widgets:latest";

    const first = await provider.resolveImage(image);
    const second = await provider.resolveImage(image);

    expect(second).toBe(first);
    expect(buildTemplate).toHaveBeenCalledTimes(2);
    expect(buildTemplate).toHaveBeenNthCalledWith(
      1,
      templateBuilder,
      expect.stringMatching(/^pi-cloud-agent-[0-9a-f]{16}$/),
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
});
