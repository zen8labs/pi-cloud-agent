import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { bindTestDatabase, seedRun } from "../test-support";
import { upsertAppUser } from "./auth";
import {
  beginGithubReviewPublication,
  claimIntegrationDelivery,
  finishIntegrationDelivery,
  GithubInstallationOwnedError,
  recordIntegrationDelivery,
  upsertGithubInstallation,
} from "./integrations";
import { githubInstallations, githubReviewPublications, integrationDeliveries } from "./schema";

let database: Parameters<typeof claimIntegrationDelivery>[0];
bindTestDatabase((value) => {
  database = value;
});

it("deduplicates a GitHub delivery and claims it exactly once", async () => {
  const input = {
    provider: "github",
    deliveryId: "delivery-1",
    eventType: "ping",
    action: null,
    payload: { action: "ping" },
  };
  await expect(recordIntegrationDelivery(database, input)).resolves.toBe(true);
  await expect(recordIntegrationDelivery(database, input)).resolves.toBe(false);

  const claimed = await claimIntegrationDelivery(database, "github");
  expect(claimed?.deliveryId).toBe("delivery-1");
  expect(claimed?.status).toBe("processing");
  if (!claimed) throw new Error("delivery was not claimed");
  await expect(
    finishIntegrationDelivery(database, claimed, { status: "processed" }),
  ).resolves.toBe(true);
  await expect(claimIntegrationDelivery(database, "github")).resolves.toBeNull();
});

it("reclaims a failed delivery after the retry delay", async () => {
  const input = {
    provider: "github",
    deliveryId: "delivery-retry",
    eventType: "ping",
    action: null,
    payload: { action: "ping" },
  };
  await expect(recordIntegrationDelivery(database, input)).resolves.toBe(true);
  const claimed = await claimIntegrationDelivery(database, "github");
  expect(claimed?.deliveryId).toBe("delivery-retry");
  if (!claimed) throw new Error("delivery was not claimed");
  await expect(
    finishIntegrationDelivery(database, claimed, { status: "failed", error: "session busy" }),
  ).resolves.toBe(true);

  await database
    .update(integrationDeliveries)
    .set({ updatedAt: new Date(Date.now() - 11_000) })
    .where(eq(integrationDeliveries.deliveryId, input.deliveryId));
  const retried = await claimIntegrationDelivery(database, "github");
  expect(retried?.deliveryId).toBe("delivery-retry");
  expect(retried?.status).toBe("processing");
  expect(retried?.attempt).toBe(2);
});

it("never transfers a GitHub installation to a different app user", async () => {
  const first = await upsertAppUser(database, {
    githubUserId: "first",
    login: "first",
    displayName: "First",
  });
  const second = await upsertAppUser(database, {
    githubUserId: "second",
    login: "second",
    displayName: "Second",
  });
  await upsertGithubInstallation(database, {
    installationId: "42",
    userId: first.id,
    accountId: "10",
    accountLogin: "acme",
  });
  await expect(
    upsertGithubInstallation(database, {
      installationId: "42",
      userId: second.id,
      accountId: "10",
      accountLogin: "acme",
    }),
  ).rejects.toBeInstanceOf(GithubInstallationOwnedError);
  expect(
    (
      await database
        .select({ userId: githubInstallations.userId })
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, "42"))
    )[0]?.userId,
  ).toBe(first.id);
});

it("marks an abandoned external publication uncertain without reclaiming it", async () => {
  const run = await seedRun(database);
  const first = await beginGithubReviewPublication(database, run.id, {
    body: "Review",
    comments: [],
  });
  expect(first?.claimed).toBe(true);
  await database
    .update(githubReviewPublications)
    .set({ updatedAt: new Date(Date.now() - 6 * 60 * 1000) })
    .where(eq(githubReviewPublications.runId, run.id));
  const retry = await beginGithubReviewPublication(database, run.id, {
    body: "Review",
    comments: [],
  });
  expect(retry).toMatchObject({ claimed: false, publication: { status: "uncertain" } });
});
