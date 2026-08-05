import { randomBytes } from "node:crypto";
import type { Trigger } from "@pi-cloud-agent/protocol";
import { sql } from "drizzle-orm";
import { type Config, configFrom } from "./config";
import { createDatabase, type Database } from "./db/client";

import { createRun } from "./db/runs";
import type { RunRow, SessionRow } from "./db/schema";
import { createSessionWithRun } from "./db/sessions";
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

export async function resetTables(database: Database): Promise<void> {
  await database.execute(
    sql`truncate table web_sessions, oauth_states, vcs_connections, observability_exports, run_events, runs, sessions, app_users cascade`,
  );
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return configFrom({
    DATABASE_URL: TEST_DATABASE_URL,
    CONTROL_PLANE_URL: "http://localhost:8080",
    AGENT_MODEL: "aigateway/test-model",
    AIGATEWAY_BASE_URL: "https://gateway.test/v1",
    AIGATEWAY_API_KEY: "test-model-key-0123456789",
    WEB_URL: "http://localhost:3000",
    APP_AUTH_REQUIRED: "false",
    APP_SESSION_SECRET: "test-session-secret-012345678901234567890123",
    VCS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
  overrides: { profile?: string; trigger?: Trigger } = {},
): Promise<RunRow> {
  const trigger = overrides.trigger ?? manualTrigger();
  return createRun(database, {
    profile: overrides.profile ?? "general",
    provider: trigger.repo.provider,
    repoFullName: `${trigger.repo.owner}/${trigger.repo.name}`,
    trigger,
    model: "aigateway/test-model",
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
    model: "aigateway/test-model",
    callbackToken: randomBytes(16).toString("hex"),
  });
}
