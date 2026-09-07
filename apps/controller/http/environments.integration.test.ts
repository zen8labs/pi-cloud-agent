import type {
  RepositoryEnvironmentsResponse,
  SandboxProvider,
  SandboxSpec,
} from "@pi-cloud-agent/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { getRepositorySandboxImage, saveRepositorySandboxImage } from "../db/environments";
import { completeRun } from "../db/runs";
import { getSession, parkSession } from "../db/sessions";
import { createCredentialBroker } from "../secrets/broker";
import {
  bindTestDatabase,
  seedSession,
  seedTestUser,
  silentLogger,
  testConfig,
} from "../test-support";
import type { createApp } from "./app";
import { createApp as buildApp } from "./app";

let database: Database;
let app: ReturnType<typeof createApp>;
const auth = { cookie: "", userId: "" };

let executedSpec: SandboxSpec | null = null;
const deletedWorkspaces: string[] = [];
const sandbox: SandboxProvider = {
  name: "fake",
  async resolveImage(imageRef) {
    return imageRef || "fake:default";
  },
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
  async finalizeSuspend() {},
  async deleteWorkspace(ref) {
    deletedWorkspaces.push(ref.id);
  },
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

function testImageRequest(target: ReturnType<typeof createApp>, imageRef: string) {
  return target.request("/environments/test", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ provider: "github", repo: "acme/widgets", imageRef }),
  });
}

describe("repository environments", () => {
  beforeEach(() => {
    executedSpec = null;
    deletedWorkspaces.length = 0;
  });

  it("saves and lists a per-repository image reference", async () => {
    const response = await app.request("/environments", {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({
        provider: "github",
        repo: "acme/widgets",
        imageRef: "ghcr.io/acme/widgets:dev",
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
      imageRef: "ghcr.io/acme/widgets:dev",
    });
  });

  it("clears the app setting", async () => {
    await saveRepositorySandboxImage(database, {
      userId: auth.userId,
      provider: "github",
      repoFullName: "acme/widgets",
      imageRef: "ghcr.io/acme/widgets:dev",
    });
    const response = await app.request("/environments", {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({ provider: "github", repo: "acme/widgets", imageRef: "  " }),
    });
    expect(response.status).toBe(200);
    await expect(
      getRepositorySandboxImage(database, auth.userId, "github", "acme/widgets"),
    ).resolves.toBeNull();
  });

  it("tests an unsaved image in a disposable sandbox", async () => {
    const response = await testImageRequest(app, "docker.io/acme/widgets:dev");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      output: "node v22.23.2\nPython 3.11.2",
    });
    expect(executedSpec?.image).toBe("docker.io/acme/widgets:dev");
    expect(executedSpec?.command).toContain("test -r /app/run.js");
    expect(executedSpec?.command).toContain("test -r /app/package.json");
    expect(executedSpec?.command).toContain("test -w /workspace");
    expect(executedSpec?.command).toContain("node --import tsx");
    expect(executedSpec?.command).toContain("command -v git");
  });

  it("rejects an empty image in the preflight endpoint", async () => {
    const response = await app.request("/environments/test", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ provider: "github", repo: "acme/widgets", imageRef: "  " }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "image reference cannot be empty" });
    expect(executedSpec).toBeNull();
  });

  it("does not expose provider-specific errors from image preflight", async () => {
    const failingSandbox: SandboxProvider = {
      ...sandbox,
      async execute() {
        throw new Error("e2b: template build failed for docker.io/acme/widgets:dev");
      },
    };
    const failingApp = buildApp({
      config: testConfig(),
      database,
      log: silentLogger(),
      broker: createCredentialBroker(testConfig(), database, silentLogger()),
      sandbox: failingSandbox,
    });

    const response = await testImageRequest(failingApp, "docker.io/acme/widgets:dev");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "could not test repository image" });
  });

  it("deletes a session and asks the provider to delete its checkpoint", async () => {
    const { session, run } = await seedSession(database, auth.userId);
    await completeRun(database, run.id, "succeeded");
    await parkSession(database, run, { provider: "fake", id: "checkpoint-1" }, null);

    const response = await app.request(`/sessions/${session.id}`, {
      method: "DELETE",
      headers: requestHeaders(),
    });
    expect(response.status).toBe(200);
    expect(deletedWorkspaces).toEqual(["checkpoint-1"]);
    expect(await getSession(database, session.id)).toBeNull();
  });
});
