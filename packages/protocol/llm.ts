import { z } from "zod";

export const LLM_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
] as const;

export const llmApiSchema = z.enum(LLM_APIS);
export type LlmApi = (typeof LLM_APIS)[number];

export const LLM_AUTH_TYPES = ["api_key", "oauth"] as const;
export const llmAuthTypeSchema = z.enum(LLM_AUTH_TYPES);
export type LlmAuthType = (typeof LLM_AUTH_TYPES)[number];

export const oauthCredentialSchema = z
  .object({
    type: z.literal("oauth"),
    access: z.string().min(1).max(100_000),
    refresh: z.string().min(1).max(100_000),
    expires: z.number().finite(),
  })
  .passthrough();
export type OAuthCredential = z.infer<typeof oauthCredentialSchema>;
export const oauthCredentialUpdateSchema = z.object({
  previous: oauthCredentialSchema,
  credential: oauthCredentialSchema,
});
export type OAuthCredentialUpdate = z.infer<typeof oauthCredentialUpdateSchema>;

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const thinkingLevelSchema = z.enum(THINKING_LEVELS);
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const createLlmConnectionSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  provider: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/i,
      "provider may contain only letters, numbers, dots, underscores, and dashes",
    ),
  api: llmApiSchema.default("openai-completions"),
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine(
      (value) => {
        const url = new URL(value);
        return !url.username && !url.password;
      },
      { message: "base URL must not contain embedded credentials" },
    ),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().min(1).max(10_000),
  contextWindow: z.number().int().positive().max(10_000_000).default(196_608),
  maxTokens: z.number().int().positive().max(1_000_000).default(32_000),
  isDefault: z.boolean().default(false),
});

export type CreateLlmConnectionRequest = z.input<typeof createLlmConnectionSchema>;
export type CreateLlmConnectionBody = z.output<typeof createLlmConnectionSchema>;

export interface LlmModelOption {
  id: string;
  baseUrl?: string;
  contextWindow: number;
  maxTokens: number;
  thinkingLevels?: ThinkingLevel[];
}

export interface LlmConnectionSummary {
  id: string;
  displayName: string;
  provider: string;
  authType: LlmAuthType;
  api: LlmApi;
  baseUrl: string;
  model: string;
  models: LlmModelOption[];
  contextWindow: number;
  maxTokens: number;
  isDefault: boolean;
  warning: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmConnectionsResponse {
  connections: LlmConnectionSummary[];
}
