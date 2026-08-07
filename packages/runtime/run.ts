import { runAgentSession } from "./agent";
import { createRuntimeRedactor, readConfig } from "./config";
import { createReporter } from "./reporter";
import {
  configureGitCredentials,
  gitDiff,
  gitRevision,
  prepareCheckout,
  runSetupScript,
} from "./workspace";

const clean = createRuntimeRedactor();

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
  let stage = "configuration";

  try {
    stage = "git credentials";
    await configureGitCredentials(config, reporter);
    stage = "repository checkout";
    const workspace = await prepareCheckout(config, reporter);
    if (workspace === "created") {
      stage = "repository setup";
      await runSetupScript(config, reporter);
    }
    const baseSha = config.sessionBaseSha || (await gitRevision(config.repo.path));
    if (baseSha) {
      // Persist the immutable session baseline before the agent can commit,
      // fail, or be cancelled. Later turns must diff from this revision.
      reporter.log("git.diff_base", { baseSha });
      await reporter.flush();
    }
    stage = "agent session";
    await runAgentSession(config, reporter);

    stage = "capturing code changes";
    try {
      reporter.log("git.diff", { ...(await gitDiff(config.repo.path, baseSha)) });
    } catch (error) {
      reporter.log("git.diff_failed", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // Drain telemetry first so the feed is complete before the run closes.
    await reporter.flush();
    await reporter.status({ status: "done" });
  } catch (error) {
    const detail = clean(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
    process.stderr.write(`run failed: ${detail}\n`);
    await reporter.flush().catch(() => undefined);
    await reporter.status({ status: "error", detail });
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  // Reaching here means even reporting failed. Say so on stderr, which the
  // sandbox provider captures, and let the reconciler handle the run.
  process.stderr.write(`runtime could not report its outcome: ${clean(String(error))}\n`);
  process.exitCode = 1;
});
