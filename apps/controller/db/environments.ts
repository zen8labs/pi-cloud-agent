import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client";
import { type RepositoryEnvironmentRow, repositoryEnvironments } from "./schema";

export async function listRepositoryEnvironments(
  database: Database,
  userId: string,
): Promise<RepositoryEnvironmentRow[]> {
  return database
    .select()
    .from(repositoryEnvironments)
    .where(eq(repositoryEnvironments.userId, userId))
    .orderBy(asc(repositoryEnvironments.repoFullName));
}

export async function getRepositoryEnvironment(
  database: Database,
  userId: string | null,
  provider: string,
  repoFullName: string,
): Promise<RepositoryEnvironmentRow | null> {
  if (!userId) return null;
  const [row] = await database
    .select()
    .from(repositoryEnvironments)
    .where(
      and(
        eq(repositoryEnvironments.userId, userId),
        eq(repositoryEnvironments.provider, provider),
        eq(repositoryEnvironments.repoFullName, repoFullName),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function saveRepositoryEnvironment(
  database: Database,
  input: { userId: string; provider: string; repoFullName: string; setupScript: string },
): Promise<RepositoryEnvironmentRow> {
  const [row] = await database
    .insert(repositoryEnvironments)
    .values(input)
    .onConflictDoUpdate({
      target: [
        repositoryEnvironments.userId,
        repositoryEnvironments.provider,
        repositoryEnvironments.repoFullName,
      ],
      set: { setupScript: input.setupScript, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("could not save repository environment");
  return row;
}

export async function deleteRepositoryEnvironment(
  database: Database,
  input: { userId: string; provider: string; repoFullName: string },
): Promise<void> {
  await database
    .delete(repositoryEnvironments)
    .where(
      and(
        eq(repositoryEnvironments.userId, input.userId),
        eq(repositoryEnvironments.provider, input.provider),
        eq(repositoryEnvironments.repoFullName, input.repoFullName),
      ),
    );
}
