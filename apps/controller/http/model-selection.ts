import type { ThinkingLevel } from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import type { Database } from "../db/client";
import type { ResolvedLlmModel } from "../llm/connections";
import { LlmModelSelectionError, resolveLlmModel } from "../llm/connections";

export type RequestedLlmModelResult =
  | { ok: true; model: ResolvedLlmModel }
  | { ok: false; error: string };

export async function resolveRequestedLlmModel(
  database: Database,
  config: Config,
  userId: string,
  connectionId: string,
  modelId: string,
  thinkingLevel: ThinkingLevel,
): Promise<RequestedLlmModelResult> {
  try {
    const model = await resolveLlmModel(database, config, userId, connectionId, modelId);
    if (!model.thinkingLevels.includes(thinkingLevel)) {
      return { ok: false, error: `${thinkingLevel} thinking is not available for this model` };
    }
    return { ok: true, model };
  } catch (error) {
    if (error instanceof LlmModelSelectionError) return { ok: false, error: error.message };
    throw error;
  }
}
