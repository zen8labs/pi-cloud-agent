import { serve } from "@hono/node-server";
import { getConfig } from "./config";
import { db } from "./db/client";
import { createApp } from "./http/app";
import { createLogger } from "./logger";
import { createObservability } from "./observability";
import { createReconciler } from "./reconcile/loop";
import { createCredentialBroker } from "./secrets/broker";

/**
 * One process: the HTTP surface and the reconciler.
 *
 * They share a process because it is simpler, not because they must. Nothing is
 * passed between them in memory — they coordinate entirely through Postgres — so
 * splitting them across machines is a deployment decision that needs no code
 * change. That is the payoff for having no in-process event bus.
 */

const config = getConfig();
const log = createLogger("controller", { level: config.logLevel });
const database = db();
const observability = createObservability({
  config,
  database,
  log: createLogger("observability", { level: config.logLevel }),
});

const app = createApp({ config, database, log, observability });
const reconciler = createReconciler({
  config,
  database,
  broker: createCredentialBroker(
    config,
    database,
    createLogger("secrets", { level: config.logLevel }),
  ),
  log: createLogger("reconciler", { level: config.logLevel }),
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info("controller listening", {
    port: info.port,
    controlPlaneUrl: config.controlPlaneUrl,
    sandbox: config.sandbox.provider,
  });
});

await observability.start();
await reconciler.start();

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    // In-flight runs are unaffected: their sandboxes keep working and keep
    // reporting, and whichever process is running next finishes the bookkeeping.
    void reconciler
      .stop()
      .finally(() => observability.stop())
      .finally(() => server.close(() => process.exit(0)));
  });
}
