import { z } from "zod";
import type { RunEvent } from "./events";
import type { RunStatus } from "./run";

/**
 * The controller's HTTP surface, shared with the dashboard.
 *
 * The web app imports these types instead of restating them, which is the whole
 * reason a protocol package exists: there is one definition of a run, and it
 * cannot drift between the server that writes it and the client that renders it.
 */

export const createRunRequestSchema = z.object({
  /** "owner/name" */
  repo: z.string().min(3),
  prompt: z.string().min(1),
  profile: z.string().default("general"),
  provider: z.string().default("github"),
  host: z.string().default("github.com"),
  /** Branch to clone. Omitted means "ask the provider for the default". */
  branch: z.string().nullish(),
});

export type CreateRunRequest = z.input<typeof createRunRequestSchema>;
export type CreateRunBody = z.output<typeof createRunRequestSchema>;

export const createSessionTurnRequestSchema = z.object({
  prompt: z.string().trim().min(1),
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
  error: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  turnNumber: number | null;
}

export interface RunDetail extends RunSummary {
  /** The request the agent was given, when the trigger carried one. */
  prompt: string | null;
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
  /** The single configured model id, e.g. "aigateway/MiniMax/MiniMax-M2.7". */
  model: string;
  profiles: ProfileInfo[];
  defaultProfile: string;
}

export interface ReposResponse {
  repos: string[];
  /** Where the list came from: explicit config, the provider, or nothing. */
  source: "config" | "provider" | "none";
}

export interface BranchesResponse {
  branches: string[];
  default: string | null;
}
