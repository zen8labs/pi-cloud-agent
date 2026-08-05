import type { RunListResponse } from "@pi-cloud-agent/protocol";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWebSession, upsertAppUser } from "../db/auth";
import { closeDatabase, type Database } from "../db/client";
import { completeRun, createRun } from "../db/runs";
import { oauthStates } from "../db/schema";
import { parkSession } from "../db/sessions";
import {
  manualTrigger,
  resetTables,
  seedSession,
  setupTestDatabase,
  silentLogger,
  testConfig,
} from "../test-support";
import { createApp } from "./app";

let database: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  database = setupTestDatabase();
  app = createApp({ config: testConfig(), database, log: silentLogger() });
});
beforeEach(async () => resetTables(database));
afterAll(async () => closeDatabase(database));

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
    expect(() => testConfig({ WEB_CORS_ORIGINS: "*" })).toThrow(
      "WEB_CORS_ORIGINS must list explicit origins",
    );
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
      model: "test-provider/test-model",
      callbackToken: "first-run-token",
    });
    const secondRun = await createRun(database, {
      userId: second.id,
      profile: "general",
      provider: "github",
      repoFullName: "acme/second",
      trigger: manualTrigger({ owner: "acme", name: "second" }),
      model: "test-provider/test-model",
      callbackToken: "second-run-token",
    });
    const cookie = await createWebSession(database, first.id, testConfig().auth.sessionSecret);
    const csrf = await secureApp.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: `pca_session=${cookie}`, Origin: "https://untrusted.example" },
    });
    expect(csrf.status).toBe(403);
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
    expect(
      (
        await secureApp.request(`/runs/${secondRun.id}`, {
          headers: { Cookie: `pca_session=${cookie}` },
        })
      ).status,
    ).toBe(404);

    const { session: foreignSession, run: foreignRun } = await seedSession(database, second.id);
    await completeRun(database, foreignRun.id, "succeeded", null);
    await parkSession(database, foreignRun, null, null);
    const foreignTurn = await secureApp.request(`/sessions/${foreignSession.id}/turns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `pca_session=${cookie}`,
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ prompt: "peek" }),
    });
    expect(foreignTurn.status).toBe(404);
  });

  it("uses the GitHub App callback for a Settings reconnect", async () => {
    const response = await app.request("/auth/github/connect?returnTo=settings");
    expect(response.status).toBe(302);
    const state = new URL(
      response.headers.get("location") ?? "https://github.com",
    ).searchParams.get("state");
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

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
