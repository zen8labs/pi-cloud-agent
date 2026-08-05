import type { LlmModelOption } from "@pi-cloud-agent/protocol";
import { and, desc, eq, isNotNull, isNull, notExists } from "drizzle-orm";
import type { Database } from "./client";
import { type LlmConnectionRow, llmConnections, runs, sessions } from "./schema";

export interface CreateLlmConnectionInput {
  userId: string;
  displayName: string;
  provider: string;
  authType: LlmConnectionRow["authType"];
  api: LlmConnectionRow["api"];
  baseUrl: string;
  model: string;
  models: LlmModelOption[];
  contextWindow: number;
  maxTokens: number;
  credential: string;
  isDefault: boolean;
}

export async function createLlmConnection(
  database: Database,
  input: CreateLlmConnectionInput,
): Promise<LlmConnectionRow> {
  const [row] = await database.transaction(async (tx) => {
    await clearDefaultIfNeeded(tx, input.userId, input.isDefault);
    return tx.insert(llmConnections).values(input).returning();
  });
  if (!row) throw new Error("insert into llm_connections returned no row");
  return row;
}

export async function updateLlmConnection(
  database: Database,
  userId: string,
  id: string,
  input: Omit<CreateLlmConnectionInput, "userId">,
): Promise<LlmConnectionRow> {
  const [row] = await database.transaction(async (tx) => {
    await clearDefaultIfNeeded(tx, userId, input.isDefault);
    return tx
      .update(llmConnections)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(llmConnections.id, id), eq(llmConnections.userId, userId)))
      .returning();
  });
  if (!row) throw new Error("model connection to update was not found");
  return row;
}

async function clearDefaultIfNeeded(
  writer: Pick<Database, "update">,
  userId: string,
  isDefault: boolean,
): Promise<void> {
  if (!isDefault) return;
  await writer
    .update(llmConnections)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(eq(llmConnections.userId, userId));
}

export async function getLlmConnection(
  database: Database,
  userId: string,
  id: string,
): Promise<LlmConnectionRow | null> {
  return findLlmConnection(database, userId, id, false);
}

export async function getLlmConnectionForRun(
  database: Database,
  userId: string,
  id: string,
): Promise<LlmConnectionRow | null> {
  return findLlmConnection(database, userId, id, true);
}

async function findLlmConnection(
  database: Database,
  userId: string,
  id: string,
  includeDeleted: boolean,
): Promise<LlmConnectionRow | null> {
  const predicates = [eq(llmConnections.id, id), eq(llmConnections.userId, userId)];
  if (!includeDeleted) predicates.push(isNull(llmConnections.deletedAt));
  const [row] = await database
    .select()
    .from(llmConnections)
    .where(and(...predicates))
    .limit(1);
  return row ?? null;
}

export async function listLlmConnections(
  database: Database,
  userId: string,
): Promise<LlmConnectionRow[]> {
  return database
    .select()
    .from(llmConnections)
    .where(and(eq(llmConnections.userId, userId), isNull(llmConnections.deletedAt)))
    .orderBy(desc(llmConnections.isDefault), desc(llmConnections.updatedAt));
}

export async function getDefaultLlmConnection(
  database: Database,
  userId: string,
): Promise<LlmConnectionRow | null> {
  const [row] = await database
    .select()
    .from(llmConnections)
    .where(
      and(
        eq(llmConnections.userId, userId),
        eq(llmConnections.isDefault, true),
        isNull(llmConnections.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function setDefaultLlmConnection(
  database: Database,
  userId: string,
  id: string,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: llmConnections.id })
      .from(llmConnections)
      .where(
        and(
          eq(llmConnections.id, id),
          eq(llmConnections.userId, userId),
          isNull(llmConnections.deletedAt),
        ),
      )
      .limit(1);
    if (!target) return false;

    await tx
      .update(llmConnections)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(llmConnections.userId, userId));
    await tx
      .update(llmConnections)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(eq(llmConnections.id, id), eq(llmConnections.userId, userId)));
    return true;
  });
}

export async function deleteLlmConnection(
  database: Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const deleted = await database
    .update(llmConnections)
    .set({ deletedAt: new Date(), isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(llmConnections.id, id),
        eq(llmConnections.userId, userId),
        isNull(llmConnections.deletedAt),
      ),
    )
    .returning({ id: llmConnections.id });
  await purgeDeletedLlmConnections(database);
  return deleted.length > 0;
}

async function purgeDeletedLlmConnections(database: Database): Promise<void> {
  await database
    .delete(llmConnections)
    .where(
      and(
        isNotNull(llmConnections.deletedAt),
        notExists(
          database
            .select({ id: runs.id })
            .from(runs)
            .where(eq(runs.modelConnectionId, llmConnections.id)),
        ),
        notExists(
          database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.modelConnectionId, llmConnections.id)),
        ),
      ),
    );
}
