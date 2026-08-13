import type { Secret } from "./secret";

/**
 * Isolated compute. Standalone runs use `create`/`stop`; durable sessions use
 * `suspend`/`resume`/`deleteWorkspace` between turns.
 *
 * Every operation goes through the provider's control-plane SDK. The agent
 * sandbox remains outbound-only: no application route, tunnel, or agent server
 * is exposed inside it.
 *
 * See docs/adding-a-sandbox-provider.md.
 */
export interface SandboxProvider {
  readonly name: string;
  create(spec: SandboxSpec): Promise<SandboxRef>;
  /** Run a disposable command and return its output; used for preflight checks. */
  execute?(spec: SandboxSpec): Promise<SandboxExecutionResult>;
  /** Restore a session workspace and start exactly one new runtime command. */
  resume(ref: WorkspaceRef, spec: SandboxSpec): Promise<SandboxRef>;
  /** Persist the filesystem without retaining process memory or credentials. */
  suspend(ref: SandboxRef): Promise<WorkspaceRef>;
  /** Permanently remove a suspended workspace. Must be idempotent. */
  deleteWorkspace(ref: WorkspaceRef): Promise<void>;
  /** Must be idempotent: the reconciler may call it for an already-dead box. */
  stop(ref: SandboxRef): Promise<void>;
}

export interface SandboxExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SandboxSpec {
  /** Correlation only. Providers must not derive behavior from it. */
  runId: string;
  /** Provider-specific image or template identifier. */
  image: string;
  /** Hard ceiling after which the provider itself should reclaim the machine. */
  timeoutSeconds: number;
  /** Non-secret configuration. Safe to log. */
  env: Record<string, string>;
  /** Credentials. Kept separate so they can't be logged by accident. */
  secrets: Record<string, Secret>;
  /** The command that starts the runtime inside the sandbox. */
  command: string;
}

/** A handle durable enough to survive a controller restart: it is stored. */
export interface SandboxRef {
  provider: string;
  id: string;
}

/** An opaque provider-owned workspace checkpoint stored on a session row. */
export interface WorkspaceRef {
  provider: string;
  id: string;
}

/**
 * A provider failed. `retryable` distinguishes "the API blipped, try again"
 * from "this template does not exist, stop" — the reconciler uses it to decide
 * whether a run goes back to the queue or straight to failed.
 */
export class SandboxError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "SandboxError";
    this.retryable = options.retryable;
  }
}

/** The stored workspace reference expired or was deleted outside the controller. */
export class WorkspaceNotFoundError extends SandboxError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { retryable: false, cause: options.cause });
    this.name = "WorkspaceNotFoundError";
  }
}
