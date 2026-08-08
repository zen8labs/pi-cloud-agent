import { SANDBOX_ENV } from "@pi-cloud-agent/protocol";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";
import { run, trimCommandOutput } from "./workspace";

const SETUP_TIMEOUT_MS = 300_000;
const SETUP_ERROR_MAX_CHARS = 20_000;

/** Run the app-managed setup script that prepares a fresh checkout. */
export async function runSetupScript(config: RuntimeConfig, reporter: Reporter): Promise<void> {
  if (!config.appSetupScript) {
    reporter.log("setup.skipped", { reason: "no script" });
    return;
  }

  reporter.log("setup.started", { script: "app environment setting" });
  const result = await run(
    "bash",
    ["-e", "-u", "-o", "pipefail", "-c", config.appSetupScript],
    {
      cwd: config.repo.path,
      env: setupEnvironment(),
      timeoutMs: SETUP_TIMEOUT_MS,
    },
  );
  if (result.code === 0) {
    reporter.log("setup.complete");
    return;
  }
  throwSetupFailure(result, reporter);
}

function throwSetupFailure(
  result: {
    code: number;
    output: string;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  },
  reporter: Reporter,
): never {
  const output = trimCommandOutput(
    result.output.split("\n").slice(-50).join("\n"),
    SETUP_ERROR_MAX_CHARS,
  ).output;
  reporter.log("setup.failed", {
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    output,
  });
  const reason = result.timedOut
    ? `timed out after ${SETUP_TIMEOUT_MS / 1000} seconds`
    : result.signal
      ? `was killed by ${result.signal}`
      : `exited with code ${result.code}`;
  throw new Error(`repository setup ${reason}${output ? `: ${output}` : ""}`);
}

function setupEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    SANDBOX_ENV.callbackToken,
    SANDBOX_ENV.modelApiKey,
    SANDBOX_ENV.modelAuthJson,
    SANDBOX_ENV.mcpConfig,
    SANDBOX_ENV.setupScript,
  ]) {
    delete env[name];
  }
  return env;
}
