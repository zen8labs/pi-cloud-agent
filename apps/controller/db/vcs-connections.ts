import { and, eq, gt } from "drizzle-orm";
import type { Database } from "./client";
import {
  type OAuthStateRow,
  oauthStates,
  type VcsConnectionRow,
  vcsConnections,
} from "./schema";

export async function createOAuthState(
  database: Database,
  input: {
    state: string;
    provider: string;
    userId?: string | null;
    returnTo?: string | null;
    codeVerifier: string;
    expiresAt: Date;
  },
): Promise<void> {
  await database
    .insert(oauthStates)
    .values({ ...input, userId: input.userId ?? null, returnTo: input.returnTo ?? null });
}

export async function consumeOAuthState(
  database: Database,
  state: string,
): Promise<OAuthStateRow | null> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(oauthStates)
      .where(and(eq(oauthStates.state, state), gt(oauthStates.expiresAt, new Date())))
      .for("update")
      .limit(1);
    if (!row) return null;
    await tx.delete(oauthStates).where(eq(oauthStates.state, state));
    return row;
  });
}

export async function getVcsConnection(
  database: Database,
  userId: string,
  provider: string,
): Promise<VcsConnectionRow | null> {
  const [row] = await database
    .select()
    .from(vcsConnections)
    .where(and(eq(vcsConnections.userId, userId), eq(vcsConnections.provider, provider)))
    .limit(1);
  return row ?? null;
}

export async function listVcsConnections(
  database: Database,
  userId: string,
): Promise<VcsConnectionRow[]> {
  return database.select().from(vcsConnections).where(eq(vcsConnections.userId, userId));
}

export async function upsertVcsConnection(
  database: Database,
  input: {
    userId: string;
    provider: string;
    accountId: string;
    accountName: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
  },
): Promise<void> {
  await database
    .insert(vcsConnections)
    .values(input)
    .onConflictDoUpdate({
      target: [vcsConnections.userId, vcsConnections.provider],
      set: {
        accountId: input.accountId,
        accountName: input.accountName,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
        updatedAt: new Date(),
      },
    });
}

export async function updateVcsConnectionToken(
  database: Database,
  id: string,
  input: { accessToken: string; refreshToken: string | null; expiresAt: Date | null },
): Promise<void> {
  await database
    .update(vcsConnections)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(vcsConnections.id, id));
}

export async function deleteVcsConnection(
  database: Database,
  userId: string,
  provider: string,
): Promise<void> {
  await database
    .delete(vcsConnections)
    .where(and(eq(vcsConnections.userId, userId), eq(vcsConnections.provider, provider)));
}
