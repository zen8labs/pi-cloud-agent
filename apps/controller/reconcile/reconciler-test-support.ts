import type { SandboxProvider } from "@pi-cloud-agent/protocol";
import type { Database } from "../db/client";
import {
  bindTestDatabase,
  silentLogger,
  testConfig,
  testCredentialBroker,
} from "../test-support";
import { createReconciler, type Reconciler } from "./loop";

export let database: Database;
bindTestDatabase((value) => {
  database = value;
});

export function reconciler(
  provider: SandboxProvider,
  options: { silenceTimeoutSeconds?: number; claimLeaseSeconds?: number } = {},
): Reconciler {
  return createReconciler({
    config: testConfig({ SANDBOX_PROVIDER: "fake" }),
    database,
    broker: testCredentialBroker,
    log: silentLogger(),
    createProvider: () => provider,
    ...options,
  });
}

export async function tick(loop: Reconciler): Promise<void> {
  await loop.tick();
  await loop.drain();
}
