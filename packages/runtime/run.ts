import { runAgentSession } from "./agent";
import { readConfig } from "./config";
import { createReporter } from "./reporter";
import { configureGitCredentials, prepareCheckout, runSetupScript } from "./workspace";

/**
 * The sandbox entry point.
 *
 * Four steps, one outcome. Whatever happens, this process reports exactly one
 * terminal status — that report is the only thing that completes a run, so the
 * error path matters as much as the happy one. If it cannot be delivered at all,
 * exiting non-zero leaves the controller's reconciler to notice the silence and
 * time the run out, which is the correct fallback rather than a run stuck live.
 *
 * This is the untrusted side of the system: it executes repository code. It holds
 * no database connection, no VCS client, and no credential broker — only the
 * scoped credentials for this one run, and one URL to report back to.
 */
async function main(): Promise<void> {
  const config = readConfig();
  const reporter = createReporter(config);

  try {
    await configureGitCredentials(config, reporter);
    await prepareCheckout(config, reporter);
    await runSetupScript(config, reporter);
    await runAgentSession(config, reporter);

    // Drain telemetry first so the feed is complete before the run closes.
    await reporter.flush();
    await reporter.status({ status: "done" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`run failed: ${detail}\n`);
    await reporter.flush().catch(() => undefined);
    await reporter.status({ status: "error", detail });
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  // Reaching here means even reporting failed. Say so on stderr, which the
  // sandbox provider captures, and let the reconciler handle the run.
  process.stderr.write(`runtime could not report its outcome: ${String(error)}\n`);
  process.exitCode = 1;
});
