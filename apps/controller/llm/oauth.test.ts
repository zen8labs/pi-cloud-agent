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
  it("selects device authorization instead of the localhost browser callback", async () => {
    const selected = vi.fn();
    const manager = new OAuthFlowManager(UNUSED_DATABASE, UNUSED_CONFIG, {
      createRuntime: async () => ({
        async login(_providerId, _type, interaction) {
          selected(
            await interaction.prompt({
              type: "select",
              message: "Select login method",
              options: [
                { id: "browser", label: "Browser login" },
                { id: "device_code", label: "Device code login" },
              ],
            }),
          );
          interaction.notify({
            type: "device_code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://auth.openai.com/codex/device",
            intervalSeconds: 5,
            expiresInSeconds: 900,
          });
          return new Promise<Credential>((_, reject) => {
            interaction.signal?.addEventListener(
              "abort",
              () => reject(interaction.signal?.reason),
              {
                once: true,
              },
            );
          });
        },
        getModels: () => [],
      }),
    });

    const flowId = manager.start("user-1");
    await settle();

    expect(selected).toHaveBeenCalledWith("device_code");
    expect(manager.get(flowId, "user-1")?.events).toContainEqual({
      type: "auth",
      event: {
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    });
    expect(manager.cancel(flowId, "user-1")).toBe(true);
    await settle();
  });

  it("aborts and removes an abandoned sign-in after its expiry", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    const manager = new OAuthFlowManager(UNUSED_DATABASE, UNUSED_CONFIG, {
      createRuntime: async () => pendingRuntime(aborted),
      flowTimeoutMs: 100,
      terminalRetentionMs: 0,
    });
    const flowId = manager.start("user-1");
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
    const firstFlowId = manager.start("user-1");
    await settle();

    manager.start("user-1");
    await settle();

    expect(aborted).toHaveBeenCalledOnce();
    expect(manager.get(firstFlowId, "user-1")?.events).toContainEqual({
      type: "error",
      message: "OAuth sign-in superseded by a new attempt",
    });
  });

  it("lets the owning user cancel an active sign-in", async () => {
    const aborted = vi.fn();
    const manager = new OAuthFlowManager(UNUSED_DATABASE, UNUSED_CONFIG, {
      createRuntime: async () => pendingRuntime(aborted),
    });
    const flowId = manager.start("user-1");
    await settle();

    expect(manager.cancel(flowId, "another-user")).toBe(false);
    expect(manager.cancel(flowId, "user-1")).toBe(true);
    await settle();

    expect(aborted).toHaveBeenCalledOnce();
    expect(manager.get(flowId, "user-1")?.events).toContainEqual({
      type: "error",
      message: "OAuth sign-in cancelled",
    });
  });
});
