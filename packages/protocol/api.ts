import { z } from "zod";
import type { RunEvent } from "./events";
import { type ThinkingLevel, thinkingLevelSchema } from "./llm";
import type { VcsRepository } from "./repo";
import type { RunStatus } from "./run";

/**
 * The controller's HTTP surface, shared with the dashboard.
 *
 * The web app imports these types instead of restating them, which is the whole
 * reason a protocol package exists: there is one definition of a run, and it
 * cannot drift between the server that writes it and the client that renders it.
 */

export const createRunRequestSchema = z.object({
  /** Provider-specific full repository name. */
  repo: z.string().min(3),
  prompt: z.string().min(1),
  profile: z.string().default("general"),
  provider: z.string().default("github"),
  /** Branch to clone. Omitted means "ask the provider for the default". */
  branch: z.string().nullish(),
  /** User-owned model connection. Required for every task. */
  modelConnectionId: z.string().uuid(),
  /** Model selected from the connection's available model catalog. */
  modelId: z.string().min(1),
  thinkingLevel: thinkingLevelSchema,
});

export type CreateRunRequest = z.input<typeof createRunRequestSchema>;
export type CreateRunBody = z.output<typeof createRunRequestSchema>;

export const createSessionTurnRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  /** User-owned model connection selected for this turn. */
  modelConnectionId: z.string().uuid(),
  /** Model selected from the connection's current catalog. */
  modelId: z.string().min(1),
  thinkingLevel: thinkingLevelSchema,
});

export type CreateSessionTurnRequest = z.infer<typeof createSessionTurnRequestSchema>;

export const sessionCheckpointSchema = z.object({
  content: z.string().max(20_000_000),
});

export type SessionCheckpoint = z.infer<typeof sessionCheckpointSchema>;

export interface RunSummary {
  id: string;
  status: RunStatus;
  profile: string;
  provider: string;
  repo: string;
  /** Resolved when the run was created, so it stays accurate if config changes. */
  model: string;
  modelConnectionId: string | null;
  thinkingLevel: ThinkingLevel;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  turnNumber: number | null;
}

export interface RunDetail extends RunSummary {
  /** The request the agent was given, when the trigger carried one. */
  prompt: string | null;
  /** Branch the run cloned (or the repo default when none was pinned). */
  branch: string | null;
  headSha: string | null;
  /** Set once a sandbox exists; cleared conceptually when it is reclaimed. */
  sandboxStoppedAt: string | null;
}

export interface RunListResponse {
  runs: RunSummary[];
}

export interface RunEventsResponse {
  events: RunEvent[];
}

export type SessionStatus = "idle" | "queued" | "provisioning" | "running" | "parking";

export interface SessionSummary {
  id: string;
  status: SessionStatus;
  title: string;
  profile: string;
  provider: string;
  repo: string;
  model: string;
  modelConnectionId: string | null;
  activeRunId: string | null;
  latestRunId: string;
  workspaceAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends SessionSummary {
  runs: RunDetail[];
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface ProfileInfo {
  name: string;
  description: string;
  configJsonSchema: Record<string, unknown>;
}

export interface ConfigResponse {
  profiles: ProfileInfo[];
  defaultProfile: string;
}

export interface ReposResponse {
  repos: VcsRepository[];
  /** Where the list came from: a connected identity or nothing. */
  source: "connection" | "none";
}

export interface VcsConnectionSummary {
  provider: string;
  displayName: string;
  configured: boolean;
  connected: boolean;
  accountName: string | null;
}

export interface VcsConnectionsResponse {
  connections: VcsConnectionSummary[];
}

export interface AppUserSummary {
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface BranchesResponse {
  branches: string[];
  default: string | null;
}
