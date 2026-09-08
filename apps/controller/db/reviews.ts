import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  githubInstallations,
  githubReviewPublications,
  githubReviewRepositories,
  integrationDeliveries,
  runs,
} from "./schema";

export async function listReviewInstallations(database: Database, userId: string) {
  return database
    .select()
    .from(githubInstallations)
    .where(and(eq(githubInstallations.userId, userId), eq(githubInstallations.active, true)));
}

/** Claim an installation only when unowned; discovery must never transfer ownership. */
export async function claimReviewInstallation(
  database: Database,
  input: { installationId: string; userId: string; accountId: string; accountLogin: string },
) {
  await database.insert(githubInstallations).values(input).onConflictDoNothing();
  return reviewInstallationOwner(database, input.installationId);
}

export async function reviewInstallationOwner(database: Database, installationId: string) {
  const [row] = await database
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);
  return row ?? null;
}

export async function listReviewPolicies(database: Database, userId: string) {
  return database
    .select({
      installationId: githubReviewRepositories.installationId,
      repo: githubReviewRepositories.repoFullName,
      autoReview: githubReviewRepositories.autoReview,
    })
    .from(githubReviewRepositories)
    .innerJoin(
      githubInstallations,
      eq(githubReviewRepositories.installationId, githubInstallations.installationId),
    )
    .where(eq(githubInstallations.userId, userId));
}

export async function saveReviewPolicy(
  database: Database,
  installationId: string,
  repo: string,
  autoReview: boolean,
) {
  await database
    .insert(githubReviewRepositories)
    .values({ installationId, repoFullName: repo, autoReview })
    .onConflictDoUpdate({
      target: [githubReviewRepositories.installationId, githubReviewRepositories.repoFullName],
      set: { autoReview, updatedAt: new Date() },
    });
}

export async function isAutoReviewEnabled(
  database: Database,
  installationId: string,
  repo: string,
) {
  const [row] = await database
    .select()
    .from(githubReviewRepositories)
    .where(
      and(
        eq(githubReviewRepositories.installationId, installationId),
        eq(githubReviewRepositories.repoFullName, repo),
      ),
    )
    .limit(1);
  return row?.autoReview ?? false;
}

/** Read existing evidence, scoped to the user; GitHub supplies the inventory. */
export async function reviewEvidence(
  database: Database,
  userId: string,
  repo: string,
  installationId: string,
) {
  const prNumber = sql<string>`${runs.trigger}->'repo'->>'prNumber'`;
  const headSha = sql<string>`${runs.trigger}->'repo'->>'headSha'`;
  const deliveryNumber = sql<string>`${integrationDeliveries.payload}->>'number'`;
  const deliveryHead = sql<string>`${integrationDeliveries.payload}->'pull_request'->'head'->>'sha'`;
  const [attempts, deliveries] = await Promise.all([
    database
      .selectDistinctOn([prNumber, headSha], {
        run: runs,
        publication: githubReviewPublications,
      })
      .from(runs)
      .leftJoin(githubReviewPublications, eq(githubReviewPublications.runId, runs.id))
      .where(
        and(
          eq(runs.userId, userId),
          eq(runs.repoFullName, repo),
          sql`${runs.trigger}->>'intent' = 'github_review'`,
        ),
      )
      .orderBy(prNumber, headSha, desc(runs.createdAt), desc(runs.id)),
    database
      .selectDistinctOn([deliveryNumber, deliveryHead], {
        number: deliveryNumber,
        deliveryId: integrationDeliveries.deliveryId,
        headSha: deliveryHead,
        status: integrationDeliveries.status,
        reason: integrationDeliveries.lastError,
        createdAt: integrationDeliveries.createdAt,
      })
      .from(integrationDeliveries)
      .innerJoin(
        githubInstallations,
        sql`${integrationDeliveries.payload}->'installation'->>'id' = ${githubInstallations.installationId}`,
      )
      .where(
        and(
          eq(githubInstallations.userId, userId),
          eq(githubInstallations.installationId, installationId),
          eq(integrationDeliveries.provider, "github"),
          eq(integrationDeliveries.eventType, "pull_request"),
          sql`${integrationDeliveries.payload}->'repository'->>'full_name' = ${repo}`,
        ),
      )
      .orderBy(deliveryNumber, deliveryHead, desc(integrationDeliveries.createdAt)),
  ]);
  return { attempts, deliveries };
}

export async function sessionHasReviews(
  database: Database,
  sessionId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(eq(runs.sessionId, sessionId), sql`${runs.trigger}->>'intent' = 'github_review'`),
    )
    .limit(1);
  return Boolean(row);
}

export async function sessionsWithReviews(
  database: Database,
  sessionIds: string[],
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows = await database
    .selectDistinct({ sessionId: runs.sessionId })
    .from(runs)
    .where(
      and(
        inArray(runs.sessionId, sessionIds),
        sql`${runs.trigger}->>'intent' = 'github_review'`,
      ),
    );
  return new Set(rows.flatMap((row) => (row.sessionId ? [row.sessionId] : [])));
}
