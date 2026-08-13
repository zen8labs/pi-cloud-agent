import { describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { getRun } from "../db/runs";
import {
  HttpCallbackReportSink,
  IntegrationRegistry,
  RestWebhookIngressAdapter,
} from "../integrations";
import { bindTestDatabase, seedTestUser, silentLogger, testConfig } from "../test-support";
import { createApp } from "./app";

let database: Database;

bindTestDatabase((db) => {
  database = db;
});

describe("REST webhook ingress", () => {
  it("is absent until a bearer token is configured", async () => {
    const seeded = await seedTestUser(database, testConfig());
    const app = createApp({
      config: testConfig({ WEBHOOK_USER_ID: seeded.userId }),
      database,
      log: silentLogger(),
      integrations: new IntegrationRegistry(),
    });
    expect((await app.request("/integrations/webhook", { method: "POST" })).status).toBe(404);
  });

  it("queues a run with a return address and POSTs a queued callback", async () => {
    const config = testConfig();
    const seeded = await seedTestUser(database, config);
    const calls: { url: string; body: string }[] = [];
    const integrations = new IntegrationRegistry();
    integrations.registerAdapter(new RestWebhookIngressAdapter("hook-secret"));
    integrations.registerSink(
      new HttpCallbackReportSink(async (url, init) => {
        calls.push({ url, body: init.body });
        return { ok: true, status: 200 };
      }),
    );
    const app = createApp({
      config: testConfig({
        WEBHOOK_BEARER_TOKEN: "hook-secret",
        WEBHOOK_USER_ID: seeded.userId,
      }),
      database,
      log: silentLogger(),
      integrations,
    });

    const unauthorized = await app.request("/integrations/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({
        repo: "acme/demo",
        prompt: "hi",
        callbackUrl: "https://cb.test/",
      }),
    });
    expect(unauthorized.status).toBe(401);

    const response = await app.request("/integrations/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer hook-secret",
      },
      body: JSON.stringify({
        repo: "acme/demo",
        prompt: "fix the flaky test",
        callbackUrl: "https://ci.example/hooks/pi",
        modelConnectionId: seeded.modelConnectionId,
        modelId: "test-model",
        thinkingLevel: "off",
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.status).toBe("queued");

    const run = await getRun(database, body.id);
    expect(run?.surfaceRef).toEqual({
      kind: "rest_webhook",
      payload: { callbackUrl: "https://ci.example/hooks/pi" },
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      runId: body.id,
      status: "queued",
      terminal: false,
    });
  });
});
