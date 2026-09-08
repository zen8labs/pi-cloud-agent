import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import { runs, type SessionRow, sessions } from "./schema";

export async function listSessions(
  database: Database,
  limit: number,
  userId?: string | null,
  mode?: "tasks" | "reviews",
): Promise<SessionRow[]> {
  const hasReviews = sql`exists (select 1 from ${runs} where ${runs.sessionId} = ${sessions.id} and ${runs.trigger}->>'intent' = 'github_review')`;
  return database
    .select()
    .from(sessions)
    .where(
      and(
        userId ? eq(sessions.userId, userId) : undefined,
        mode === "reviews" ? hasReviews : mode === "tasks" ? sql`not ${hasReviews}` : undefined,
      ),
    )
    .orderBy(desc(sessions.pinned), desc(sessions.updatedAt))
    .limit(limit);
}
