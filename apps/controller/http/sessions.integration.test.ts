import { randomUUID } from "node:crypto";
import type {
  RunDetail,
  SessionDetail,
  SessionListResponse,
  SessionSummary,
} from "@pi-cloud-agent/protocol";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { completeRun, getRun } from "../db/runs";
import { runs } from "../db/schema";
import { getSession, parkSession } from "../db/sessions";
import { fakeProvider } from "../reconcile/fake-sandbox-provider";
import {
  bindTestApp,
  seedTestUser,
  silentLogger,
  testConfig,
  withTestModel,
} from "../test-support";
import { createApp } from "./app";

let database: Database;
let app: ReturnType<typeof createApp>;
let testCookie: string;
let testModelConnectionId: string;

bindTestApp((deps) => {
  database = deps.database;
  app = deps.app;
});

beforeEach(async () => {
  const config = testConfig();
  const seeded = await seedTestUser(database, config);
  testCookie = seeded.cookie;
  testModelConnectionId = seeded.modelConnectionId;
});

function send(method: "POST" | "PUT", path: string, body: unknown, token?: string) {
  return app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: `pca_session=${testCookie}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(
      path === "/sessions" || path.endsWith("/turns")
        ? withTestModel(body, testModelConnectionId)
        : body,
    ),
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function deleteRequest(sessionId: string) {
  return app.request(`/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { Cookie: `pca_session=${testCookie}` },
  });
}

describe("durable session HTTP contract", () => {
  it("creates a session, checkpoints it, and queues a real follow-up turn", async () => {
    const created = await send("POST", "/sessions", {
      repo: "acme/widgets",
      prompt: "Create a note for the next turn",
    });
    expect(created.status).toBe(201);
    const session = await json<SessionSummary>(created);
    expect(session.status).toBe("queued");
    expect(session.activeRunId).toBe(session.latestRunId);

    const detail = await json<SessionDetail>(
      await app.request(`/sessions/${session.id}`, {
        headers: { Cookie: `pca_session=${testCookie}` },
      }),
    );
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]?.sessionId).toBe(session.id);
    expect(detail.runs[0]?.turnNumber).toBe(1);

    const listing = await json<SessionListResponse>(
      await app.request("/sessions", {
        headers: { Cookie: `pca_session=${testCookie}` },
      }),
    );
    expect(listing.sessions.map((item) => item.id)).toContain(session.id);
    const queued = await send("POST", `/sessions/${session.id}/turns`, {
      prompt: "Wait until the first turn finishes",
    });
    expect(queued.status).toBe(201);
    expect((await json<RunDetail>(queued)).status).toBe("queued");

    const firstRun = await getRun(database, session.activeRunId ?? "");
    expect(firstRun).not.toBeNull();
    const token = firstRun?.callbackToken;
    const checkpoint = '{"type":"session","id":"pi-session-one"}\n';
    expect(
      (
        await send(
          "PUT",
          `/internal/runs/${firstRun?.id}/checkpoint`,
          { content: checkpoint },
          token,
        )
      ).status,
    ).toBe(200);
    expect(
      await json<{ content: string | null }>(
        await app.request(`/internal/runs/${firstRun?.id}/checkpoint`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ),
    ).toEqual({ content: checkpoint });

    expect(
      (await send("POST", `/internal/runs/${firstRun?.id}/status`, { status: "done" }, token))
        .status,
    ).toBe(200);
    expect(await parkSession(database, firstRun!, null, null)).toBe(true);

    const promoted = await getSession(database, session.id);
    expect(promoted?.activeRunId).not.toBe(firstRun?.id);
    const promotedRun = await getRun(database, promoted?.activeRunId ?? "");
    await completeRun(database, promotedRun?.id ?? "", "succeeded");
    expect(await parkSession(database, promotedRun!, null, null)).toBe(true);

    expect(
      (
        await app.request(`/sessions/${session.id}/turns`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `pca_session=${testCookie}`,
          },
          body: JSON.stringify({ prompt: "No implicit model" }),
        })
      ).status,
    ).toBe(422);

    const response = await send("POST", `/sessions/${session.id}/turns`, {
      prompt: "Read the note from the previous turn",
    });
    expect(response.status).toBe(201);
    const followUp = await json<RunDetail>(response);
    expect(followUp.sessionId).toBe(session.id);
    expect(followUp.turnNumber).toBe(3);
    expect(followUp.prompt).toBe("Read the note from the previous turn");
  });

  it("requires a Pi checkpoint before accepting successful session completion", async () => {
    const session = await json<SessionSummary>(
      await send("POST", "/sessions", {
        repo: "acme/widgets",
        prompt: "Finish without a checkpoint",
      }),
    );
    const run = await getRun(database, session.latestRunId);
    const response = await send(
      "POST",
      `/internal/runs/${run?.id}/status`,
      { status: "done" },
      run?.callbackToken,
    );

    expect(response.status).toBe(200);
    expect((await getRun(database, session.latestRunId))?.status).toBe("failed");
    expect((await getRun(database, session.latestRunId))?.error).toContain("checkpoint");
  });

  it("pins and unpins a session", async () => {
    const session = await json<SessionSummary>(
      await send("POST", "/sessions", {
        repo: "acme/widgets",
        prompt: "Pin me",
      }),
    );

    const pin = await app.request(`/sessions/${session.id}/pin`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `pca_session=${testCookie}`,
      },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pin.status).toBe(200);
    expect(await json<{ ok: boolean; pinned: boolean }>(pin)).toEqual({
      ok: true,
      pinned: true,
    });

    const listed = await json<SessionListResponse>(
      await app.request("/sessions", {
        headers: { Cookie: `pca_session=${testCookie}` },
      }),
    );
    expect(listed.sessions.find((item) => item.id === session.id)?.pinned).toBe(true);

    const unpin = await app.request(`/sessions/${session.id}/pin`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `pca_session=${testCookie}`,
      },
      body: JSON.stringify({ pinned: false }),
    });
    expect(unpin.status).toBe(200);
    expect((await json<{ pinned: boolean }>(unpin)).pinned).toBe(false);
  });

  it("deletes an idle session and removes its chat history", async () => {
    const session = await json<SessionSummary>(
      await send("POST", "/sessions", {
        repo: "acme/widgets",
        prompt: "Delete me",
      }),
    );
    const run = await getRun(database, session.latestRunId);
    if (!run) throw new Error("session run missing");
    await completeRun(database, run.id, "succeeded");
    await parkSession(database, run, null, null);

    const response = await deleteRequest(session.id);
    expect(response.status).toBe(200);
    expect(await getSession(database, session.id)).toBeNull();
    expect(
      (
        await app.request(`/sessions/${session.id}`, {
          headers: { Cookie: `pca_session=${testCookie}` },
        })
      ).status,
    ).toBe(404);
  });

  it("drains every pending checkpoint cleanup before deleting session history", async () => {
    const session = await json<SessionSummary>(
      await send("POST", "/sessions", {
        repo: "acme/widgets",
        prompt: "Delete all checkpoints",
      }),
    );
    const firstRun = await getRun(database, session.latestRunId);
    if (!firstRun) throw new Error("session run missing");
    const pending = Array.from({ length: 26 }, (_, index) => ({
      sourceId: `source-${index + 1}`,
      checkpointId: `checkpoint-${index + 1}`,
    }));
    const firstPending = pending[0];
    if (!firstPending) throw new Error("pending checkpoint missing");
    await database
      .update(runs)
      .set({
        status: "succeeded",
        sandboxProvider: "fake",
        sandboxId: firstPending.sourceId,
        sandboxStoppedAt: new Date(),
        sandboxFinalizationWorkspaceProvider: "fake",
        sandboxFinalizationWorkspaceId: firstPending.checkpointId,
      })
      .where(eq(runs.id, firstRun.id));
    await database.insert(runs).values(
      pending.slice(1).map(({ sourceId, checkpointId }, index) => ({
        id: randomUUID(),
        userId: firstRun.userId,
        sessionId: session.id,
        turnNumber: index + 2,
        status: "succeeded" as const,
        provider: "github",
        repoFullName: "acme/widgets",
        trigger: { ...firstRun.trigger, prompt: "pending" },
        model: firstRun.model,
        modelConnectionId: firstRun.modelConnectionId,
        callbackToken: randomUUID(),
        sandboxProvider: "fake",
        sandboxId: sourceId,
        sandboxStoppedAt: new Date(),
        sandboxFinalizationWorkspaceProvider: "fake",
        sandboxFinalizationWorkspaceId: checkpointId,
      })),
    );
    const provider = fakeProvider();
    const finalized: string[] = [];
    provider.finalizeSuspend = async (source) => {
      finalized.push(source.id);
    };
    const cleanupApp = createApp({
      config: testConfig(),
      database,
      log: silentLogger(),
      sandbox: provider,
      createSandboxProvider: () => provider,
    });

    const response = await cleanupApp.request(`/sessions/${session.id}`, {
      method: "DELETE",
      headers: { Cookie: `pca_session=${testCookie}` },
    });

    expect(response.status).toBe(200);
    expect(finalized).toHaveLength(26);
    expect(await getSession(database, session.id)).toBeNull();
  });

  it("refuses to delete while a turn is still running", async () => {
    const session = await json<SessionSummary>(
      await send("POST", "/sessions", {
        repo: "acme/widgets",
        prompt: "Keep running",
      }),
    );
    const response = await deleteRequest(session.id);
    expect(response.status).toBe(409);
    expect(await getSession(database, session.id)).not.toBeNull();
  });

  it("refuses to delete when a follow-up is already queued", async () => {
    const session = await json<SessionSummary>(
      await send("POST", "/sessions", {
        repo: "acme/widgets",
        prompt: "Race delete",
      }),
    );
    const run = await getRun(database, session.latestRunId);
    if (!run) throw new Error("session run missing");
    await completeRun(database, run.id, "succeeded");
    await parkSession(database, run, { provider: "fake", id: "checkpoint-race" }, null);

    const followUp = await send("POST", `/sessions/${session.id}/turns`, {
      prompt: "Keep this turn",
    });
    expect(followUp.status).toBe(201);
    const deletion = await deleteRequest(session.id);
    expect(deletion.status).toBe(409);
    expect(await getSession(database, session.id)).not.toBeNull();
  });

  it("refuses to delete a terminal turn while parking is pending and a follow-up is queued", async () => {
    const session = await json<SessionSummary>(
      await send("POST", "/sessions", {
        repo: "acme/widgets",
        prompt: "Race terminal parking",
      }),
    );
    const run = await getRun(database, session.latestRunId);
    if (!run) throw new Error("session run missing");
    await completeRun(database, run.id, "succeeded");
    const followUp = await send("POST", `/sessions/${session.id}/turns`, {
      prompt: "Queue before parking",
    });
    expect(followUp.status).toBe(201);

    const deletion = await deleteRequest(session.id);
    expect(deletion.status).toBe(409);
    const stored = await getSession(database, session.id);
    expect(stored?.latestRunId).not.toBe(run.id);
  });

  it("serializes delete cleanup against a concurrent follow-up", async () => {
    const session = await json<SessionSummary>(
      await send("POST", "/sessions", {
        repo: "acme/widgets",
        prompt: "Delete race",
      }),
    );
    const run = await getRun(database, session.latestRunId);
    if (!run) throw new Error("session run missing");
    await completeRun(database, run.id, "succeeded");
    await parkSession(database, run, { provider: "fake", id: "checkpoint-delete" }, null);

    const provider = fakeProvider();
    let cleanupStarted = () => {};
    const cleanupEntered = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let releaseCleanup = () => {};
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    provider.deleteWorkspace = async () => {
      cleanupStarted();
      await cleanupReleased;
    };
    const raceApp = createApp({
      config: testConfig(),
      database,
      log: silentLogger(),
      sandbox: provider,
      createSandboxProvider: () => provider,
    });
    const deletion = raceApp.request(`/sessions/${session.id}`, {
      method: "DELETE",
      headers: { Cookie: `pca_session=${testCookie}` },
    });
    await cleanupEntered;

    const followUp = raceApp.request(`/sessions/${session.id}/turns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `pca_session=${testCookie}`,
      },
      body: JSON.stringify(
        withTestModel({ prompt: "Must not start during delete" }, testModelConnectionId),
      ),
    });
    expect((await followUp).status).toBe(409);

    releaseCleanup();
    expect((await deletion).status).toBe(200);
    expect(await getSession(database, session.id)).toBeNull();
  });
});
