export type RunStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "publishing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunSummary {
  id: string;
  status: RunStatus;
  bundle: string;
  model: string | null;
  provider: string;
  repo: string;
  pr_number: number | null;
  error: string | null;
  created_at: string;
}

export interface Finding {
  file: string;
  line: number | null;
  severity: string;
  title: string;
  grounded: boolean;
  published: boolean;
}

export interface RunDetail extends RunSummary {
  prompt: string | null;
  findings: Finding[];
}

export interface AgentEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface AppConfig {
  model: string;
  available_models: ModelOption[];
  default_model: string;
  bundles: string[];
  default_bundle: string;
}

export interface RepoBranch {
  repo: string;
  /** Pinned PR-review branch; empty string means "use the repo default". */
  branch: string;
}

export const TERMINAL: RunStatus[] = ["succeeded", "failed", "cancelled"];

export function isTerminal(s: RunStatus): boolean {
  return TERMINAL.includes(s);
}
