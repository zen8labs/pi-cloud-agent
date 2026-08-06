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

export async function rotateLlmConnection(
  database: Database,
  userId: string,
  id: string,
  input: Omit<CreateLlmConnectionInput, "userId">,
): Promise<LlmConnectionRow> {
  const [row] = await database.transaction(async (tx) => {
    await clearDefaultIfNeeded(tx, userId, input.isDefault);
    if (!(await retireLlmConnection(tx, userId, id))) {
      throw new Error("model connection to rotate was not found");
    }
    return tx
      .insert(llmConnections)
      .values({ ...input, userId })
      .returning();
  });
  if (!row) throw new Error("insert into llm_connections returned no row");
  await purgeDeletedLlmConnections(database);
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

export async function setDefaultLlmConnection(
  database: Database,
  userId: string,
  id: string,
  modelId?: string,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: llmConnections.id, models: llmConnections.models })
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

    const selectedModel = modelId
      ? target.models.find((model) => model.id === modelId)
      : undefined;
    if (modelId && !selectedModel) return false;

    await tx
      .update(llmConnections)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(llmConnections.userId, userId));
    await tx
      .update(llmConnections)
      .set({
        isDefault: true,
        ...(selectedModel
          ? {
              model: selectedModel.id,
              contextWindow: selectedModel.contextWindow,
              maxTokens: selectedModel.maxTokens,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(llmConnections.id, id), eq(llmConnections.userId, userId)));
    return true;
  });
}

export async function deleteLlmConnection(
  database: Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const deleted = await retireLlmConnection(database, userId, id);
  await purgeDeletedLlmConnections(database);
  return deleted;
}

async function retireLlmConnection(
  writer: Pick<Database, "update">,
  userId: string,
  id: string,
): Promise<boolean> {
  const retired = await writer
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
  return retired.length > 0;
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
