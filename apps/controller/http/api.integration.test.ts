import type {
  ConfigResponse,
  RunDetail,
  RunEventsResponse,
  RunListResponse,
  RunSummary,
} from "@pi-cloud-agent/protocol";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWebSession, upsertAppUser } from "../db/auth";
import { closeDatabase, type Database } from "../db/client";
import { createRun, getRun } from "../db/runs";
import { oauthStates } from "../db/schema";
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

describe("browser boundary", () => {
  it("allows the local dashboard origin without admitting arbitrary websites", async () => {
    const allowed = await app.request("/healthz", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");

    const denied = await app.request("/healthz", {
      headers: { Origin: "https://untrusted.example" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const openApp = createApp({
      config: testConfig({ WEB_CORS_ORIGINS: "*" }),
      database,
      log: silentLogger(),
    });
    const explicitWildcard = await openApp.request("/healthz", {
      headers: { Origin: "https://operator.example" },
    });
    expect(explicitWildcard.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("requires a session and scopes runs to the signed-in user", async () => {
    const secureApp = createApp({
      config: testConfig({ APP_AUTH_REQUIRED: "true" }),
      database,
      log: silentLogger(),
    });
    const first = await upsertAppUser(database, {
      githubUserId: "github-1",
      login: "first",
      displayName: "First User",
    });
    const second = await upsertAppUser(database, {
      githubUserId: "github-2",
      login: "second",
      displayName: "Second User",
    });
    const firstRun = await createRun(database, {
      userId: first.id,
      profile: "general",
      provider: "github",
      repoFullName: "acme/first",
      trigger: manualTrigger({ owner: "acme", name: "first" }),
      model: "aigateway/test-model",
      callbackToken: "first-run-token",
    });
    const secondRun = await createRun(database, {
      userId: second.id,
      profile: "general",
      provider: "github",
      repoFullName: "acme/second",
      trigger: manualTrigger({ owner: "acme", name: "second" }),
      model: "aigateway/test-model",
      callbackToken: "second-run-token",
    });
    expect(firstRun.userId).toBe(first.id);
    expect(secondRun.userId).toBe(second.id);
    const cookie = await createWebSession(database, first.id, testConfig().auth.sessionSecret);

    expect((await secureApp.request("/runs")).status).toBe(401);
    const me = await secureApp.request("/auth/me", {
      headers: { Cookie: `pca_session=${cookie}` },
    });
    expect(me.status).toBe(200);
    expect((await json<{ login: string }>(me)).login).toBe("first");

    const listed = await secureApp.request("/runs", {
      headers: { Cookie: `pca_session=${cookie}` },
    });
    expect((await json<RunListResponse>(listed)).runs.map((run) => run.id)).toEqual([
      firstRun.id,
    ]);
    const other = await secureApp.request(`/runs/${secondRun.id}`, {
      headers: { Cookie: `pca_session=${cookie}` },
    });
    expect(other.status).toBe(404);
  });

  it("uses the GitHub App callback for a Settings reconnect", async () => {
    const response = await app.request("/auth/github/connect?returnTo=settings");
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const state = new URL(location ?? "https://github.com").searchParams.get("state");
    expect(state).toBeTruthy();

    const [saved] = await database
      .select()
      .from(oauthStates)
      .where(and(eq(oauthStates.state, state ?? ""), eq(oauthStates.provider, "github")));
    expect(saved?.returnTo).toBe("settings");
  });

  it("preserves the provider denial reason for the Settings notification", async () => {
    const response = await app.request(
      "/vcs/connections/azure-devops/callback?error=access_denied&error_description=Admin%20consent%20is%20required",
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "https://example.test");
    expect(location.pathname).toBe("/settings");
    expect(location.searchParams.get("connection")).toBe("connection_denied");
    expect(location.searchParams.get("message")).toBe(
      "Admin consent is required (access_denied)",
    );
  });
});

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

describe("dashboard support", () => {
  it("reports the model and the registered profiles", async () => {
    const config = await json<ConfigResponse>(await app.request("/config"));
    expect(config.model).toBe("aigateway/test-model");
    expect(config.defaultProfile).toBe("general");
    expect(config.profiles.map((profile) => profile.name)).toEqual(["general"]);
  });

  it("is healthy", async () => {
    expect((await json<{ ok: boolean }>(await app.request("/healthz"))).ok).toBe(true);
  });
});
