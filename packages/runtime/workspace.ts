import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { redactUrlCredentials, SANDBOX_ENV, SANDBOX_PATHS } from "@pi-cloud-agent/protocol";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";

/** Prepare the checkout the agent will work in. */

const CLONE_DEPTH = 100;
const SETUP_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 1_000_000;

interface CommandResult {
  code: number;
  output: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env });
    let output = "";
    let timedOut = false;
    let settled = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (error) => {
      collect(Buffer.from(`\n${error.message}`));
      finish({
        code: 1,
        output: redactUrlCredentials(output).trim(),
        signal: null,
        timedOut,
      });
    });
    child.on("close", (code, signal) =>
      finish({
        // A process closed by a signal has no exit code. It did not succeed.
        code: code ?? (timedOut ? 124 : 1),
        output: redactUrlCredentials(output).trim(),
        signal,
        timedOut,
      }),
    );
  });
}

/**
 * Teach git the injected token without ever writing it to disk.
 *
 * The helper prints the credential from the environment on demand, so the token
 * lives only in this process's environment rather than in `.git/config` or a
 * `.git-credentials` file that the agent could later read or commit.
 */
export async function configureGitCredentials(
  config: RuntimeConfig,
  reporter: Reporter,
): Promise<void> {
  if (!config.git.hasToken) {
    reporter.log("git.no_token", { detail: "proceeding without git authentication" });
    return;
  }

  const helper =
    `!f() { printf 'username=%s\\npassword=%s\\n' ` +
    `"$\{${SANDBOX_ENV.scmTokenUsername}:-${config.git.username}}" "$${SANDBOX_ENV.scmToken}"; }; f`;

  for (const [key, value] of [
    ["credential.helper", helper],
    // Without this, git scopes credentials per path and re-asks on redirect.
    ["credential.useHttpPath", "false"],
  ] as const) {
    const result = await run("git", ["config", "--global", "--replace-all", key, value]);
    if (result.code !== 0) {
      reporter.log("git.config_failed", { key, output: result.output });
    }
  }
}

/**
 * Clone, then move to the exact revision the trigger named.
 *
 * Branches are tried head-first, then the default, then a plain clone: a webhook
 * can name a branch that has already been deleted by the time the run starts, and
 * failing the whole run for that would be needlessly brittle. A named head SHA,
 * on the other hand, is not optional — a review of the wrong commit is worse than
 * no review.
 */
export async function prepareCheckout(
  config: RuntimeConfig,
  reporter: Reporter,
): Promise<void> {
  const { repo } = config;
  const candidates = [...new Set([repo.headBranch, repo.defaultBranch].filter(Boolean))];

  let cloned = false;
  let lastOutput = "";
  for (const branch of candidates) {
    const result = await run("git", [
      "clone",
      "--depth",
      String(CLONE_DEPTH),
      "--branch",
      branch,
      repo.cloneUrl,
      repo.path,
    ]);
    if (result.code === 0) {
      reporter.log("git.cloned", { branch });
      cloned = true;
      break;
    }
    lastOutput = result.output;
    reporter.log("git.clone_branch_failed", { branch, output: lastOutput });
  }

  if (!cloned) {
    const result = await run("git", [
      "clone",
      "--depth",
      String(CLONE_DEPTH),
      repo.cloneUrl,
      repo.path,
    ]);
    if (result.code !== 0) {
      throw new Error(`clone failed: ${result.output || lastOutput || "git exited non-zero"}`);
    }
    reporter.log("git.cloned", { branch: "(default)" });
  }

  if (repo.headSha) {
    await run("git", ["fetch", "--depth", String(CLONE_DEPTH), "origin", repo.headSha], {
      cwd: repo.path,
    });
    const checkout = await run("git", ["reset", "--hard", repo.headSha], { cwd: repo.path });
    if (checkout.code !== 0) {
      throw new Error(`could not check out ${repo.headSha}: ${checkout.output}`);
    }
  }

  if (repo.baseSha) {
    // Fetched but not checked out: the agent needs it to diff against the merge
    // base, and a shallow clone would not otherwise have it.
    await run("git", ["fetch", "--depth", String(CLONE_DEPTH), "origin", repo.baseSha], {
      cwd: repo.path,
    });
  }

  reporter.log("git.checkout_ready", { path: repo.path, headSha: repo.headSha || null });
}

/**
 * Run the repository's own setup hook, if it has one.
 *
 * Failure and timeout are both non-fatal. This is repository-provided code that
 * usually installs dependencies; the agent can still read and reason about a
 * checkout whose `npm install` failed, and refusing to start would be a worse
 * outcome than starting without it.
 */
export async function runSetupScript(config: RuntimeConfig, reporter: Reporter): Promise<void> {
  const script = join(config.repo.path, SANDBOX_PATHS.setupScript);
  if (!existsSync(script)) {
    reporter.log("setup.skipped", { reason: "no script" });
    return;
  }

  const result = await run("bash", [script], {
    cwd: config.repo.path,
    timeoutMs: SETUP_TIMEOUT_MS,
  });

  if (result.code === 0) {
    reporter.log("setup.complete");
    return;
  }
  reporter.log("setup.failed", {
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    output: result.output.split("\n").slice(-50).join("\n"),
  });
}
