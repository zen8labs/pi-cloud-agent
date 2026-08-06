import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertAppUser } from "../db/auth";
import { closeDatabase, type Database } from "../db/client";
import { runs } from "../db/schema";
import { createCredentialBroker } from "../secrets/broker";
import {
  resetTables,
  seedRun,
  setupTestDatabase,
  silentLogger,
  testConfig,
} from "../test-support";
import { saveOAuthConnections } from "./connections";

let database: Database;

beforeAll(() => {
  database = setupTestDatabase();
});
beforeEach(async () => resetTables(database));
afterAll(async () => closeDatabase(database));

describe("model connection revisions", () => {
  it("keeps a queued run on its immutable OAuth connection revision", async () => {
    const config = testConfig();
    const user = await upsertAppUser(database, {
      githubUserId: "oauth-revision-user",
      login: "oauth-revision-user",
      displayName: "OAuth Revision User",
    });
    const first = await saveOAuthConnections(database, config, {
      userId: user.id,
      displayName: "Subscription",
      provider: "subscription-provider",
      api: "openai-responses",
      baseUrl: "https://models.example/v1",
      models: [{ id: "old-model", contextWindow: 16_384, maxTokens: 2_048 }],
      credential: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1 },
      isDefault: true,
    });
    const queued = await seedRun(database, { userId: user.id });
    await database
      .update(runs)
      .set({ model: "subscription-provider/old-model", modelConnectionId: first.id })
      .where(eq(runs.id, queued.id));

    const second = await saveOAuthConnections(database, config, {
      userId: user.id,
      displayName: "Subscription",
      provider: "subscription-provider",
      api: "openai-responses",
      baseUrl: "https://models.example/v1",
      models: [{ id: "new-model", contextWindow: 32_768, maxTokens: 4_096 }],
      credential: { type: "oauth", access: "new-access", refresh: "new-refresh", expires: 2 },
      isDefault: true,
    });

    expect(second.id).not.toBe(first.id);
    const historical = await createCredentialBroker(
      config,
      database,
      silentLogger(),
    ).mintForRun({
      userId: user.id,
      provider: "github",
      repoFullName: "acme/widgets",
      modelConnectionId: first.id,
      modelSnapshot: "subscription-provider/old-model",
    });
    expect(historical.model.name).toBe("old-model");
    expect(historical.model.apiKey).toBe("old-access");
  });
});
