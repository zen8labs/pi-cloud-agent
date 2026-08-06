import type {
  ConfigResponse,
  LlmConnectionsResponse,
  RunDetail,
  RunEventsResponse,
  RunListResponse,
  RunSummary,
  SessionSummary,
} from "@pi-cloud-agent/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createWebSession, upsertAppUser } from "../db/auth";
import type { Database } from "../db/client";
import { getRun } from "../db/runs";
import { parkSession } from "../db/sessions";
import { saveApiKeyConnection } from "../llm/connections";
import { createCredentialBroker } from "../secrets/broker";
import {
  bindTestApp,
  manualTrigger,
  seedRun,
  seedTestUser,
  silentLogger,
  testConfig,
  withTestModel,
} from "../test-support";
import { createApp } from "./app";

/**
 * The HTTP contract, exercised through the real app against real Postgres.
 *
 * Grouped by the thing being protected rather than by route: who may start a run,
 * who may report on one, and what a client watching a run is promised. The
 * authentication cases are the point — everything else is a shape check.
 */

let database: Database;
let app: ReturnType<typeof createApp>;
let testCookie: string;
let testUserId: string;
let testModelConnectionId: string;

bindTestApp((deps) => {
  database = deps.database;
  app = deps.app;
});

beforeEach(async () => {
  const config = testConfig();
  const seeded = await seedTestUser(database, config);
  testUserId = seeded.userId;
  testCookie = seeded.cookie;
  testModelConnectionId = seeded.modelConnectionId;
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `pca_session=${testCookie}`,
      ...headers,
    },
    body: JSON.stringify(withTestModel(body, testModelConnectionId)),
  });
}

/** Read a response body at a named type, so a renamed field fails to compile. */
async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("starting runs", () => {
  it("queues a run and echoes it back", async () => {
    const response = await post("/runs", {
      repo: "acme/widgets",
      prompt: "explain this repository",
      profile: "general",
    });
    expect(response.status).toBe(201);

    const run = (await response.json()) as RunSummary;
    expect(run.status).toBe("queued");
    expect(run.repo).toBe("acme/widgets");
    expect(run.model).toBe("test-provider/test-model");
    // The credential the sandbox will authenticate with is never returned.
    expect(JSON.stringify(run)).not.toContain("callbackToken");
  });

  it("validates the request shape and the repository name", async () => {
    expect((await post("/runs", { prompt: "no repo" })).status).toBe(422);
    expect((await post("/runs", { repo: "not-a-path", prompt: "hi" })).status).toBe(422);
    expect((await post("/runs", { repo: "acme/widgets", prompt: "" })).status).toBe(422);
  });

  it("reports an unknown profile by name", async () => {
    const response = await post("/runs", {
      repo: "acme/widgets",
      prompt: "hi",
      profile: "nope",
    });
    expect(response.status).toBe(422);
    expect((await json<{ error: string }>(response)).error).toContain('Unknown profile "nope"');
  });

  it("lists runs newest first", async () => {
    await seedRun(database, { userId: testUserId });
    await seedRun(database, { userId: testUserId });
    const body = (await (
      await app.request("/runs", { headers: { Cookie: `pca_session=${testCookie}` } })
    ).json()) as RunListResponse;
    expect(body.runs).toHaveLength(2);
    expect(new Date(body.runs[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(body.runs[1]!.createdAt).getTime(),
    );
  });

  it("answers 404 for a run that does not exist", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    const headers = { Cookie: `pca_session=${testCookie}` };
    expect((await app.request(`/runs/${missing}`, { headers })).status).toBe(404);
    expect((await app.request(`/runs/${missing}/events`, { headers })).status).toBe(404);
    expect((await post(`/runs/${missing}/cancel`, {})).status).toBe(404);
  });
});

describe("sandbox callbacks", () => {
  it("refuses a callback without the run's own token", async () => {
    const run = await seedRun(database, { userId: testUserId });
    const other = await seedRun(database);
    const event = { type: "token", data: { content: "hi" } };

    expect((await post(`/internal/runs/${run.id}/events`, event)).status).toBe(403);
    expect(
      (await post(`/internal/runs/${run.id}/events`, event, { Authorization: "Bearer wrong" }))
        .status,
    ).toBe(403);
    // A valid token for a different run is still not valid for this one.
    expect(
      (
        await post(`/internal/runs/${run.id}/events`, event, {
          Authorization: `Bearer ${other.callbackToken}`,
        })
      ).status,
    ).toBe(403);
  });

  it("accepts telemetry and assigns it a sequence number", async () => {
    const run = await seedRun(database, { userId: testUserId });
    const response = await post(
      `/internal/runs/${run.id}/events`,
      { type: "token", data: { content: "hello" } },
      { Authorization: `Bearer ${run.callbackToken}` },
    );
    expect(response.status).toBe(200);
    expect((await json<{ seq: number }>(response)).seq).toBe(1);
  });

  it("rejects an event shape it does not recognize", async () => {
    const run = await seedRun(database, { userId: testUserId });
    const response = await post(
      `/internal/runs/${run.id}/events`,
      { type: "not_a_thing", data: {} },
      { Authorization: `Bearer ${run.callbackToken}` },
    );
    expect(response.status).toBe(422);
  });

  it("strips credentials that a payload leaked in a URL", async () => {
    const run = await seedRun(database, { userId: testUserId });
    await post(
      `/internal/runs/${run.id}/events`,
      {
        type: "log",
        data: {
          event: "git.error",
          detail: "https://x-access-token:ghs_leak@github.com/a/b.git",
        },
      },
      { Authorization: `Bearer ${run.callbackToken}` },
    );

    const { events } = await json<RunEventsResponse>(
      await app.request(`/runs/${run.id}/events`, {
        headers: { Cookie: `pca_session=${testCookie}` },
      }),
    );
    expect(JSON.stringify(events)).not.toContain("ghs_leak");
    expect(JSON.stringify(events)).toContain("***@github.com");
  });

  it("completes the run when the agent reports done", async () => {
    const run = await seedRun(database, { userId: testUserId });
    const response = await post(
      `/internal/runs/${run.id}/status`,
      { status: "done" },
      { Authorization: `Bearer ${run.callbackToken}` },
    );
    expect(response.status).toBe(200);
    expect((await getRun(database, run.id))?.status).toBe("succeeded");
  });

  it("fails the run when the agent reports an error, keeping the reason", async () => {
    const run = await seedRun(database, { userId: testUserId });
    await post(
      `/internal/runs/${run.id}/status`,
      { status: "error", detail: "clone failed" },
      { Authorization: `Bearer ${run.callbackToken}` },
    );

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toBe("clone failed");

    // The reason is in the log too, so it survives even if the transition raced.
    const { events } = await json<RunEventsResponse>(
      await app.request(`/runs/${run.id}/events`, {
        headers: { Cookie: `pca_session=${testCookie}` },
      }),
    );
    expect(events.at(-1)?.type).toBe("status");
  });
});

describe("cancelling", () => {
  it("marks the run cancelled and leaves teardown to the reconciler", async () => {
    const run = await seedRun(database, { userId: testUserId });
    const response = await post(`/runs/${run.id}/cancel`, {});
    expect(response.status).toBe(200);

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.sandboxStoppedAt).toBeNull();
  });

  it("is a no-op on a run that already finished", async () => {
    const run = await seedRun(database, { userId: testUserId });
    await post(
      `/internal/runs/${run.id}/status`,
      { status: "done" },
      { Authorization: `Bearer ${run.callbackToken}` },
    );

    const response = await post(`/runs/${run.id}/cancel`, {});
    expect((await json<{ status: string }>(response)).status).toBe("succeeded");
  });
});

describe("watching a run", () => {
  it("streams history then closes once the run is terminal", async () => {
    const run = await seedRun(database, { userId: testUserId });
    for (const content of ["a", "b"]) {
      await post(
        `/internal/runs/${run.id}/events`,
        { type: "token", data: { content } },
        { Authorization: `Bearer ${run.callbackToken}` },
      );
    }
    await post(
      `/internal/runs/${run.id}/status`,
      { status: "done" },
      { Authorization: `Bearer ${run.callbackToken}` },
    );

    const body = await (
      await app.request(`/runs/${run.id}/stream`, {
        headers: { Cookie: `pca_session=${testCookie}` },
      })
    ).text();
    // Every data frame carries its sequence number: that is what makes a
    // reconnect resumable rather than duplicating or skipping events.
    expect(body).toContain("id: 1");
    expect(body).toContain("id: 2");
    expect(body).toContain("event: status");
    expect(body).toContain("event: end");
  });

  it("resumes from a cursor without replaying what the client already has", async () => {
    const run = await seedRun(database, { userId: testUserId });
    for (const content of ["a", "b", "c"]) {
      await post(
        `/internal/runs/${run.id}/events`,
        { type: "token", data: { content } },
        { Authorization: `Bearer ${run.callbackToken}` },
      );
    }
    await post(
      `/internal/runs/${run.id}/status`,
      { status: "done" },
      { Authorization: `Bearer ${run.callbackToken}` },
    );

    const resumed = await (
      await app.request(`/runs/${run.id}/stream`, {
        headers: { Cookie: `pca_session=${testCookie}`, "last-event-id": "2" },
      })
    ).text();
    expect(resumed).not.toContain("id: 1");
    expect(resumed).not.toContain("id: 2");
    expect(resumed).toContain("id: 3");
  });

  it("exposes the request the agent was given", async () => {
    const run = await seedRun(database, { userId: testUserId });
    const detail = (await (
      await app.request(`/runs/${run.id}`, {
        headers: { Cookie: `pca_session=${testCookie}` },
      })
    ).json()) as RunDetail;
    expect(detail.prompt).toBe(manualTrigger().prompt);
  });
});

describe("dashboard support", () => {
  it("reports the registered profiles and model-selection policy", async () => {
    const config = await json<ConfigResponse>(await app.request("/config"));
    expect(config.defaultProfile).toBe("general");
    expect(config.profiles.map((profile) => profile.name)).toEqual(["general"]);
  });

  it("is healthy", async () => {
    expect((await json<{ ok: boolean }>(await app.request("/healthz"))).ok).toBe(true);
  });
});

describe("model connections", () => {
  it("stores credentials per user and snapshots the selected connection on a run", async () => {
    const secureApp = createApp({
      config: testConfig({ APP_AUTH_REQUIRED: "true" }),
      database,
      log: silentLogger(),
    });
    const user = await upsertAppUser(database, {
      githubUserId: "model-user",
      login: "model-user",
      displayName: "Model User",
    });
    const cookie = await createWebSession(database, user.id, testConfig().auth.sessionSecret);
    const created = await secureApp.request("/llm/connections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `pca_session=${cookie}`,
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        displayName: "Test LiteLLM",
        provider: "litellm",
        api: "openai-completions",
        baseUrl: "https://llm.example.test/v1",
        model: "gpt-test",
        apiKey: "super-secret-api-key",
        isDefault: true,
      }),
    });
    expect(created.status).toBe(201);
    const connection = await json<{ id: string; isDefault: boolean }>(created);
    expect(connection.isDefault).toBe(true);
    expect(JSON.stringify(connection)).not.toContain("super-secret-api-key");

    const listed = await json<LlmConnectionsResponse>(
      await secureApp.request("/llm/connections", {
        headers: { Cookie: `pca_session=${cookie}` },
      }),
    );
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]?.id).toBe(connection.id);

    const queued = await secureApp.request("/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `pca_session=${cookie}`,
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        repo: "acme/widgets",
        prompt: "use my model",
        modelConnectionId: connection.id,
        modelId: "gpt-test",
        thinkingLevel: "off",
      }),
    });
    expect(queued.status).toBe(201);
    const run = await json<RunSummary>(queued);
    expect(run.model).toBe("litellm/gpt-test");
    expect(run.modelConnectionId).toBe(connection.id);
    const deletion = await secureApp.request(`/llm/connections/${connection.id}`, {
      method: "DELETE",
      headers: { Cookie: `pca_session=${cookie}`, Origin: "http://localhost:3000" },
    });
    expect(deletion.status).toBe(200);
    expect(
      (
        await json<LlmConnectionsResponse>(
          await secureApp.request("/llm/connections", {
            headers: { Cookie: `pca_session=${cookie}` },
          }),
        )
      ).connections,
    ).toHaveLength(0);

    expect((await secureApp.request("/llm/connections")).status).toBe(401);
  });

  it("lets a resumed session explicitly switch away from a deleted connection", async () => {
    const secureApp = createApp({
      config: testConfig({ APP_AUTH_REQUIRED: "true" }),
      database,
      log: silentLogger(),
    });
    const user = await upsertAppUser(database, {
      githubUserId: "session-model-user",
      login: "session-model-user",
      displayName: "Session Model User",
    });
    const config = testConfig();
    const cookie = await createWebSession(database, user.id, config.auth.sessionSecret);
    const original = await saveApiKeyConnection(database, config, {
      userId: user.id,
      displayName: "Original model",
      provider: "original-provider",
      api: "openai-completions",
      baseUrl: "https://original.example/v1",
      model: "original-model",
      apiKey: "original-key",
      contextWindow: 16_384,
      maxTokens: 2_048,
      isDefault: true,
    });
    const replacement = await saveApiKeyConnection(database, config, {
      userId: user.id,
      displayName: "Replacement model",
      provider: "replacement-provider",
      api: "openai-completions",
      baseUrl: "https://replacement.example/v1",
      model: "replacement-model",
      apiKey: "replacement-key",
      contextWindow: 16_384,
      maxTokens: 2_048,
      isDefault: false,
    });
    const session = await json<SessionSummary>(
      await secureApp.request("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `pca_session=${cookie}` },
        body: JSON.stringify({
          repo: "acme/widgets",
          prompt: "Use the original model",
          profile: "general",
          modelConnectionId: original.id,
          modelId: "original-model",
          thinkingLevel: "off",
        }),
      }),
    );
    const firstRun = await getRun(database, session.latestRunId);
    expect(firstRun).not.toBeNull();
    expect(await parkSession(database, firstRun!, null, null)).toBe(true);

    expect(
      (
        await secureApp.request(`/llm/connections/${original.id}`, {
          method: "DELETE",
          headers: { Cookie: `pca_session=${cookie}` },
        })
      ).status,
    ).toBe(200);

    const broker = createCredentialBroker(config, database, silentLogger());
    const inFlight = await broker.mintForRun({
      userId: user.id,
      provider: "github",
      repoFullName: "acme/widgets",
      modelConnectionId: original.id,
      modelSnapshot: "original-provider/original-model",
    });
    expect(inFlight.model.name).toBe("original-model");

    const followUp = await secureApp.request(`/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `pca_session=${cookie}` },
      body: JSON.stringify({
        prompt: "Use the replacement model",
        modelConnectionId: replacement.id,
        modelId: "replacement-model",
        thinkingLevel: "off",
      }),
    });
    expect(followUp.status).toBe(201);
    const run = await json<RunDetail>(followUp);
    expect(run.model).toBe("replacement-provider/replacement-model");
    expect(run.modelConnectionId).toBe(replacement.id);
  });
});
