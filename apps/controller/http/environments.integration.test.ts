import type { RepositoryEnvironmentsResponse } from "@pi-cloud-agent/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { getRepositoryEnvironment, saveRepositoryEnvironment } from "../db/environments";
import { bindTestApp, seedTestUser, testConfig } from "../test-support";
import type { createApp } from "./app";

let database: Database;
let app: ReturnType<typeof createApp>;
const auth = { cookie: "", userId: "" };

bindTestApp((deps) => {
  database = deps.database;
  app = deps.app;
});

beforeEach(async () => Object.assign(auth, await seedTestUser(database, testConfig())));

function requestHeaders() {
  return {
    "Content-Type": "application/json",
    Cookie: `pca_session=${auth.cookie}`,
  };
}

describe("repository environments", () => {
  it("saves and lists a per-repository setup script", async () => {
    const response = await app.request("/environments", {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({
        provider: "github",
        repo: "acme/widgets",
        setupScript: "pnpm install\npython3 -m venv .venv",
      }),
    });
    expect(response.status).toBe(200);

    const listed = await app.request("/environments", {
      headers: { Cookie: `pca_session=${auth.cookie}` },
    });
    const body = (await listed.json()) as RepositoryEnvironmentsResponse;
    expect(body.environments).toHaveLength(1);
    expect(body.environments[0]).toMatchObject({
      provider: "github",
      repo: "acme/widgets",
      setupScript: "pnpm install\npython3 -m venv .venv",
    });
  });

  it("clears the app setting", async () => {
    await saveRepositoryEnvironment(database, {
      userId: auth.userId,
      provider: "github",
      repoFullName: "acme/widgets",
      setupScript: "pnpm install",
    });
    const response = await app.request("/environments", {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({ provider: "github", repo: "acme/widgets", setupScript: "  " }),
    });
    expect(response.status).toBe(200);
    await expect(
      getRepositoryEnvironment(database, auth.userId, "github", "acme/widgets"),
    ).resolves.toBeNull();
  });
});
