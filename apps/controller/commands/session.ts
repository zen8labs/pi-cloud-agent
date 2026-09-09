import { randomBytes } from "node:crypto";
import type { OwnedSessionCommand, SessionCommand, Trigger } from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { getExternalThread, getRunByIntegrationDelivery } from "../db/integrations";
import { getLlmConnection } from "../db/llm-connections";
import { type CreateRunInput, createRun } from "../db/runs";
import { createSessionTurn, createSessionWithRun, getSession } from "../db/sessions";
import {
  LlmModelSelectionError,
  type ResolvedLlmModel,
  resolveDefaultLlmModel,
  resolveLlmModel,
} from "../llm/connections";

export interface QueueSessionCommandResult {
  sessionId: string | null;
  runId: string;
  turnNumber: number | null;
}

/** The single trusted command path shared by chat and external integrations. */
export async function queueSessionCommand(
  database: Database,
  config: Config,
  command: OwnedSessionCommand,
): Promise<QueueSessionCommandResult> {
  const existingDelivery = await runForDelivery(database, command);
  if (existingDelivery) return commandResult(existingDelivery);

  try {
    return await queueNewSessionCommand(database, config, command);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const racedDelivery = await runForDelivery(database, command);
    if (racedDelivery) return commandResult(racedDelivery);
    throw error;
  }
}

async function queueNewSessionCommand(
  database: Database,
  config: Config,
  command: OwnedSessionCommand,
): Promise<QueueSessionCommandResult> {
  const model = await resolveCommandModel(database, config, command);
  const trigger = triggerFor(command);

  if (command.mode === "standalone_run") {
    const run = await createRun(database, runInput(command, model, trigger));
    return { sessionId: null, runId: run.id, turnNumber: null };
  }

  const existing = await findExistingSession(database, command);
  if (existing) {
    const run = await appendCommandTurn(database, command, existing.sessionId, model, trigger);
    return { sessionId: run.sessionId, runId: run.id, turnNumber: run.turnNumber };
  }

  const title = titleFrom(command.prompt, `${command.repo.owner}/${command.repo.name}`);
  if (command.provenance.externalThreadKey) {
    try {
      const created = await createSessionWithRun(
        database,
        sessionInput(command, model, trigger, title, command.provenance.externalThreadKey),
      );
      return {
        sessionId: created.session.id,
        runId: created.run.id,
        turnNumber: created.run.turnNumber,
      };
    } catch (error) {
      // Two webhook deliveries for one PR can be processed by different
      // controller replicas. A unique external-thread key makes the winner
      // authoritative; the loser retries as an ordinary follow-up turn.
      if (!isUniqueViolation(error)) throw error;
      const raced = await getExternalThread(
        database,
        command.repo.provider,
        command.provenance.externalThreadKey,
      );
      if (!raced) throw error;
      const run = await appendCommandTurn(database, command, raced.sessionId, model, trigger);
      return { sessionId: run.sessionId, runId: run.id, turnNumber: run.turnNumber };
    }
  }

  const created = await createSessionWithRun(
    database,
    sessionInput(command, model, trigger, title),
  );
  return { sessionId: created.session.id, runId: created.run.id, turnNumber: 1 };
}

async function runForDelivery(database: Database, command: SessionCommand) {
  const deliveryId = command.provenance.deliveryId;
  return deliveryId
    ? getRunByIntegrationDelivery(database, command.provenance.source, deliveryId)
    : null;
}

function commandResult(run: Awaited<ReturnType<typeof getRunByIntegrationDelivery>>) {
  if (!run) throw new Error("integration delivery run is unavailable");
  return { sessionId: run.sessionId, runId: run.id, turnNumber: run.turnNumber };
}

function sessionInput(
  command: OwnedSessionCommand,
  model: ResolvedLlmModel,
  trigger: Trigger,
  title: string,
  externalThreadKey?: string,
) {
  return {
    userId: command.userId,
    title,
    provider: command.repo.provider,
    repoFullName: fullName(command),
    repo: command.repo,
    trigger,
    model: `${model.provider}/${model.name}`,
    modelConnectionId: model.connectionId,
    thinkingLevel: command.thinkingLevel,
    callbackToken: randomBytes(32).toString("hex"),
    ...(externalThreadKey ? { externalThreadKey } : {}),
  };
}

async function appendCommandTurn(
  database: Database,
  command: OwnedSessionCommand,
  sessionId: string,
  model: ResolvedLlmModel,
  trigger: Trigger,
): Promise<Awaited<ReturnType<typeof createSessionTurn>>> {
  return createSessionTurn(
    database,
    sessionId,
    command.prompt,
    randomBytes(32).toString("hex"),
    command.userId,
    {
      model: `${model.provider}/${model.name}`,
      modelConnectionId: model.connectionId,
      thinkingLevel: command.thinkingLevel,
      trigger,
    },
  );
}

async function findExistingSession(
  database: Database,
  command: OwnedSessionCommand,
): Promise<{ sessionId: string } | null> {
  if (command.sessionId) {
    const session = await getSession(database, command.sessionId, command.userId);
    if (!session) throw new Error("session not found");
    return { sessionId: session.id };
  }
  if (!command.provenance.externalThreadKey) return null;
  return getExternalThread(
    database,
    command.repo.provider,
    command.provenance.externalThreadKey,
  );
}

async function resolveCommandModel(
  database: Database,
  config: Config,
  command: SessionCommand & { userId: string },
): Promise<ResolvedLlmModel> {
  let model: ResolvedLlmModel;
  if (command.modelConnectionId) {
    const connection = await getLlmConnection(
      database,
      command.userId,
      command.modelConnectionId,
    );
    if (!connection) {
      throw new LlmModelSelectionError(
        "connect a model provider in Settings before starting a task",
      );
    }
    model = await resolveLlmModel(
      database,
      config,
      command.userId,
      connection.id,
      command.modelId ?? connection.model,
    );
  } else {
    model = await resolveDefaultLlmModel(database, config, command.userId);
  }
  if (!model.thinkingLevels.includes(command.thinkingLevel)) {
    throw new LlmModelSelectionError(
      `${command.thinkingLevel} thinking is not available for this model`,
    );
  }
  return model;
}

function triggerFor(command: SessionCommand): Trigger {
  const kind =
    command.intent === "github_review"
      ? command.provenance.action === "synchronize"
        ? "pr_updated"
        : "pr_opened"
      : command.intent === "github_task"
        ? "pr_comment"
        : "manual";
  return {
    kind,
    repo: command.repo,
    prompt: command.prompt,
    source: command.provenance.source,
    deliveryId: command.provenance.deliveryId,
    eventType: command.provenance.eventType,
    action: command.provenance.action,
    externalThreadKey: command.provenance.externalThreadKey,
    integrationId: command.provenance.integrationId,
    externalMessageId: command.provenance.externalMessageId,
    externalActor: command.provenance.externalActor,
    intent: command.intent,
  };
}

function runInput(
  command: OwnedSessionCommand,
  model: ResolvedLlmModel,
  trigger: Trigger,
): CreateRunInput {
  return {
    userId: command.userId,
    provider: command.repo.provider,
    repoFullName: fullName(command),
    trigger,
    model: `${model.provider}/${model.name}`,
    modelConnectionId: model.connectionId,
    thinkingLevel: command.thinkingLevel,
    callbackToken: randomBytes(32).toString("hex"),
  };
}

function fullName(command: SessionCommand): string {
  return `${command.repo.owner}/${command.repo.name}`;
}

function titleFrom(prompt: string, repo: string): string {
  const title = prompt.replace(/\s+/g, " ").trim() || repo;
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
