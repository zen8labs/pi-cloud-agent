import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client";
import { sessions } from "./schema";

/** Pin and return the canonical repository image selected by the first worker. */
export async function pinSessionSandboxImage(
  database: Database,
  sessionId: string,
  imageRef: string,
): Promise<string | null> {
  const [updated] = await database
    .update(sessions)
    .set({
      sandboxImageRef: sql`coalesce(${sessions.sandboxImageRef}, ${imageRef})`,
      updatedAt: new Date(),
    })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.sessionOperation)))
    .returning({ sandboxImageRef: sessions.sandboxImageRef });
  return updated?.sandboxImageRef ?? null;
}
