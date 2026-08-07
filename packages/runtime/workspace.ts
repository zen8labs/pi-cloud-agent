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
  outputTruncated: boolean;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

type OutputPosition = "head" | "tail";

export function trimCommandOutput(
  output: string,
  maxOutputChars: number,
  position: OutputPosition = "tail",
): { output: string; truncated: boolean } {
  if (output.length <= maxOutputChars) return { output, truncated: false };
  return {
    output:
      position === "head" ? output.slice(0, maxOutputChars) : output.slice(-maxOutputChars),
    truncated: true,
  };
}

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    maxOutputChars?: number;
    outputPosition?: OutputPosition;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env });
    let output = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const collect = (chunk: Buffer) => {
      const maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
      const trimmed = trimCommandOutput(
        output + chunk.toString(),
        maxOutputChars,
        options.outputPosition,
      );
      output = trimmed.output;
      outputTruncated ||= trimmed.truncated;
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
        outputTruncated,
        signal: null,
        timedOut,
      });
    });
    child.on("close", (code, signal) =>
      finish({
        // A process closed by a signal has no exit code. It did not succeed.
        code: code ?? (timedOut ? 124 : 1),
        output: redactUrlCredentials(output).trim(),
        outputTruncated,
        signal,
        timedOut,
      }),
    );
  });
}

const DIFF_MAX_OUTPUT_CHARS = 2_000_000;

/** Capture the revision at the start of a turn so committed edits are visible. */
export async function gitRevision(path: string): Promise<string | null> {
  const result = await run("git", ["rev-parse", "HEAD"], { cwd: path, timeoutMs: 30_000 });
  if (result.code !== 0 || !result.output) {
    // A freshly initialized repository has no HEAD until its first commit.
    // The diff baseline is optional, so let the agent create that first commit.
    return null;
  }
  return result.output.trim();
}

export interface GitDiffSnapshot {
  patch: string;
  baseSha: string | null;
  headSha: string | null;
  files: number;
  added: number;
  removed: number;
  truncated: boolean;
}

/**
 * Capture tracked, staged, committed-during-turn, deleted, renamed, and
 * untracked changes without modifying the checkout.
 */
export async function gitDiff(path: string, baseSha: string | null): Promise<GitDiffSnapshot> {
  const headSha = await gitRevision(path);
  const tracked = baseSha
    ? await run("git", ["diff", "--no-ext-diff", "--binary", "--find-renames", baseSha, "--"], {
        cwd: path,
        timeoutMs: 60_000,
        maxOutputChars: DIFF_MAX_OUTPUT_CHARS,
        outputPosition: "head",
      })
    : null;
  if (tracked && tracked.code !== 0)
    throw new Error(`could not capture the checkout diff: ${tracked.output}`);

  const untracked = await run(
    "git",
    baseSha
      ? ["ls-files", "--others", "--exclude-standard", "-z"]
      : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: path,
      timeoutMs: 30_000,
      maxOutputChars: 200_000,
      outputPosition: "head",
    },
  );
  if (untracked.code !== 0)
    throw new Error(`could not list untracked files: ${untracked.output}`);

  const chunks = tracked ? [tracked.output] : [];
  let sourceTruncated = Boolean(tracked?.outputTruncated || untracked.outputTruncated);
  for (const file of untracked.output.split("\0").filter(Boolean)) {
    const fileDiff = await run(
      "git",
      ["diff", "--no-index", "--no-ext-diff", "--binary", "--", "/dev/null", file],
      {
        cwd: path,
        timeoutMs: 60_000,
        maxOutputChars: DIFF_MAX_OUTPUT_CHARS,
        outputPosition: "head",
      },
    );
    // `git diff --no-index` returns 1 when files differ, which is the success
    // case here. Any other non-zero result is a genuine capture failure.
    if (fileDiff.code > 1) throw new Error(`could not capture ${file}: ${fileDiff.output}`);
    chunks.push(fileDiff.output);
    sourceTruncated ||= fileDiff.outputTruncated;
  }

  const limited = limitDiff(chunks.filter(Boolean).join("\n"), sourceTruncated);
  return {
    patch: limited.patch,
    baseSha,
    headSha,
    files: countDiffFiles(limited.patch),
    added: countDiffLines(limited.patch, "+"),
    removed: countDiffLines(limited.patch, "-"),
    truncated: limited.truncated,
  };
}

function limitDiff(
  patch: string,
  sourceTruncated = false,
): { patch: string; truncated: boolean } {
  if (!sourceTruncated && patch.length <= DIFF_MAX_OUTPUT_CHARS)
    return { patch, truncated: false };
  const chunks = patch
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "));
  let output = "";
  for (const chunk of chunks) {
    if (output.length === 0 && chunk.length > DIFF_MAX_OUTPUT_CHARS) {
      output = chunk.slice(0, DIFF_MAX_OUTPUT_CHARS);
      break;
    }
    if (output.length + chunk.length > DIFF_MAX_OUTPUT_CHARS) break;
    output += chunk;
  }
  if (!output && !chunks.length) output = patch.slice(0, DIFF_MAX_OUTPUT_CHARS);
  return {
    patch: `${output.trimEnd()}\n\n[diff truncated by the runtime]\n`,
    truncated: true,
  };
}

function countDiffFiles(patch: string): number {
  return patch.split("\ndiff --git ").length - (patch.startsWith("diff --git ") ? 0 : 1);
}

function countDiffLines(patch: string, prefix: "+" | "-"): number {
  return patch
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}`)).length;
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
 * Branches are tried head-first, then the default, then a plain clone: a trigger
 * can name a branch that has already been deleted by the time the run starts, and
 * failing the whole run for that would be needlessly brittle. A named head SHA,
 * on the other hand, is not optional — running against the wrong commit is worse
 * than not running.
 */
export async function prepareCheckout(
  config: RuntimeConfig,
  reporter: Reporter,
): Promise<"created" | "resumed"> {
  const { repo } = config;
  if (await reuseCheckout(repo.path, reporter)) return "resumed";
  if (config.workspaceResumed) {
    throw new Error("the provider resumed a workspace without the repository checkout");
  }
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

  await fetchDiffRevisions(config);

  reporter.log("git.checkout_ready", { path: repo.path, headSha: repo.headSha || null });
  return "created";
}

async function fetchDiffRevisions(config: RuntimeConfig): Promise<void> {
  const revisions = [config.repo.baseSha, config.sessionBaseSha].filter(
    (revision, index, all): revision is string =>
      Boolean(revision) && all.indexOf(revision) === index,
  );
  for (const revision of revisions) {
    // Fetched but not checked out: a shallow clone would not otherwise have the
    // revision needed for a cumulative diff.
    await run("git", ["fetch", "--depth", String(CLONE_DEPTH), "origin", revision], {
      cwd: config.repo.path,
    });
  }
}

async function reuseCheckout(path: string, reporter: Reporter): Promise<boolean> {
  if (!existsSync(join(path, ".git"))) return false;
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: path });
  if (origin.code !== 0) throw new Error(`could not verify resumed checkout: ${origin.output}`);
  reporter.log("git.workspace_resumed", { path });
  return true;
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
