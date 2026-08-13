import type {
  RepositoryEnvironmentsResponse,
  SandboxProvider,
  SandboxSpec,
} from "@pi-cloud-agent/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { getRepositoryEnvironment, saveRepositoryEnvironment } from "../db/environments";
import { createCredentialBroker } from "../secrets/broker";
import { bindTestDatabase, seedTestUser, silentLogger, testConfig } from "../test-support";
import type { createApp } from "./app";
import { createApp as buildApp } from "./app";

let database: Database;
let app: ReturnType<typeof createApp>;
const auth = { cookie: "", userId: "" };

let executedSpec: SandboxSpec | null = null;
const sandbox: SandboxProvider = {
  name: "fake",
  async execute(spec) {
    executedSpec = spec;
    return { code: 0, stdout: "node v22.23.2\nPython 3.11.2", stderr: "" };
  },
  async create() {
    return { provider: "fake", id: "unused" };
  },
  async resume(ref) {
    return ref;
  },
  async suspend(ref) {
    return ref;
  },
  async deleteWorkspace() {},
  async stop() {},
};

bindTestDatabase((value) => {
  database = value;
  app = buildApp({
    config: testConfig(),
    database,
    log: silentLogger(),
    broker: createCredentialBroker(testConfig(), database, silentLogger()),
    sandbox,
  });
});

beforeEach(async () => Object.assign(auth, await seedTestUser(database, testConfig())));

function requestHeaders() {
  return {
    "Content-Type": "application/json",
    Cookie: `pca_session=${auth.cookie}`,
  };
}

describe("repository environments", () => {
  beforeEach(() => {
    executedSpec = null;
  });

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

  it("tests an unsaved setup script in a disposable sandbox", async () => {
    const response = await app.request("/environments/test", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        provider: "github",
        repo: "acme/widgets",
        setupScript: "python -V\nnode --version",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      output: "node v22.23.2\nPython 3.11.2",
    });
    expect(executedSpec?.env.REPO_CLONE_URL).toBe("https://github.com/acme/widgets.git");
    expect(executedSpec?.command).toMatch(/^set -eu\n/);
    expect(executedSpec?.command).toContain("git clone --depth 1");
    expect(executedSpec?.command).toContain(`if [ -n "\${SCM_TOKEN:-}" ]; then`);
    expect(executedSpec?.command).toContain("unset BASH_ENV ENV NODE_ENV");
    expect(executedSpec?.command).toContain(
      "timeout --signal=KILL 300s bash --noprofile --norc -e -u -o pipefail",
    );
  });
});
