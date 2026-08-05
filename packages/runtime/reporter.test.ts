import { SANDBOX_ENV } from "@pi-cloud-agent/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeRedactor, readConfig } from "./config";
import { createReporter } from "./reporter";

/**
 * The reporter is the only thing inside the sandbox that talks to the outside, so
 * it is the right place to prove two properties: secrets do not travel with
 * telemetry, and the terminal status — the single thing that completes a run —
 * is delivered with retries while telemetry is not.
 */

const MODEL_KEY = "model-key-abcdefghijklmnop";
const SCM_TOKEN = "ghs_tokenvalue1234567890";
const CALLBACK_TOKEN = "callback-token-value-1234";

interface Sent {
  path: string;
  body: unknown;
}

let sent: Sent[];
let failNext: number;

beforeEach(() => {
  sent = [];
  failNext = 0;
  const env: Record<string, string> = {
    [SANDBOX_ENV.runId]: "run-1",
    [SANDBOX_ENV.controlPlaneUrl]: "https://controller.test",
    [SANDBOX_ENV.callbackToken]: CALLBACK_TOKEN,
    [SANDBOX_ENV.taskPrompt]: "do the thing",
    [SANDBOX_ENV.model]: "test-provider/test-model",
    [SANDBOX_ENV.modelApi]: "openai-completions",
    [SANDBOX_ENV.modelAuthType]: "api_key",
    [SANDBOX_ENV.modelBaseUrl]: "https://gateway.test/v1",
    [SANDBOX_ENV.modelApiKey]: MODEL_KEY,
    [SANDBOX_ENV.modelContextWindow]: "16384",
    [SANDBOX_ENV.modelMaxTokens]: "2048",
    [SANDBOX_ENV.repoCloneUrl]: "https://github.com/acme/widgets.git",
    [SANDBOX_ENV.repoName]: "widgets",
    [SANDBOX_ENV.scmToken]: SCM_TOKEN,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("network down");
      }
      sent.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return { ok: true } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("reporter", () => {
  it("scrubs secrets out of telemetry, however deeply nested", async () => {
    const reporter = createReporter(readConfig());
    reporter.event({
      type: "tool_call",
      data: {
        callId: "1",
        tool: "bash",
        status: "completed",
        args: { command: `curl -H "Authorization: Bearer ${MODEL_KEY}"` },
        output: `remote: https://x-access-token:${SCM_TOKEN}@github.com/acme/widgets.git`,
      },
    });
    await reporter.flush();

    const payload = JSON.stringify(sent[0]?.body);
    expect(payload).not.toContain(MODEL_KEY);
    expect(payload).not.toContain(SCM_TOKEN);
    expect(payload).toContain("[redacted]");
  });

  it("preserves the order events happened in, because seq is assigned on arrival", async () => {
    const reporter = createReporter(readConfig());
    for (const content of ["a", "b", "c"]) {
      reporter.event({ type: "token", data: { content } });
    }
    await reporter.flush();
    expect(
      sent.map((entry) => (entry.body as { data: { content: string } }).data.content),
    ).toEqual(["a", "b", "c"]);
  });

  it("swallows a telemetry failure — losing a log line must not fail a run", async () => {
    const reporter = createReporter(readConfig());
    failNext = 1;
    reporter.event({ type: "token", data: { content: "lost" } });
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("retries the terminal status, because nothing else completes a run", async () => {
    const reporter = createReporter(readConfig());
    failNext = 2;
    await reporter.status({ status: "done" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe("/internal/runs/run-1/status");
  });

  it("gives up loudly when the status cannot be delivered at all", async () => {
    const reporter = createReporter(readConfig());
    failNext = 10;
    await expect(reporter.status({ status: "done" })).rejects.toThrow(
      /could not report terminal status/,
    );
  });

  it("redacts secrets from a failure detail before reporting it", async () => {
    const reporter = createReporter(readConfig());
    await reporter.status({ status: "error", detail: `clone failed using ${SCM_TOKEN}` });
    expect(JSON.stringify(sent[0]?.body)).not.toContain(SCM_TOKEN);
  });

  it("uses the same redactor for stderr-bound failures", () => {
    const clean = createRuntimeRedactor();
    const output = clean(`model=${MODEL_KEY} callback=${CALLBACK_TOKEN}`);
    expect(output).not.toContain(MODEL_KEY);
    expect(output).not.toContain(CALLBACK_TOKEN);
    expect(output).toContain("[redacted]");
  });
});

describe("runtime config", () => {
  it("refuses to start without the values a run cannot work without", () => {
    vi.stubEnv(SANDBOX_ENV.taskPrompt, "");
    expect(() => readConfig()).toThrow(/TASK_PROMPT is required/);
  });

  it("rejects a model reference that is not provider/model", () => {
    vi.stubEnv(SANDBOX_ENV.model, "just-a-name");
    expect(() => readConfig()).toThrow(/must be "provider\/model"/);
  });
});
