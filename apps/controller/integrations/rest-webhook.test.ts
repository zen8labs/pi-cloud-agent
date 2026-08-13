import { isTerminal } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import {
  HttpCallbackReportSink,
  IntegrationRegistry,
  REST_WEBHOOK_SURFACE_KIND,
  RestWebhookIngressAdapter,
} from "./index";

describe("ZEN-93 REST webhook scaffold", () => {
  const adapter = new RestWebhookIngressAdapter("test-token");

  it("rejects missing/wrong bearer and accepts a valid JSON body", async () => {
    const body = {
      provider: "github",
      repo: "acme/demo",
      prompt: "fix flaky tests",
      callbackUrl: "https://example.com/hooks/pi",
      branch: "develop",
    };

    expect(await adapter.accept({ authorizationHeader: null, body })).toBeNull();
    expect(
      await adapter.accept({
        authorizationHeader: "Bearer wrong",
        body,
      }),
    ).toBeNull();
    expect(
      await adapter.accept({
        authorizationHeader: "Bearer test-token",
        body: { ...body, prompt: "" },
      }),
    ).toBeNull();

    const accepted = await adapter.accept({
      authorizationHeader: "Bearer test-token",
      body,
    });
    expect(accepted).not.toBeNull();
    expect(accepted?.trigger.kind).toBe("manual");
    expect(accepted?.taskSpec.prompt).toBe("fix flaky tests");
    expect(accepted?.taskSpec.repo.owner).toBe("acme");
    expect(accepted?.taskSpec.repo.headBranch).toBe("develop");
    expect(accepted?.surface).toEqual({
      kind: REST_WEBHOOK_SURFACE_KIND,
      payload: { callbackUrl: "https://example.com/hooks/pi" },
    });
  });

  it("POSTs lifecycle callbacks and does not throw when the callback fails", async () => {
    const calls: { url: string; body: string }[] = [];
    const sink = new HttpCallbackReportSink(async (url, init) => {
      calls.push({ url, body: init.body });
      return { ok: false, status: 503 };
    });
    const registry = new IntegrationRegistry();
    registry.registerAdapter(adapter);
    registry.registerSink(sink);

    const accepted = await adapter.accept({
      authorizationHeader: "Bearer test-token",
      body: {
        repo: "acme/demo",
        prompt: "ship it",
        callbackUrl: "https://example.com/cb",
      },
    });
    expect(accepted).not.toBeNull();
    if (!accepted) return;

    const resolved = registry.resolveSink(accepted.surface);
    expect(resolved).toBe(sink);

    await expect(
      resolved?.report(accepted.surface, {
        runId: "run_1",
        status: "running",
        terminal: false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolved?.report(accepted.surface, {
        runId: "run_1",
        status: "succeeded",
        detail: null,
        terminal: isTerminal("succeeded"),
      }),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://example.com/cb");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      runId: "run_1",
      status: "succeeded",
      terminal: true,
      detail: null,
    });
    expect(sink.failures).toEqual(["callback HTTP 503", "callback HTTP 503"]);
  });
});
