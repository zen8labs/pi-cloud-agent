import { isTerminal } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import {
  IntegrationRegistry,
  MEMORY_SURFACE_KIND,
  MemoryIngressAdapter,
  MemoryReportSink,
} from "./index";

const sampleRepo = {
  provider: "github",
  host: "github.com",
  owner: "acme",
  name: "demo",
  cloneUrl: "https://github.com/acme/demo.git",
  defaultBranch: "main",
  baseSha: "",
  headSha: "",
  headBranch: "main",
  prNumber: null,
};

describe("ZEN-92 integration substrate", () => {
  it("rejects a bad secret and accepts a verified payload into core shapes", async () => {
    const adapter = new MemoryIngressAdapter("correct-secret");

    expect(
      await adapter.accept({ secret: "wrong", prompt: "hi", repo: sampleRepo }),
    ).toBeNull();

    const accepted = await adapter.accept({
      secret: "correct-secret",
      prompt: "fix the flaky test",
      repo: sampleRepo,
      surfacePayload: { callbackId: "cb-1" },
    });

    expect(accepted).not.toBeNull();
    expect(accepted?.taskSpec.prompt).toBe("fix the flaky test");
    expect(accepted?.trigger.kind).toBe("manual");
    expect(accepted?.surface).toEqual({
      kind: MEMORY_SURFACE_KIND,
      payload: { callbackId: "cb-1" },
    });
  });

  it("resolves a sink by surface kind and records lifecycle reports only", async () => {
    const registry = new IntegrationRegistry();
    const adapter = new MemoryIngressAdapter("s");
    const sink = new MemoryReportSink();
    registry.registerAdapter(adapter);
    registry.registerSink(sink);

    const accepted = await registry.getAdapter(MEMORY_SURFACE_KIND)?.accept({
      secret: "s",
      prompt: "ship it",
      repo: sampleRepo,
    });
    expect(accepted).not.toBeNull();
    if (!accepted) return;

    const resolved = registry.resolveSink(accepted.surface);
    expect(resolved).toBe(sink);

    // Lifecycle path we will hook later — not agent findings.
    await resolved?.report(accepted.surface, {
      runId: "run_1",
      status: "running",
      terminal: false,
    });
    await resolved?.report(accepted.surface, {
      runId: "run_1",
      status: "succeeded",
      detail: null,
      terminal: isTerminal("succeeded"),
    });

    expect(sink.reports).toHaveLength(2);
    expect(sink.reports[1]?.terminal).toBe(true);
    expect(sink.reports.every((r) => r.status !== undefined)).toBe(true);
  });

  it("refuses duplicate adapter or sink registration", () => {
    const registry = new IntegrationRegistry();
    registry.registerAdapter(new MemoryIngressAdapter("a"));
    registry.registerSink(new MemoryReportSink());

    expect(() => registry.registerAdapter(new MemoryIngressAdapter("b"))).toThrow(
      /already registered/,
    );
    expect(() => registry.registerSink(new MemoryReportSink())).toThrow(/already registered/);
  });
});
