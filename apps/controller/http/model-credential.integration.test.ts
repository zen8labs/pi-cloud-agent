import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { closeDatabase, type Database } from "../db/client";
import { createRun } from "../db/runs";
import { resolveLlmModelForRun, saveOAuthConnections } from "../llm/connections";
import {
  bindTestApp,
  manualTrigger,
  resetTables,
  seedTestUser,
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
  bindTestApp(app, database);
});

beforeEach(() => resetTables(database));
afterAll(() => closeDatabase(database));

it("persists a refreshed OAuth credential without letting a stale run overwrite it", async () => {
  const config = testConfig();
  const { userId } = await seedTestUser(database, config);
  const previous = {
    type: "oauth" as const,
    access: "old-access",
    refresh: "old-refresh",
    expires: 1,
    accountId: "account-1",
  };
  const refreshed = {
    ...previous,
    access: "new-access",
    refresh: "new-refresh",
    expires: 2,
  };
  const connection = await saveOAuthConnections(database, config, {
    userId,
    displayName: "Codex",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    models: [{ id: "codex", contextWindow: 1000, maxTokens: 100 }],
    credential: previous,
    isDefault: false,
  });
  const trigger = manualTrigger();
  const run = await createRun(database, {
    userId,
    profile: "general",
    provider: trigger.repo.provider,
    repoFullName: "acme/widgets",
    trigger,
    model: "openai-codex/codex",
    modelConnectionId: connection.id,
    callbackToken: randomBytes(16).toString("hex"),
  });
  const path = `/internal/runs/${run.id}/model-credential`;
  const request = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${run.callbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  expect(await (await request({ previous, credential: refreshed })).json()).toEqual({
    updated: true,
  });
  expect(
    (await resolveLlmModelForRun(database, config, userId, connection.id, "codex")).authJson,
  ).toBe(JSON.stringify(refreshed));

  const stale = await request({
    previous,
    credential: { ...refreshed, access: "stale-overwrite" },
  });
  expect(await stale.json()).toEqual({ updated: false });
  expect(
    (await resolveLlmModelForRun(database, config, userId, connection.id, "codex")).authJson,
  ).toBe(JSON.stringify(refreshed));
});
