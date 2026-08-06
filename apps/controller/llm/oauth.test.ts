import type { AuthInteraction, Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { type OAuthFlowEvent, OAuthFlowManager } from "./oauth";

const UNUSED_DATABASE = {} as Database;
const UNUSED_CONFIG = {} as Config;

function pendingRuntime(onAbort: () => void) {
  return {
    async login(
      _providerId: string,
      _type: "oauth",
      interaction: AuthInteraction,
    ): Promise<Credential> {
      return new Promise((_, reject) => {
        interaction.signal?.addEventListener(
          "abort",
          () => {
            onAbort();
            reject(interaction.signal?.reason);
          },
          { once: true },
        );
      });
    },
    getModels: () => [],
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("OAuth sign-in flow lifetime", () => {
  it("aborts and removes an abandoned sign-in after its expiry", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    const manager = new OAuthFlowManager(UNUSED_DATABASE, UNUSED_CONFIG, {
      createRuntime: async () => pendingRuntime(aborted),
      flowTimeoutMs: 100,
      terminalRetentionMs: 0,
    });
    const flowId = manager.start("user-1", "chatgpt");
    const events: OAuthFlowEvent[] = [];
    manager.subscribe(flowId, "user-1", (event) => events.push(event));

    await vi.advanceTimersByTimeAsync(100);
    await settle();

    expect(aborted).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "error", message: "OAuth sign-in expired" });
    await vi.runOnlyPendingTimersAsync();
    expect(manager.get(flowId, "user-1")).toBeNull();
  });

  it("supersedes an older active sign-in for the same user and provider", async () => {
    const aborted = vi.fn();
    const manager = new OAuthFlowManager(UNUSED_DATABASE, UNUSED_CONFIG, {
      createRuntime: async () => pendingRuntime(aborted),
    });
    const firstFlowId = manager.start("user-1", "chatgpt");
    await settle();

    manager.start("user-1", "chatgpt");
    await settle();

    expect(aborted).toHaveBeenCalledOnce();
    expect(manager.get(firstFlowId, "user-1")?.events).toContainEqual({
      type: "error",
      message: "OAuth sign-in superseded by a new attempt",
    });
  });
});
