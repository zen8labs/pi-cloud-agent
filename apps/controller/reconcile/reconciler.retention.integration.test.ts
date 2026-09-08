import type { SandboxProvider } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { completeRun } from "../db/runs";
import { getSession, parkSession } from "../db/sessions";
import { createCredentialBroker } from "../secrets/broker";
import { bindTestDatabase, seedSession, silentLogger, testConfig } from "../test-support";
import { fakeProvider } from "./fake-sandbox-provider";
import { createReconciler, type Reconciler } from "./loop";

let database: Database;
bindTestDatabase((value) => {
  database = value;
});

function reconciler(provider: SandboxProvider): Reconciler {
  const config = testConfig({ SANDBOX_PROVIDER: "fake" });
  return createReconciler({
    config,
    database,
    broker: createCredentialBroker(config, database, silentLogger()),
    log: silentLogger(),
    createProvider: () => provider,
  });
}

describe("session retention", () => {
  it("expires an idle checkpoint and marks the session inactive", async () => {
    const { session, run } = await seedSession(database);
    await completeRun(database, run.id, "succeeded");
    await parkSession(
      database,
      run,
      { provider: "fake", id: "checkpoint-expired" },
      new Date(Date.now() - 1_000),
    );
    const provider = fakeProvider();

    await reconciler(provider).tick();

    expect(provider.deleted).toEqual(["checkpoint-expired"]);
    const stored = await getSession(database, session.id);
    expect(stored?.sandboxId).toBeNull();
    expect(stored?.retentionStatus).toBe("inactive");
  });
});
