import { z } from "zod";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { isAutoReviewEnabled } from "../db/reviews";
import { resolveDefaultLlmModel } from "../llm/connections";

const payloadSchema = z.object({
  repository: z.object({ full_name: z.string() }),
  pull_request: z.object({ draft: z.boolean().optional() }),
});

export async function reviewSkipReason(
  database: Database,
  installationId: string,
  payload: unknown,
): Promise<string | null> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return "Event is missing repository or PR information.";
  if (parsed.data.pull_request.draft) return "Draft PR — reviews start when marked ready.";
  if (!(await isAutoReviewEnabled(database, installationId, parsed.data.repository.full_name)))
    return "Auto-review is off for this repository.";
  return null;
}

export async function integrationThinkingLevel(
  database: Database,
  config: Config,
  userId: string,
) {
  const model = await resolveDefaultLlmModel(database, config, userId);
  return model.thinkingLevels.includes("medium") ? ("medium" as const) : ("off" as const);
}
