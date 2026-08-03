import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "./client";
import { type AppUserRow, appUsers, webSessions } from "./schema";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function upsertAppUser(
  database: Database,
  input: {
    githubUserId: string;
    login: string;
    displayName: string;
    avatarUrl?: string | null;
  },
): Promise<AppUserRow> {
  const [user] = await database
    .insert(appUsers)
    .values({ ...input, avatarUrl: input.avatarUrl ?? null })
    .onConflictDoUpdate({
      target: appUsers.githubUserId,
      set: {
        login: input.login,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!user) throw new Error("could not create application user");
  return user;
}

export async function createWebSession(
  database: Database,
  userId: string,
  secret: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const signature = sign(token, secret);
  await database.insert(webSessions).values({
    userId,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return `${token}.${signature}`;
}

export async function getAppUserForSession(
  database: Database,
  cookie: string | undefined,
  secret: string,
): Promise<AppUserRow | null> {
  const [token, signature] = cookie?.split(".") ?? [];
  if (!token || !signature || !validSignature(token, signature, secret)) return null;
  const [user] = await database
    .select({ user: appUsers })
    .from(webSessions)
    .innerJoin(appUsers, eq(webSessions.userId, appUsers.id))
    .where(and(eq(webSessions.tokenHash, hash(token)), gt(webSessions.expiresAt, new Date())))
    .limit(1);
  return user?.user ?? null;
}

export async function deleteWebSession(
  database: Database,
  cookie: string | undefined,
  secret: string,
): Promise<void> {
  const [token, signature] = cookie?.split(".") ?? [];
  if (!token || !signature || !validSignature(token, signature, secret)) return;
  await database.delete(webSessions).where(eq(webSessions.tokenHash, hash(token)));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function validSignature(value: string, actual: string, secret: string): boolean {
  const expected = Buffer.from(sign(value, secret));
  const received = Buffer.from(actual);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
