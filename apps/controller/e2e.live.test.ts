import { randomBytes } from "node:crypto";
import { isTerminal } from "@pi-cloud-agent/protocol";
import { createSandboxProvider } from "@pi-cloud-agent/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "./config";
import { closeDatabase, createDatabase, type Database } from "./db/client";
import { migrateDatabase } from "./db/migrate-runner";
import { getRun, listEvents } from "./db/runs";
import {
  clearSessionWorkspace,
  createSessionTurn,
  createSessionWithRun,
  getSession,
} from "./db/sessions";
import { createLogger } from "./logger";
import { createReconciler, type Reconciler } from "./reconcile/loop";
import { createCredentialBroker } from "./secrets/broker";
import { manualTrigger } from "./test-support";

/**
 * The one test offline tests cannot replace.
 *
 * It boots a real sandbox on the configured provider, runs a real model through
 * the real agent harness, and requires the sandbox's outbound callbacks to reach
 * this process. It therefore validates the seams that only exist when everything
 * is real: the sandbox image, the harness, the model gateway, and the callback
 * path.
 *
 * It costs money and is never run in CI. See docs/testing.md.
 *
 *   pnpm sandbox:template
 *   pnpm test:live
 *
 * Set LIVE_TEST_REPO to a repository the configured forge credential can clone.
 */

const REPO = process.env.LIVE_TEST_REPO ?? "";
const SKIP_REASON = REPO.includes("/")
  ? ""
  : 'set LIVE_TEST_REPO="owner/name" to a repository the credential can clone';

let config: ReturnType<typeof getConfig>;
let database: Database;
let reconciler: Reconciler;

beforeAll(async () => {
  config = getConfig();

  // The sandbox dials back over CONTROL_PLANE_URL. A loopback address is
  // unreachable from E2B, and the run would go silent rather than fail — so
  // refuse up front with the reason, instead of burning ten minutes. The local
  // microSandbox provider intentionally uses its host gateway instead.
  if (
    config.sandbox.provider === "e2b" &&
    /localhost|127\.0\.0\.1|0\.0\.0\.0|host\.microsandbox\.internal/.test(
      config.controlPlaneUrl,
    )
  ) {
    throw new Error(
      `CONTROL_PLANE_URL is ${config.controlPlaneUrl}, which a hosted sandbox cannot reach. ` +
        "Start a tunnel and set it to the public URL; see docs/operations.md.",
    );
  }
  await assertControlPlaneReachable(config.controlPlaneUrl, config.sandbox.provider);

  database = createDatabase(config.databaseUrl);
  await migrateDatabase(database);

  reconciler = newReconciler();
  await reconciler.start();
});

afterAll(async () => {
  await reconciler?.stop();
  if (database) await closeDatabase(database);
});

describe("a real resumable session, end to end", () => {
  it.skipIf(SKIP_REASON !== "")(
    SKIP_REASON || "continues Pi history and an uncommitted workspace across real turns",
    async () => {
      const [owner, name] = REPO.split("/");
      const proof = `pi-resume-${randomBytes(8).toString("hex")}`;
      const proofFile = `.pi-resume-proof-${proof}.txt`;
      const trigger = manualTrigger({
        owner,
        name,
        cloneUrl: `https://github.com/${REPO}.git`,
      });
      trigger.prompt =
        `Create the uncommitted file ${proofFile} containing exactly ${proof}. ` +
        "Read it back, report the exact value, do not commit it, then stop.";

      const { session, run } = await createSessionWithRun(database, {
        title: "Live resumability proof",
        profile: "general",
        provider: "github",
        repoFullName: REPO,
        repo: trigger.repo,
        trigger,
        model: "live-test/model",
        callbackToken: randomBytes(32).toString("hex"),
      });

      try {
        const first = await waitForTerminal(run.id);
        expect(first.status, `first turn failed: ${first.error ?? "(no error recorded)"}`).toBe(
          "succeeded",
        );
        const firstIdle = await waitForSessionIdle(session.id);
        expect(firstIdle.sandboxId).toBe(first.sandboxId);

        const firstEvents = await listEvents(database, run.id, 0);
        const firstLogs = logNames(firstEvents);
        expect(firstLogs).toContain("git.cloned");
        expect(firstLogs).toContain("agent.session_created");
        expect(firstLogs).toContain("agent.session_checkpointed");
        expect(firstEvents.at(-1)?.type).toBe("status");

        // Prove a controller process can disappear while the session is idle.
        await reconciler.stop();
        reconciler = newReconciler();
        await reconciler.start();

        const followUp = await createSessionTurn(
          database,
          session.id,
          `Read ${proofFile}. Reply with its exact content and explain whether it was already present.`,
          randomBytes(32).toString("hex"),
        );
        const second = await waitForTerminal(followUp.id);
        expect(
          second.status,
          `second turn failed: ${second.error ?? "(no error recorded)"}`,
        ).toBe("succeeded");
        const secondIdle = await waitForSessionIdle(session.id);

        const secondEvents = await listEvents(database, followUp.id, 0);
        const secondLogs = logNames(secondEvents);
        expect(secondLogs).toContain("git.workspace_resumed");
        expect(secondLogs).toContain("agent.session_restored");
        expect(secondLogs).not.toContain("git.cloned");
        expect(second.sandboxId).toBe(first.sandboxId);
        expect(secondIdle.sandboxId).toBe(firstIdle.sandboxId);
        expect(piSessionId(secondEvents)).toBe(piSessionId(firstEvents));
        expect(tokenText(secondEvents)).toContain(proof);
        expect(new Set(secondEvents.map((event) => event.type))).toContain("tool_call");
      } finally {
        await cleanupSession(session.id);
      }
    },
    20 * 60 * 1000,
  );
});

function newReconciler(): Reconciler {
  const log = createLogger("live-test", { level: "info" });
  return createReconciler({
    config,
    database,
    broker: createCredentialBroker(config, database, log),
    log,
  });
}

async function waitForTerminal(runId: string) {
  const deadline = Date.now() + 9 * 60 * 1000;
  let current = await getRun(database, runId);
  while (current && !isTerminal(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    current = await getRun(database, runId);
  }
  if (!current) throw new Error("the live run disappeared");
  return current;
}

async function waitForSessionIdle(sessionId: string) {
  const deadline = Date.now() + 60_000;
  let session = await getSession(database, sessionId);
  while (session?.activeRunId && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    session = await getSession(database, sessionId);
  }
  if (!session || session.activeRunId) throw new Error("the live session did not become idle");
  if (!session.sandboxId) throw new Error("the live session became idle without a workspace");
  return session;
}

function logNames(events: Awaited<ReturnType<typeof listEvents>>): Set<string> {
  return new Set(
    events
      .filter((event) => event.type === "log")
      .map((event) => String(event.data.event ?? "")),
  );
}

function piSessionId(events: Awaited<ReturnType<typeof listEvents>>): string {
  const started = events.find(
    (event) => event.type === "log" && event.data.event === "agent.session_start",
  );
  const id = started?.data.sessionId;
  if (typeof id !== "string" || id === "") throw new Error("Pi session id was not reported");
  return id;
}

function tokenText(events: Awaited<ReturnType<typeof listEvents>>): string {
  return events
    .filter((event) => event.type === "token")
    .map((event) => String(event.data.content ?? ""))
    .join("");
}

async function cleanupSession(sessionId: string): Promise<void> {
  const session = await getSession(database, sessionId);
  if (!session) return;
  const latest = session.latestRunId ? await getRun(database, session.latestRunId) : null;
  const provider = createSandboxProvider(config.sandbox.provider, config.env);
  const ref = session.sandboxId
    ? { provider: session.sandboxProvider ?? provider.name, id: session.sandboxId }
    : latest?.sandboxId
      ? { provider: latest.sandboxProvider ?? provider.name, id: latest.sandboxId }
      : null;
  if (!ref) return;
  await provider.deleteWorkspace(ref).catch(() => provider.stop(ref));
  if (session.sandboxId) await clearSessionWorkspace(database, session.id, session.sandboxId);
}

async function assertControlPlaneReachable(baseUrl: string, provider: string): Promise<void> {
  const healthUrl = healthCheckUrl(baseUrl, provider);
  let response: Response;
  try {
    response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
  } catch (cause) {
    throw new Error(`CONTROL_PLANE_URL is not reachable at ${healthUrl}`, { cause });
  }
  if (!response.ok) {
    throw new Error(`CONTROL_PLANE_URL health check failed: ${response.status} ${healthUrl}`);
  }
}

function healthCheckUrl(baseUrl: string, provider: string): string {
  const url = new URL(`${baseUrl}/healthz`);
  if (provider === "microsandbox" && url.hostname === "host.microsandbox.internal") {
    url.hostname = "localhost";
  }
  return url.toString();
}
