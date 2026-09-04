import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  externalThreads,
  type GithubCommentPublicationRow,
  type GithubInstallationRow,
  type GithubReviewPublicationRow,
  githubCommentPublications,
  githubInstallations,
  githubReviewPublications,
  type IntegrationDeliveryRow,
  integrationDeliveries,
} from "./schema";

const DELIVERY_LEASE_MS = 5 * 60 * 1000;
const DELIVERY_RETRY_DELAY_MS = 10 * 1000;
const MAX_DELIVERY_ATTEMPTS = 5;
const PUBLICATION_LEASE_MS = 5 * 60 * 1000;

export async function recordIntegrationDelivery(
  database: Database,
  input: {
    provider: string;
    deliveryId: string;
    eventType: string;
    action: string | null;
    payload: unknown;
  },
): Promise<boolean> {
  const inserted = await database
    .insert(integrationDeliveries)
    .values(input)
    .onConflictDoNothing()
    .returning({ deliveryId: integrationDeliveries.deliveryId });
  return inserted.length > 0;
}

export async function claimIntegrationDelivery(
  database: Database,
  provider: string,
): Promise<IntegrationDeliveryRow | null> {
  return database.transaction(async (tx) => {
    const staleAt = new Date(Date.now() - DELIVERY_LEASE_MS);
    const retryAt = new Date(Date.now() - DELIVERY_RETRY_DELAY_MS);
    const [candidate] = await tx
      .select()
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.provider, provider),
          or(
            eq(integrationDeliveries.status, "pending"),
            and(
              eq(integrationDeliveries.status, "processing"),
              lt(integrationDeliveries.claimedAt, staleAt),
            ),
            and(
              eq(integrationDeliveries.status, "failed"),
              lt(integrationDeliveries.attempt, MAX_DELIVERY_ATTEMPTS),
              lt(integrationDeliveries.updatedAt, retryAt),
            ),
          ),
        ),
      )
      .orderBy(asc(integrationDeliveries.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await tx
      .update(integrationDeliveries)
      .set({
        status: "processing",
        attempt: sql`${integrationDeliveries.attempt} + 1`,
        claimedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationDeliveries.provider, provider),
          eq(integrationDeliveries.deliveryId, candidate.deliveryId),
          or(
            eq(integrationDeliveries.status, "pending"),
            eq(integrationDeliveries.status, "processing"),
          ),
        ),
      )
      .returning();
    return claimed ?? null;
  });
}

export async function finishIntegrationDelivery(
  database: Database,
  delivery: IntegrationDeliveryRow,
  result: { status: "processed" | "ignored" | "failed"; runId?: string | null; error?: string },
): Promise<boolean> {
  const updated = await database
    .update(integrationDeliveries)
    .set({
      status: result.status,
      runId: result.runId ?? null,
      lastError: result.error ?? null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationDeliveries.provider, delivery.provider),
        eq(integrationDeliveries.deliveryId, delivery.deliveryId),
        eq(integrationDeliveries.status, "processing"),
        delivery.claimedAt
          ? eq(integrationDeliveries.claimedAt, delivery.claimedAt)
          : isNull(integrationDeliveries.claimedAt),
      ),
    )
    .returning({ deliveryId: integrationDeliveries.deliveryId });
  return updated.length > 0;
}

export async function upsertGithubInstallation(
  database: Database,
  input: {
    installationId: string;
    userId: string;
    accountId: string;
    accountLogin: string;
  },
): Promise<GithubInstallationRow> {
  const [row] = await database
    .insert(githubInstallations)
    .values(input)
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: {
        userId: input.userId,
        accountId: input.accountId,
        accountLogin: input.accountLogin,
        active: true,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("could not save GitHub installation");
  return row;
}

export async function getGithubInstallation(
  database: Database,
  installationId: string,
): Promise<GithubInstallationRow | null> {
  const [row] = await database
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, installationId),
        eq(githubInstallations.active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getExternalThread(
  database: Database,
  provider: string,
  externalKey: string,
): Promise<{ sessionId: string; userId: string } | null> {
  const [row] = await database
    .select({ sessionId: externalThreads.sessionId, userId: externalThreads.userId })
    .from(externalThreads)
    .where(
      and(eq(externalThreads.provider, provider), eq(externalThreads.externalKey, externalKey)),
    )
    .limit(1);
  return row ?? null;
}

export async function beginGithubReviewPublication(
  database: Database,
  runId: string,
  submission: unknown,
): Promise<{ publication: GithubReviewPublicationRow; claimed: boolean } | null> {
  return beginGithubPublication(
    database,
    githubReviewPublications,
    runId,
    submission,
  ) as Promise<{
    publication: GithubReviewPublicationRow;
    claimed: boolean;
  } | null>;
}

export async function finishGithubReviewPublication(
  database: Database,
  runId: string,
  result: { status: "published" | "failed"; githubReviewId?: string; error?: string },
): Promise<boolean> {
  const updated = await database
    .update(githubReviewPublications)
    .set({
      status: result.status,
      githubReviewId: result.githubReviewId ?? null,
      lastError: result.error ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(githubReviewPublications.runId, runId),
        eq(githubReviewPublications.status, "processing"),
      ),
    )
    .returning({ runId: githubReviewPublications.runId });
  return updated.length > 0;
}

export async function hasPublishedGithubReview(
  database: Database,
  runId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ runId: githubReviewPublications.runId })
    .from(githubReviewPublications)
    .where(
      and(
        eq(githubReviewPublications.runId, runId),
        eq(githubReviewPublications.status, "published"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function beginGithubCommentPublication(
  database: Database,
  runId: string,
  submission: unknown,
): Promise<{ publication: GithubCommentPublicationRow; claimed: boolean } | null> {
  return beginGithubPublication(
    database,
    githubCommentPublications,
    runId,
    submission,
  ) as Promise<{
    publication: GithubCommentPublicationRow;
    claimed: boolean;
  } | null>;
}

type GithubPublicationRow = GithubReviewPublicationRow | GithubCommentPublicationRow;
type GithubPublicationTable =
  | typeof githubReviewPublications
  | typeof githubCommentPublications;

async function beginGithubPublication(
  database: Database,
  table: GithubPublicationTable,
  runId: string,
  submission: unknown,
): Promise<{ publication: GithubPublicationRow; claimed: boolean } | null> {
  return database.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(table)
      .values({ runId, submission, status: "processing" })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { publication: inserted, claimed: true };
    const [existing] = await tx
      .select()
      .from(table)
      .where(eq(table.runId, runId))
      .limit(1)
      .for("update");
    if (!existing) return null;
    if (existing.status === "published") return { publication: existing, claimed: false };
    const leaseExpired = existing.updatedAt.getTime() <= Date.now() - PUBLICATION_LEASE_MS;
    if (existing.status === "processing" && !leaseExpired) {
      return { publication: existing, claimed: false };
    }
    const [reopened] = await tx
      .update(table)
      .set({ status: "processing", submission, lastError: null, updatedAt: new Date() })
      .where(
        and(
          eq(table.runId, runId),
          eq(table.status, existing.status),
          eq(table.updatedAt, existing.updatedAt),
        ),
      )
      .returning();
    return reopened
      ? { publication: reopened, claimed: true }
      : { publication: existing, claimed: false };
  });
}

export async function finishGithubCommentPublication(
  database: Database,
  runId: string,
  result: { status: "published" | "failed"; githubCommentId?: string; error?: string },
): Promise<boolean> {
  const updated = await database
    .update(githubCommentPublications)
    .set({
      status: result.status,
      githubCommentId: result.githubCommentId ?? null,
      lastError: result.error ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(githubCommentPublications.runId, runId),
        eq(githubCommentPublications.status, "processing"),
      ),
    )
    .returning({ runId: githubCommentPublications.runId });
  return updated.length > 0;
}

export async function hasPublishedGithubComment(
  database: Database,
  runId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ runId: githubCommentPublications.runId })
    .from(githubCommentPublications)
    .where(
      and(
        eq(githubCommentPublications.runId, runId),
        eq(githubCommentPublications.status, "published"),
      ),
    )
    .limit(1);
  return Boolean(row);
}
