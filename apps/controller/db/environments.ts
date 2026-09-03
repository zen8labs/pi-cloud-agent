import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client";
import { type RepositorySandboxImageRow, repositorySandboxImages } from "./schema";

export async function listRepositorySandboxImages(
  database: Database,
  userId: string,
): Promise<RepositorySandboxImageRow[]> {
  return database
    .select()
    .from(repositorySandboxImages)
    .where(eq(repositorySandboxImages.userId, userId))
    .orderBy(asc(repositorySandboxImages.repoFullName));
}

export async function getRepositorySandboxImage(
  database: Database,
  userId: string | null,
  provider: string,
  repoFullName: string,
): Promise<RepositorySandboxImageRow | null> {
  if (!userId) return null;
  const [row] = await database
    .select()
    .from(repositorySandboxImages)
    .where(
      and(
        eq(repositorySandboxImages.userId, userId),
        eq(repositorySandboxImages.provider, provider),
        eq(repositorySandboxImages.repoFullName, repoFullName),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function saveRepositorySandboxImage(
  database: Database,
  input: { userId: string; provider: string; repoFullName: string; imageRef: string },
): Promise<RepositorySandboxImageRow> {
  const [row] = await database
    .insert(repositorySandboxImages)
    .values(input)
    .onConflictDoUpdate({
      target: [
        repositorySandboxImages.userId,
        repositorySandboxImages.provider,
        repositorySandboxImages.repoFullName,
      ],
      set: { imageRef: input.imageRef, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("could not save repository environment");
  return row;
}

export async function deleteRepositorySandboxImage(
  database: Database,
  input: { userId: string; provider: string; repoFullName: string },
): Promise<void> {
  await database
    .delete(repositorySandboxImages)
    .where(
      and(
        eq(repositorySandboxImages.userId, input.userId),
        eq(repositorySandboxImages.provider, input.provider),
        eq(repositorySandboxImages.repoFullName, input.repoFullName),
      ),
    );
}
