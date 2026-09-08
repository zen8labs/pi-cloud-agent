import { createHmac } from "node:crypto";
import type {
  PullRequestReviewsResponse,
  ReviewRepositoriesResponse,
  SessionListResponse,
} from "@pi-cloud-agent/protocol";
import type { GithubReviewReader } from "@pi-cloud-agent/vcs";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { upsertAppUser } from "../db/auth";
import type { Database } from "../db/client";
import {
  beginGithubReviewPublication,
  finishGithubReviewPublication,
  upsertGithubInstallation,
} from "../db/integrations";
import { isAutoReviewEnabled } from "../db/reviews";
import { githubInstallations, integrationDeliveries, runs } from "../db/schema";
import { upsertVcsConnection } from "../db/vcs-connections";
import { processPendingGithubDeliveries } from "../integrations/github";
import { encryptSecret } from "../secrets/crypto";
import {
  bindTestDatabase,
  seedSession,
  seedTestUser,
  silentLogger,
  testConfig,
} from "../test-support";
import { createApp } from "./app";

const config = testConfig({
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "test-key-not-used-for-publication",
});
let database: Database;
let app: ReturnType<typeof createApp>;
let cookie: string;
let userId: string;
let access = true;
let canPublish = true;
let forgeFailure = false;
let headSha = "head-one";
const reader: GithubReviewReader = {
  async installations() {
    return access
      ? [
          {
            id: 42,
            app_id: 123,
            account: { id: 10, login: "acme" },
            permissions: { contents: "read", pull_requests: canPublish ? "write" : "read" },
          },
        ]
      : [];
  },
  async repositories() {
    return [{ full_name: "acme/widgets" }];
  },
  async openPulls() {
    if (forgeFailure) throw new Error("upstream unavailable, token=must-not-leak");
    return [
      {
        number: 7,
        title: "Fix login",
        draft: false,
        updated_at: new Date().toISOString(),
        head: { sha: headSha },
      },
    ];
  },
};

bindTestDatabase((value) => {
  database = value;
});
beforeEach(async () => {
  access = true;
  canPublish = true;
  forgeFailure = false;
  headSha = "head-one";
  ({ cookie, userId } = await seedTestUser(database, config));
  await upsertVcsConnection(database, {
    userId,
    provider: "github",
    accountId: "1",
    accountName: "alice",
    accessToken: encryptSecret("test-token", config.vcs.encryptionKey),
    refreshToken: null,
    expiresAt: null,
  });
  await upsertGithubInstallation(database, {
    installationId: "42",
    userId,
    accountId: "10",
    accountLogin: "acme",
  });
  app = createApp({
    database,
    config,
    log: silentLogger(),
    createGithubReviewReader: () => reader,
  });
});

function request(path: string, body?: unknown) {
  return app.request(path, {
    method: body ? "PUT" : "GET",
    headers: { Cookie: `pca_session=${cookie}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function toggle(autoReview: boolean, installationId = "42") {
  return request("/reviews/repositories", { installationId, repo: "acme/widgets", autoReview });
}
async function inbox() {
  const response = await request("/reviews");
  expect(response.status).toBe(200);
  return response.json() as Promise<PullRequestReviewsResponse>;
}
async function deliver(id: string, draft = false) {
  const payload = {
    action: "opened",
    number: 7,
    installation: { id: 42 },
    sender: { type: "User" },
    repository: { full_name: "acme/widgets" },
    pull_request: {
      title: "Fix login",
      draft,
      base: {
        ref: "main",
        sha: "base-one",
        repo: { full_name: "acme/widgets", clone_url: "https://github.com/acme/widgets.git" },
      },
      head: {
        ref: "fix-login",
        sha: headSha,
        repo: { full_name: "acme/widgets", clone_url: "https://github.com/acme/widgets.git" },
      },
    },
  };
  const body = JSON.stringify(payload);
  const response = await app.request("/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "x-github-delivery": id,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", config.github.webhookSecret).update(body).digest("hex")}`,
    },
  });
  expect(response.status).toBe(202);
  await processPendingGithubDeliveries(database, config, silentLogger());
}

it("shows GitHub PRs even when no webhook or review session exists", async () => {
  expect((await inbox()).pullRequests[0]).toMatchObject({
    number: 7,
    status: "skipped",
    sessionId: null,
  });
  expect((await toggle(true)).status).toBe(200);
  expect((await inbox()).pullRequests[0]).toMatchObject({
    status: "not_reviewed",
    detail: "No webhook received for this commit.",
  });
});

it("checks repository permissions again before enabling, but permits disabling", async () => {
  expect((await toggle(true)).status).toBe(200);
  canPublish = false;
  expect((await toggle(true)).status).toBe(422);
  expect((await toggle(false)).status).toBe(200);
  expect(await isAutoReviewEnabled(database, "42", "acme/widgets")).toBe(false);
});

it("never exposes or changes another installation through a guessed id", async () => {
  expect((await toggle(true, "99")).status).toBe(404);
  expect(
    (
      await request("/reviews/repositories", {
        installationId: "42",
        repo: "private/other",
        autoReview: true,
      })
    ).status,
  ).toBe(404);
  expect((await app.request("/reviews")).status).toBe(401);
});

it("shows revoked access and upstream failures instead of a successful empty inbox", async () => {
  access = false;
  expect((await inbox()).problems.join(" ")).toContain("missing or suspended");
  expect((await toggle(true)).status).toBe(404);
  access = true;
  forgeFailure = true;
  const result = await inbox();
  expect(result.problems.join(" ")).toContain("could not refresh");
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
});

it("persists disabled and draft decisions without launching a review", async () => {
  await deliver("disabled");
  let [delivery] = await database.select().from(integrationDeliveries);
  expect(delivery).toMatchObject({
    status: "ignored",
    lastError: "Auto-review is off for this repository.",
  });
  expect(await database.select().from(runs)).toHaveLength(0);
  await toggle(true);
  await deliver("draft", true);
  [delivery] = await database
    .select()
    .from(integrationDeliveries)
    .where(eq(integrationDeliveries.deliveryId, "draft"));
  expect(delivery?.lastError).toContain("Draft PR");
  expect(await database.select().from(runs)).toHaveLength(0);
});

it("connects an enabled webhook to its ordinary session, publication and current commit", async () => {
  await toggle(true);
  await deliver("review-event");
  await deliver("review-event");
  const [run] = await database.select().from(runs);
  if (!run) throw new Error("expected queued review");
  expect(await database.select().from(runs)).toHaveLength(1);
  expect((await inbox()).pullRequests[0]).toMatchObject({
    status: "queued",
    sessionId: run.sessionId,
  });
  // The default fixture model has no reasoning mode. Integrations must still queue it.
  expect(run.thinkingLevel).toBe("off");
  await beginGithubReviewPublication(database, run.id, { body: "No findings", comments: [] });
  await finishGithubReviewPublication(database, run.id, {
    status: "failed",
    error: "private token must not leak",
  });
  expect((await inbox()).pullRequests[0]).toMatchObject({
    status: "failed",
    detail: expect.stringContaining("publishing"),
  });
  await beginGithubReviewPublication(database, run.id, { body: "No findings", comments: [] });
  await finishGithubReviewPublication(database, run.id, {
    status: "published",
    githubReviewId: "1234",
  });
  expect((await inbox()).pullRequests[0]).toMatchObject({
    status: "reviewed",
    reviewUrl: "https://github.com/acme/widgets/pull/7#pullrequestreview-1234",
  });
  headSha = "head-two";
  expect((await inbox()).pullRequests[0]?.status).toBe("outdated");
});

it("filters history before limiting and keeps review sessions separate from manual tasks", async () => {
  await toggle(true);
  await deliver("review-event");
  const manual = await seedSession(database, userId);
  const reviews = (await (
    await request("/sessions?mode=reviews&limit=1")
  ).json()) as SessionListResponse;
  const tasks = (await (
    await request("/sessions?mode=tasks&limit=1")
  ).json()) as SessionListResponse;
  expect(reviews.sessions).toHaveLength(1);
  expect(reviews.sessions[0]?.hasReviews).toBe(true);
  expect(tasks.sessions[0]?.id).toBe(manual.session.id);
  expect(tasks.sessions[0]?.hasReviews).toBe(false);
});

it("returns repository-specific access problems without a synthetic readiness state", async () => {
  canPublish = false;
  const result = (await (
    await request("/reviews/repositories")
  ).json()) as ReviewRepositoriesResponse;
  expect(result.repositories[0]).toMatchObject({
    repo: "acme/widgets",
    problem: expect.stringContaining("Pull requests write"),
  });
});

it("discovers installations with missed setup callbacks and binds only when enabled", async () => {
  await database
    .delete(githubInstallations)
    .where(eq(githubInstallations.installationId, "42"));
  expect((await inbox()).pullRequests[0]?.number).toBe(7);
  expect(await database.select().from(githubInstallations)).toHaveLength(0);
  expect((await toggle(true)).status).toBe(200);
  expect((await database.select().from(githubInstallations))[0]?.userId).toBe(userId);
  await deliver("newly-discovered");
  expect((await inbox()).pullRequests[0]?.status).toBe("queued");
});

it("does not claim an installation already owned by another user", async () => {
  const other = await upsertAppUser(database, {
    githubUserId: "other",
    login: "other",
    displayName: "Other",
  });
  await database
    .update(githubInstallations)
    .set({ userId: other.id })
    .where(eq(githubInstallations.installationId, "42"));
  expect((await inbox()).pullRequests).toHaveLength(0);
  expect((await toggle(true)).status).toBe(404);
});
