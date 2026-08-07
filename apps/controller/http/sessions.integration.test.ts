import type {
  RunDetail,
  SessionDetail,
  SessionListResponse,
  SessionSummary,
} from "@pi-cloud-agent/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { getRun } from "../db/runs";
import { parkSession } from "../db/sessions";
import { bindTestApp, seedTestUser, testConfig, withTestModel } from "../test-support";
import type { createApp } from "./app";

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
    expect(
      (await send("POST", `/sessions/${session.id}/turns`, { prompt: "too soon" })).status,
    ).toBe(409);

    const firstRun = await getRun(database, session.latestRunId);
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
    expect(followUp.turnNumber).toBe(2);
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
});
