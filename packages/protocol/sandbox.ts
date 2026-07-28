import type { Secret } from "./secret";

/**
 * Isolated compute, in two methods.
 *
 * `create` boots a machine from an image and starts one command in it; `stop`
 * destroys it. That is the entire contract, and it stays this small because the
 * sandbox is outbound-only: the controller never dials in, so no provider has
 * to expose port forwarding, tunnels, or reachability. Snapshots and warm pools
 * are optimizations *behind* these two methods, not additions to them.
 *
 * See docs/adding-a-sandbox-provider.md.
 */
export interface SandboxProvider {
  readonly name: string;
  create(spec: SandboxSpec): Promise<SandboxRef>;
  /** Must be idempotent: the reconciler may call it for an already-dead box. */
  stop(ref: SandboxRef): Promise<void>;
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
