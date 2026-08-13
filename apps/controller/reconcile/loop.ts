import type { SandboxProvider } from "@pi-cloud-agent/protocol";
import { createSandboxProvider } from "@pi-cloud-agent/sandbox";
import type { Config } from "../config";
import { CHANNELS, createNotifier, type Database } from "../db/client";
import {
  claimNextRun,
  completeRun,
  findExpiredRuns,
  findReclaimableClaims,
  findSandboxesToStop,
  findSilentRuns,
  markSandboxStopped,
  requeueRun,
} from "../db/runs";
import type { RunRow, SessionRow } from "../db/schema";
import {
  clearSessionWorkspace,
  findExpiredSessionWorkspaces,
  findSessionRunsToPark,
  getSession,
  parkSession,
} from "../db/sessions";
import type { Logger } from "../logger";
import type { CredentialBroker } from "../secrets/broker";
import { type ProvisionDeps, provisionRun } from "./provision";

/**
 * The reconciler: one loop that reads durable state and repairs it.
 *
 * Every branch below answers a question about the database and takes exactly one
 * action. None of them care whether the previous tick ran a second ago or before
 * a restart three hours back, which is what makes crash recovery ordinary rather
 * than a special path. This single loop replaces what used to be three separate
 * mechanisms: a blocking wait per run, an `asyncio` wall-clock timeout, and a
 * startup sweep that force-failed anything it found in flight.
 *
 * See docs/resumability.md.
 */

export interface ReconcilerOptions {
  config: Config;
  database: Database;
  broker: CredentialBroker;
  log: Logger;
  /**
   * How a provider is obtained by name. Defaults to the real registry.
   *
   * Resolved by name rather than passed as a single instance because a run
   * recorded under a different provider still has to be reclaimable after the
   * configuration changes — and because it lets the tests drive the state
   * machine without booting real machines.
   */
  createProvider?: (name: string) => SandboxProvider;
  /** Optional shared provider instance for dashboard preflight commands. */
  sandbox?: SandboxProvider;
  /** How long a claim is valid before another worker may take the run. */
  claimLeaseSeconds?: number;
  /** Silence from a live sandbox that means it is never coming back. */
  silenceTimeoutSeconds?: number;
  /** Ceiling on runs being provisioned at once. */
  maxConcurrentProvisions?: number;
  /** Fallback poll interval. NOTIFY makes the common case immediate. */
  pollIntervalMs?: number;
}

export interface Reconciler {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Run one full pass. Exposed so tests can drive the loop deterministically. */
  tick(): Promise<void>;
  /**
   * Wait for provisioning started by earlier ticks to settle.
   *
   * Provisioning is detached from the tick that started it, so that a slow
   * sandbox API cannot delay timeouts or teardown for other runs. That makes
   * "the tick returned" different from "the work finished", so both shutdown and
   * the tests need a way to wait for the difference.
   */
  drain(): Promise<void>;
}

const BATCH = 25;

export function createReconciler(options: ReconcilerOptions): Reconciler {
  const {
    config,
    database,
    broker,
    log,
    claimLeaseSeconds = 120,
    silenceTimeoutSeconds = 600,
    maxConcurrentProvisions = 4,
    pollIntervalMs = 2000,
    createProvider = (name: string) => createSandboxProvider(name, config.env),
    sandbox: providedSandbox,
  } = options;

  const sandbox = providedSandbox ?? createProvider(config.sandbox.provider);
  const provisionDeps: ProvisionDeps = { config, database, broker, sandbox, log };

  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;
  let unlisten: (() => Promise<void>) | null = null;
  let notifier: ReturnType<typeof createNotifier> | null = null;
  // Constructing a reconciler must not open a connection — only `start` does.
  const inFlight = new Set<Promise<void>>();

  /** Stop a sandbox and record that we did, so it is never stopped twice. */
  async function reclaim(run: RunRow, reason: string): Promise<void> {
    if (!run.sandboxId || !run.sandboxProvider) return;
    const runLog = log.child({ runId: run.id, sandboxId: run.sandboxId });
    try {
      const provider =
        run.sandboxProvider === sandbox.name ? sandbox : createProvider(run.sandboxProvider);
      await provider.stop({ provider: run.sandboxProvider, id: run.sandboxId });
      runLog.info("sandbox reclaimed", { reason });
    } catch (error) {
      // Deliberately still marked stopped: a provider that cannot kill a machine
      // will not start succeeding on the next tick, and retrying forever would
      // turn one stuck sandbox into an endless loop. The provider's own timeout
      // is the backstop.
      runLog.error("sandbox stop failed; giving up on it", { reason, error });
    }
    await markSandboxStopped(database, run.id);
  }

  /** Suspend a session workspace, or release the session cold if suspension fails. */
  async function park(run: RunRow, reason: string): Promise<void> {
    if (!run.sessionId) {
      await reclaim(run, reason);
      return;
    }
    if (!run.sandboxId || !run.sandboxProvider) {
      // A promoted turn can be cancelled before it resumes the session's
      // parked workspace. It owns no sandbox to suspend, so preserve the
      // existing workspace reference for the next queued turn.
      await parkSession(database, run, undefined, null);
      return;
    }

    const provider =
      run.sandboxProvider === sandbox.name ? sandbox : createProvider(run.sandboxProvider);
    const ref = { provider: run.sandboxProvider, id: run.sandboxId };
    try {
      const workspace = await provider.suspend(ref);
      const expiresAt = new Date(Date.now() + config.sessionWorkspaceRetentionSeconds * 1000);
      const parked = await parkSession(database, run, workspace, expiresAt);
      if (parked) {
        log.info("session workspace suspended", {
          sessionId: run.sessionId,
          runId: run.id,
          workspaceId: workspace.id,
          reason,
        });
      } else {
        const current = await getSession(database, run.sessionId);
        const stillOwned = current?.activeRunId || current?.sandboxId === workspace.id;
        if (!stillOwned) await provider.deleteWorkspace(workspace);
      }
    } catch (error) {
      log.error("session workspace suspension failed; continuing cold", {
        sessionId: run.sessionId,
        runId: run.id,
        error,
      });
      await provider.stop(ref).catch(() => undefined);
      await parkSession(database, run, null, null);
    }
  }

  async function expireWorkspace(session: SessionRow): Promise<void> {
    if (!session.sandboxId || !session.sandboxProvider) return;
    const provider =
      session.sandboxProvider === sandbox.name
        ? sandbox
        : createProvider(session.sandboxProvider);
    try {
      await provider.deleteWorkspace({
        provider: session.sandboxProvider,
        id: session.sandboxId,
      });
    } catch (error) {
      log.error("expired session workspace deletion failed; giving up", {
        sessionId: session.id,
        workspaceId: session.sandboxId,
        error,
      });
    }
    await clearSessionWorkspace(database, session.id, session.sandboxId);
  }

  async function drainQueue(): Promise<void> {
    // Two bounds per pass, not one: a pass starts at most `maxConcurrentProvisions`
    // new provisions, and never claims the same run twice. Both matter only when
    // provisioning settles faster than the next claim query — a fast failure
    // requeues its run, and without these bounds the same pass would reclaim it
    // immediately, turning one tick into a retry storm. The next tick (woken by
    // the settle or the requeue NOTIFY) picks the run up instead.
    const claimed = new Set<string>();
    let available = maxConcurrentProvisions - inFlight.size;
    while (available > 0) {
      const run = await claimNextRun(database, claimLeaseSeconds, [...claimed]);
      if (!run) return;
      claimed.add(run.id);
      available -= 1;
      // Detached on purpose: provisioning talks to a sandbox API and must not
      // hold up timeouts or teardown for other runs. `drain` waits for these.
      const pending = provisionRun(run, provisionDeps)
        .catch((error) => log.error("unhandled provisioning error", { runId: run.id, error }))
        .finally(() => {
          inFlight.delete(pending);
          wake?.();
        });
      inFlight.add(pending);
    }
  }

  async function failAndReclaim(
    runs: RunRow[],
    reason: string,
    message: string,
  ): Promise<void> {
    for (const run of runs) {
      const changed = await completeRun(database, run.id, "failed", message);
      if (changed) log.warn("run failed by the reconciler", { runId: run.id, reason });
      await park(run, reason);
    }
  }

  async function tick(): Promise<void> {
    // Ordered cheapest-first, and teardown before new work so a busy queue can
    // never starve reclamation of machines that are still costing money.
    for (const run of await findSandboxesToStop(database, BATCH)) {
      await reclaim(run, "run finished");
    }

    for (const run of await findSessionRunsToPark(database, BATCH)) {
      await park(run, "turn finished");
    }

    for (const session of await findExpiredSessionWorkspaces(database, BATCH)) {
      await expireWorkspace(session);
    }

    await failAndReclaim(
      await findExpiredRuns(database, BATCH),
      "deadline exceeded",
      "the run exceeded its wall-clock budget",
    );

    await failAndReclaim(
      await findSilentRuns(database, silenceTimeoutSeconds, BATCH),
      "sandbox went silent",
      `the sandbox stopped reporting for more than ${silenceTimeoutSeconds}s`,
    );

    for (const run of await findReclaimableClaims(database, BATCH)) {
      // Claimed but never provisioned: whoever held it is gone, and no sandbox
      // was ever created, so another attempt is safe.
      if (await requeueRun(database, run.id)) {
        log.warn("reclaimed an expired claim", { runId: run.id, attempt: run.attempt });
      }
    }

    await drainQueue();
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        await tick();
      } catch (error) {
        log.error("reconciler tick failed", { error });
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          timer = null;
          wake = null;
          resolve();
        };
        wake = finish;
        timer = setTimeout(finish, pollIntervalMs);
      });
    }
  }

  async function drain(): Promise<void> {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      notifier = createNotifier(config.databaseUrl);
      // A notification only means "look again" — the poll in `loop` is what
      // guarantees progress if one is ever missed.
      unlisten = await notifier.listen(CHANNELS.runQueued, () => wake?.());
      log.info("reconciler started", {
        provider: sandbox.name,
        maxConcurrentProvisions,
        silenceTimeoutSeconds,
      });
      void loop();
    },

    async stop(): Promise<void> {
      running = false;
      wake?.();
      if (timer) clearTimeout(timer);
      await unlisten?.();
      await notifier?.close();
      notifier = null;
      // In-flight provisioning is finished rather than abandoned: a sandbox whose
      // id has not been stored yet would otherwise leak.
      await drain();
      log.info("reconciler stopped");
    },

    tick,
    drain,
  };
}
