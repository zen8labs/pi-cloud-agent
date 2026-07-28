import { createHmac } from "node:crypto";
import type {
  ConfigResponse,
  RepoConfigResponse,
  RunDetail,
  RunEventsResponse,
  RunListResponse,
  RunSummary,
} from "@pi-cloud-agent/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../db/client";
import { getRun } from "../db/runs";
import {
  manualTrigger,
  resetTables,
  seedRun,
  setupTestDatabase,
  silentLogger,
  testConfig,
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

const WEBHOOK_SECRET = "test-webhook-secret";

beforeAll(async () => {
  database = setupTestDatabase();
  app = createApp({ config: testConfig(), database, log: silentLogger() });
});

beforeEach(async () => {
  await resetTables(database);
});

afterAll(async () => {
  await closeDatabase(database);
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
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
    expect(run.model).toBe("aigateway/test-model");
    // The credential the sandbox will authenticate with is never returned.
    expect(JSON.stringify(run)).not.toContain("callbackToken");
  });

  it("rejects a request the chosen profile would not accept", async () => {
    // pr-review without a pull request would fail inside a sandbox; better to say
    // so before anything is written.
    const response = await post("/runs", {
      repo: "acme/widgets",
      prompt: "review it",
      profile: "pr-review",
    });
    expect(response.status).toBe(422);
    expect((await json<{ error: string }>(response)).error).toContain("does not accept");
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
    await seedRun(database);
    await seedRun(database);
    const body = (await (await app.request("/runs")).json()) as RunListResponse;
    expect(body.runs).toHaveLength(2);
    expect(new Date(body.runs[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(body.runs[1]!.createdAt).getTime(),
    );
  });

  it("answers 404 for a run that does not exist", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    expect((await app.request(`/runs/${missing}`)).status).toBe(404);
    expect((await app.request(`/runs/${missing}/events`)).status).toBe(404);
    expect((await post(`/runs/${missing}/cancel`, {})).status).toBe(404);
  });
});

describe("sandbox callbacks", () => {
  it("refuses a callback without the run's own token", async () => {
    const run = await seedRun(database);
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
    const run = await seedRun(database);
    const response = await post(
      `/internal/runs/${run.id}/events`,
      { type: "token", data: { content: "hello" } },
      { Authorization: `Bearer ${run.callbackToken}` },
    );
    expect(response.status).toBe(200);
    expect((await json<{ seq: number }>(response)).seq).toBe(1);
  });

  it("rejects an event shape it does not recognize", async () => {
    const run = await seedRun(database);
    const response = await post(
      `/internal/runs/${run.id}/events`,
      { type: "not_a_thing", data: {} },
      { Authorization: `Bearer ${run.callbackToken}` },
    );
    expect(response.status).toBe(422);
  });

  it("strips credentials that a payload leaked in a URL", async () => {
    const run = await seedRun(database);
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
      await app.request(`/runs/${run.id}/events`),
    );
    expect(JSON.stringify(events)).not.toContain("ghs_leak");
    expect(JSON.stringify(events)).toContain("***@github.com");
  });

  it("completes the run when the agent reports done", async () => {
    const run = await seedRun(database);
    const response = await post(
      `/internal/runs/${run.id}/status`,
      { status: "done" },
      { Authorization: `Bearer ${run.callbackToken}` },
    );
    expect(response.status).toBe(200);
    expect((await getRun(database, run.id))?.status).toBe("succeeded");
  });

  it("fails the run when the agent reports an error, keeping the reason", async () => {
    const run = await seedRun(database);
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
      await app.request(`/runs/${run.id}/events`),
    );
    expect(events.at(-1)?.type).toBe("status");
  });
});

describe("cancelling", () => {
  it("marks the run cancelled and leaves teardown to the reconciler", async () => {
    const run = await seedRun(database);
    const response = await post(`/runs/${run.id}/cancel`, {});
    expect(response.status).toBe(200);

    const stored = await getRun(database, run.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.sandboxStoppedAt).toBeNull();
  });

  it("is a no-op on a run that already finished", async () => {
    const run = await seedRun(database);
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
    const run = await seedRun(database);
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

    const body = await (await app.request(`/runs/${run.id}/stream`)).text();
    // Every data frame carries its sequence number: that is what makes a
    // reconnect resumable rather than duplicating or skipping events.
    expect(body).toContain("id: 1");
    expect(body).toContain("id: 2");
    expect(body).toContain("event: status");
    expect(body).toContain("event: end");
  });

  it("resumes from a cursor without replaying what the client already has", async () => {
    const run = await seedRun(database);
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
      await app.request(`/runs/${run.id}/stream`, { headers: { "last-event-id": "2" } })
    ).text();
    expect(resumed).not.toContain("id: 1");
    expect(resumed).not.toContain("id: 2");
    expect(resumed).toContain("id: 3");
  });

  it("exposes the request the agent was given", async () => {
    const run = await seedRun(database);
    const detail = (await (await app.request(`/runs/${run.id}`)).json()) as RunDetail;
    expect(detail.prompt).toBe(manualTrigger().prompt);
  });
});

describe("webhook intake", () => {
  const body = JSON.stringify({
    action: "opened",
    repository: {
      name: "widgets",
      owner: { login: "acme" },
      html_url: "https://github.com/acme/widgets",
      clone_url: "https://github.com/acme/widgets.git",
      default_branch: "main",
    },
    pull_request: {
      number: 7,
      head: { sha: "headsha", ref: "feature" },
      base: { sha: "basesha" },
    },
  });

  const signature = () =>
    `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;

  it("answers 401 to an unsigned or forged delivery", async () => {
    const forged = await app.request("/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=bad" },
      body,
    });
    expect(forged.status).toBe(401);
  });

  it("starts a run for every profile that accepts the event", async () => {
    const response = await app.request("/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "pull_request", "x-hub-signature-256": signature() },
      body,
    });
    expect(response.status).toBe(202);

    const { runs: started } = (await response.json()) as { runs: string[] };
    expect(started).toHaveLength(1);

    const run = await getRun(database, started[0]!);
    // pr-review claimed it; general declined because there is no human request.
    expect(run?.profile).toBe("pr-review");
    expect(run?.trigger.repo.prNumber).toBe(7);
  });

  it("respects a repo that has turned the trigger off", async () => {
    await app.request("/settings/repo-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "acme/widgets",
        profile: "pr-review",
        config: { onOpened: false },
      }),
    });

    const response = await app.request("/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "pull_request", "x-hub-signature-256": signature() },
      body,
    });
    // Understood, deliberately ignored — not an error.
    expect(response.status).toBe(204);
    expect(((await (await app.request("/runs")).json()) as RunListResponse).runs).toHaveLength(
      0,
    );
  });

  it("answers 204 to an event no profile wants", async () => {
    const closed = body.replace('"action":"opened"', '"action":"closed"');
    const response = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(closed).digest("hex")}`,
      },
      body: closed,
    });
    expect(response.status).toBe(204);
  });

  it("answers 404 for a forge it does not know", async () => {
    expect((await post("/webhooks/perforce", {})).status).toBe(404);
  });
});

describe("dashboard support", () => {
  it("reports the model and the profiles with their settings schemas", async () => {
    const config = await json<ConfigResponse>(await app.request("/config"));
    expect(config.model).toBe("aigateway/test-model");
    expect(config.defaultProfile).toBe("general");

    const review = config.profiles.find((profile) => profile.name === "pr-review");
    const schema = review?.configJsonSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.onOpened).toBeDefined();
  });

  it("validates stored profile config with the profile's own schema", async () => {
    const bad = await app.request("/settings/repo-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "acme/widgets",
        profile: "pr-review",
        config: { onOpened: "yes please" },
      }),
    });
    expect(bad.status).toBe(422);
  });

  it("stores config with the profile's defaults applied", async () => {
    await app.request("/settings/repo-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "acme/widgets",
        profile: "pr-review",
        config: { branch: "release" },
      }),
    });

    const stored = await json<RepoConfigResponse>(await app.request("/settings/repo-config"));
    expect(stored.entries[0]?.config).toMatchObject({
      branch: "release",
      onOpened: true,
      onUpdated: true,
    });
    expect(stored.repos).toContain("acme/widgets");
  });

  it("is healthy", async () => {
    expect((await json<{ ok: boolean }>(await app.request("/healthz"))).ok).toBe(true);
  });
});
