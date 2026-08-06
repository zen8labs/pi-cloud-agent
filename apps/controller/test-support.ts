import { randomBytes } from "node:crypto";
import type { Trigger } from "@pi-cloud-agent/protocol";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { type Config, configFrom } from "./config";
import { createWebSession, upsertAppUser } from "./db/auth";
import { closeDatabase, createDatabase, type Database } from "./db/client";
import { createRun } from "./db/runs";
import type { RunRow, SessionRow } from "./db/schema";
import { createSessionWithRun } from "./db/sessions";
import { createApp } from "./http/app";
import { saveApiKeyConnection } from "./llm/connections";
import { createLogger, type Logger } from "./logger";

/**
 * Shared setup for integration tests.
 *
 * These tests run against a real Postgres — `docker compose up -d db` — because
 * the behavior worth testing *is* the SQL: `for update skip locked`, guarded
 * transitions, and a sequence counter incremented in the same transaction as an
 * insert. A fake database would only test the mock. See docs/testing.md.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://pi_cloud_agent:pi_cloud_agent@localhost:5532/pi_cloud_agent_test";

/** Connect to the already-migrated test database. See test-global-setup.ts. */
export function setupTestDatabase(): Database {
  return createDatabase(TEST_DATABASE_URL);
}

/**
 * Shared Postgres lifecycle for an integration test file.
 * Assign with `bindTestDatabase((db) => { database = db; })` — do not destructure.
 */
export function bindTestDatabase(assign: (database: Database) => void): void {
  let database: Database;
  beforeAll(() => {
    database = setupTestDatabase();
    assign(database);
  });
  beforeEach(async () => {
    await resetTables(database);
  });
  afterAll(async () => {
    await closeDatabase(database);
  });
}

/** Postgres lifecycle plus a Hono app wired to the same database. */
export function bindTestApp(
  assign: (deps: { database: Database; app: ReturnType<typeof createApp> }) => void,
): void {
  bindTestDatabase((database) => {
    assign({
      database,
      app: createApp({ config: testConfig(), database, log: silentLogger() }),
    });
  });
}

export async function resetTables(database: Database): Promise<void> {
  await database.execute(
    sql`truncate table plugin_audit_log, plugin_oauth_tokens, plugin_oauth_clients, plugin_user_variables, plugin_user_state, plugin_settings, plugin_versions, plugins, llm_connections, web_sessions, oauth_states, vcs_connections, run_events, runs, sessions, app_users cascade`,
  );
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return configFrom({
    DATABASE_URL: TEST_DATABASE_URL,
    CONTROL_PLANE_URL: "http://localhost:8080",
    WEB_URL: "http://localhost:3000",
    APP_AUTH_REQUIRED: "false",
    APP_SESSION_SECRET: "test-session-secret-012345678901234567890123",
    VCS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    LLM_ENCRYPTION_KEY: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    GITHUB_APP_CLIENT_ID: "github-test-client",
    GITHUB_APP_CLIENT_SECRET: "github-test-secret",
    GITHUB_APP_REDIRECT_URI: "http://localhost:8080/auth/github/callback",
    AZURE_DEVOPS_CLIENT_ID: "azure-test-client",
    AZURE_DEVOPS_CLIENT_SECRET: "azure-test-secret",
    AZURE_DEVOPS_REDIRECT_URI: "http://localhost:8080/vcs/connections/azure-devops/callback",
    RUN_WALL_CLOCK_SECONDS: "600",
    LOG_LEVEL: "error",
    ...overrides,
  });
}

export async function seedTestUser(
  database: Database,
  config: Config,
): Promise<{ userId: string; cookie: string; modelConnectionId: string }> {
  const user = await upsertAppUser(database, {
    githubUserId: "default-test-user",
    login: "default-test-user",
    displayName: "Default Test User",
  });
  const cookie = await createWebSession(database, user.id, config.auth.sessionSecret);
  const connection = await saveApiKeyConnection(database, config, {
    userId: user.id,
    displayName: "Default test model",
    provider: "test-provider",
    api: "openai-completions",
    baseUrl: "https://model.example.test/v1",
    model: "test-model",
    apiKey: "test-key",
    contextWindow: 16_384,
    maxTokens: 2_048,
    isDefault: true,
  });
  return { userId: user.id, cookie, modelConnectionId: connection.id };
}

export function withTestModel(body: unknown, modelConnectionId: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  return {
    ...(body as Record<string, unknown>),
    modelConnectionId: (body as Record<string, unknown>).modelConnectionId ?? modelConnectionId,
    modelId: (body as Record<string, unknown>).modelId ?? "test-model",
    thinkingLevel: (body as Record<string, unknown>).thinkingLevel ?? "off",
  };
}

/**
 * Silent by design: several tests drive failure paths on purpose, and their logs
 * would read as though the suite were broken.
 */
export function silentLogger(): Logger {
  return createLogger("test", { level: "silent" });
}

export function manualTrigger(overrides: Partial<Trigger["repo"]> = {}): Trigger {
  return {
    kind: "manual",
    prompt: "Summarize this repository.",
    repo: {
      provider: "github",
      host: "github.com",
      owner: "acme",
      name: "widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
      defaultBranch: "main",
      baseSha: "",
      headSha: "",
      headBranch: "main",
      prNumber: null,
      ...overrides,
    },
  };
}

export async function seedRun(
  database: Database,
  overrides: { profile?: string; trigger?: Trigger; userId?: string } = {},
): Promise<RunRow> {
  const trigger = overrides.trigger ?? manualTrigger();
  return createRun(database, {
    userId: overrides.userId,
    profile: overrides.profile ?? "general",
    provider: trigger.repo.provider,
    repoFullName: `${trigger.repo.owner}/${trigger.repo.name}`,
    trigger,
    model: "test-provider/test-model",
    callbackToken: randomBytes(16).toString("hex"),
  });
}

export async function seedSession(
  database: Database,
  userId?: string,
): Promise<{ session: SessionRow; run: RunRow }> {
  const trigger = manualTrigger();
  return createSessionWithRun(database, {
    userId,
    title: "Summarize this repository",
    profile: "general",
    provider: trigger.repo.provider,
    repoFullName: `${trigger.repo.owner}/${trigger.repo.name}`,
    repo: trigger.repo,
    trigger,
    model: "test-provider/test-model",
    callbackToken: randomBytes(16).toString("hex"),
  });
}
