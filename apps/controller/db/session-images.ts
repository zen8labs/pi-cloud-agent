import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client";
import { sessions } from "./schema";

export interface SessionSandboxImage {
  provider: string;
  imageRef: string;
}

/** Pin and return the canonical repository image selected by the first worker. */
export async function pinSessionSandboxImage(
  database: Database,
  sessionId: string,
  provider: string,
  imageRef: string,
): Promise<SessionSandboxImage | null> {
  const [updated] = await database
    .update(sessions)
    .set({
      sandboxImageProvider: sql`coalesce(${sessions.sandboxImageProvider}, ${provider})`,
      sandboxImageRef: sql`coalesce(${sessions.sandboxImageRef}, ${imageRef})`,
      updatedAt: new Date(),
    })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.sessionOperation)))
    .returning({
      sandboxImageProvider: sessions.sandboxImageProvider,
      sandboxImageRef: sessions.sandboxImageRef,
    });
  if (!updated?.sandboxImageProvider || !updated.sandboxImageRef) return null;
  return { provider: updated.sandboxImageProvider, imageRef: updated.sandboxImageRef };
}
