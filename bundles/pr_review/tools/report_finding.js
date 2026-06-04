/**
 * report_finding — OpenCode custom tool for the pr_review bundle.
 *
 * Modeled on the reference's inspect-plugin.js (create-pull-request.js): a
 * `tool()` from @opencode-ai/plugin with a Zod arg shape, loaded by OpenCode by
 * staging this file into `.opencode/tool/` at boot (the supervisor does this,
 * mirroring the reference `_install_tools`). It is NOT a launched MCP server.
 *
 * The agent calls `report_finding` once per grounded review finding; `execute()`
 * POSTs the structured finding straight to the controller's internal API using
 * the per-run bearer token:
 *
 *   POST ${CONTROL_PLANE_URL}/internal/runs/${RUN_ID}/findings
 *     Authorization: Bearer ${SANDBOX_AUTH_TOKEN}
 *     body: { file, line, severity, title, body, evidence }
 *
 * Env (CONTROL_PLANE_URL, RUN_ID, SANDBOX_AUTH_TOKEN) is read at runtime so the
 * controller-injected per-run values are picked up. ESM module.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

console.log("[report_finding] tool module loaded");
console.log(
  "[report_finding] CONTROL_PLANE_URL:",
  process.env.CONTROL_PLANE_URL || "<not set>"
);
console.log(
  "[report_finding] RUN_ID:",
  process.env.RUN_ID || "<not set>"
);
console.log(
  "[report_finding] SANDBOX_AUTH_TOKEN:",
  process.env.SANDBOX_AUTH_TOKEN ? "<set>" : "<not set>"
);

// Use tool() helper — args is a ZodRawShape (plain object), NOT a ZodObject;
// OpenCode wraps it with z.object() internally (same pattern as inspect-plugin.js).
export default tool({
  name: "report_finding",
  description:
    "Report ONE grounded code-review finding INTRODUCED by this PR. Call this " +
    "exactly once per verified finding. Evidence (a concrete read range you " +
    "quoted, or actual command/linter/test output you ran) is REQUIRED — never " +
    "report a speculative or unverifiable finding. Nothing you write in chat is " +
    "published; only report_finding calls are.",
  args: {
    file: z
      .string()
      .describe("Repo-relative path to the file the finding is about."),
    line: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        "1-based line number in the PR head revision, or null/omitted for a file-level finding. Never guess — read the file first."
      ),
    severity: z
      .enum(["blocker", "warning", "nit"])
      .describe(
        "blocker = must fix before merge; warning = should fix; nit = minor/style."
      ),
    title: z.string().describe("Short, specific one-line summary of the issue."),
    body: z
      .string()
      .describe("Explanation of the problem and a concrete suggested fix."),
    evidence: z
      .string()
      .describe(
        "Concrete grounding: the read range you quoted (e.g. 'src/x.py:120-138' + the lines) or the command/linter/test output you captured."
      ),
  },
  async execute(args) {
    const base = (process.env.CONTROL_PLANE_URL || "").replace(/\/+$/, "");
    const runId = process.env.RUN_ID || "";
    const token = process.env.SANDBOX_AUTH_TOKEN || "";

    if (!base || !runId || !token) {
      return "report_finding failed: missing CONTROL_PLANE_URL, RUN_ID, or SANDBOX_AUTH_TOKEN in the environment.";
    }

    const body = {
      file: args.file,
      line: args.line ?? null,
      severity: args.severity,
      title: args.title,
      body: args.body,
      evidence: args.evidence,
    };

    const url = `${base}/internal/runs/${runId}/findings`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        console.log(
          `[report_finding] ERROR: HTTP ${response.status} - ${text}`
        );
        return `report_finding failed: HTTP ${response.status} - ${text}`;
      }

      console.log(
        `[report_finding] recorded ${args.severity} finding for ${args.file}`
      );
      return `Recorded ${args.severity} finding for ${args.file}${
        args.line != null ? `:${args.line}` : ""
      }.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[report_finding] ERROR: ${message}`);
      return `report_finding failed: ${message}`;
    }
  },
});
