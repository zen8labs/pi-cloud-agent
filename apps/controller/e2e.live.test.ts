import { randomBytes } from "node:crypto";
import { isTerminal } from "@pi-cloud-agent/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "./config";
import { closeDatabase, createDatabase, type Database } from "./db/client";
import { migrateDatabase } from "./db/migrate-runner";
import { createRun, getRun, listEvents } from "./db/runs";
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
  // unreachable from a hosted sandbox, and the run would go silent rather than
  // fail — so refuse up front with the reason, instead of burning ten minutes.
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(config.controlPlaneUrl)) {
    throw new Error(
      `CONTROL_PLANE_URL is ${config.controlPlaneUrl}, which a hosted sandbox cannot reach. ` +
        "Start a tunnel and set it to the public URL; see docs/operations.md.",
    );
  }
  await assertControlPlaneReachable(config.controlPlaneUrl);

  database = createDatabase(config.databaseUrl);
  await migrateDatabase(database);

  const log = createLogger("live-test", { level: "info" });
  reconciler = createReconciler({
    config,
    database,
    broker: createCredentialBroker(config, log),
    log,
  });
  await reconciler.start();
});

afterAll(async () => {
  await reconciler?.stop();
  if (database) await closeDatabase(database);
});

describe("a real run, end to end", () => {
  it.skipIf(SKIP_REASON !== "")(
    SKIP_REASON || "clones, runs the agent, reports done, and gets reclaimed",
    async () => {
      const [owner, name] = REPO.split("/");
      const trigger = manualTrigger({
        owner,
        name,
        cloneUrl: `https://github.com/${REPO}.git`,
      });
      trigger.prompt = "Report the subject of the latest commit, then stop.";

      const run = await createRun(database, {
        profile: "general",
        provider: "github",
        repoFullName: REPO,
        trigger,
        model: config.model.id,
        callbackToken: randomBytes(32).toString("hex"),
      });

      // The reconciler is running, so this waits on the same path production
      // uses: durable state, polled.
      const deadline = Date.now() + 9 * 60 * 1000;
      let final = run;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const current = await getRun(database, run.id);
        if (!current) throw new Error("the run disappeared");
        final = current;
        if (isTerminal(current.status)) break;
      }

      expect(final.status, `run failed: ${final.error ?? "(no error recorded)"}`).toBe(
        "succeeded",
      );

      const events = await listEvents(database, run.id, 0);
      const types = new Set(events.map((event) => event.type));
      const logged = new Set(
        events.filter((e) => e.type === "log").map((e) => String(e.data.event ?? "")),
      );

      // The checkout happened inside the sandbox.
      expect(logged).toContain("git.cloned");
      // The harness actually started and finished.
      expect(logged).toContain("agent.session_start");
      expect(logged).toContain("agent.session_complete");
      // The model produced output and used at least one tool.
      expect(types).toContain("token");
      expect(types).toContain("tool_call");
      // Completion came from the sandbox's terminal report, not inferred.
      expect(events.at(-1)?.type).toBe("status");

      // No credential survived into the durable log.
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(config.model.apiKey.expose());

      // And the machine was reclaimed rather than left running.
      const reclaimed = await waitForReclaim(run.id);
      expect(reclaimed?.sandboxStoppedAt).not.toBeNull();
    },
    10 * 60 * 1000,
  );
});

async function waitForReclaim(runId: string) {
  const deadline = Date.now() + 30_000;
  let current = await getRun(database, runId);
  while (!current?.sandboxStoppedAt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = await getRun(database, runId);
  }
  return current;
}

async function assertControlPlaneReachable(baseUrl: string): Promise<void> {
  const healthUrl = `${baseUrl}/healthz`;
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
