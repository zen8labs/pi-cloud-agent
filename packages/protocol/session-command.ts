import { z } from "zod";
import { thinkingLevelSchema } from "./llm";
import { provenanceSchema } from "./provenance";
import { repoRefSchema } from "./repo";

/** The execution shape shared by chat, API, and external integrations. */
export const SESSION_COMMAND_MODES = ["new_session", "append_turn", "standalone_run"] as const;

export const sessionCommandModeSchema = z.enum(SESSION_COMMAND_MODES);
export type SessionCommandMode = (typeof SESSION_COMMAND_MODES)[number];

export const SESSION_COMMAND_INTENTS = ["general", "github_review", "github_task"] as const;
export const sessionCommandIntentSchema = z.enum(SESSION_COMMAND_INTENTS);
export type SessionCommandIntent = (typeof SESSION_COMMAND_INTENTS)[number];

export const sessionCommandProvenanceSchema = provenanceSchema;

export type SessionCommandProvenance = z.infer<typeof sessionCommandProvenanceSchema>;

export const sessionCommandSchema = z.object({
  repo: repoRefSchema,
  prompt: z.string().trim().min(1).max(200_000),
  mode: sessionCommandModeSchema.default("new_session"),
  intent: sessionCommandIntentSchema.default("general"),
  sessionId: z.string().uuid().optional(),
  /** Optional for integrations; the controller uses the user's default model. */
  modelConnectionId: z.string().uuid().nullable().optional(),
  modelId: z.string().min(1).nullable().optional(),
  /** Optional for integrations; medium is the stable controller default. */
  thinkingLevel: thinkingLevelSchema.default("medium"),
  provenance: sessionCommandProvenanceSchema,
});

export type SessionCommand = z.infer<typeof sessionCommandSchema>;

/** The controller-facing input keeps ownership outside the portable command. */
export interface OwnedSessionCommand extends SessionCommand {
  userId: string;
}
