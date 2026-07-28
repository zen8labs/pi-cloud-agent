import { describe, expect, it } from "vitest";
import { createSandboxProvider, sandboxProviderNames } from "./index";

/**
 * The registry is the contributor's entry point, so what it does when something
 * is missing matters more than the happy path: a misconfigured provider should
 * say what is available and what it needs, at startup, not halfway into a run.
 */
describe("sandbox provider registry", () => {
  it("builds the configured provider", () => {
    const provider = createSandboxProvider("e2b", { E2B_API_KEY: "test-key" });
    expect(provider.name).toBe("e2b");
    expect(typeof provider.create).toBe("function");
    expect(typeof provider.stop).toBe("function");
  });

  it("names the alternatives when asked for one that does not exist", () => {
    expect(() => createSandboxProvider("modal", {})).toThrow(
      /Unknown sandbox provider "modal". Available: e2b./,
    );
  });

  it("fails at construction when a provider's own configuration is missing", () => {
    expect(() => createSandboxProvider("e2b", {})).toThrow(/E2B_API_KEY is required/);
  });

  it("reports what it knows about", () => {
    expect(sandboxProviderNames()).toEqual(["e2b"]);
  });
});
