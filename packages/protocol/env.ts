/**
 * The environment contract between the controller and the sandbox.
 *
 * The controller writes these; the runtime reads them. Both sides import this
 * object, so a rename is a type error instead of a run that boots with an empty
 * prompt. Provider-specific credential variables (GH_TOKEN, …)
 * are not listed here — those are shaped by the credential broker for whichever
 * CLI the agent will use, and only the broker and the CLI need to agree.
 */
export const SANDBOX_ENV = {
  controlPlaneUrl: "CONTROL_PLANE_URL",
  runId: "RUN_ID",
  callbackToken: "RUN_CALLBACK_TOKEN",

  sessionId: "SESSION_ID",
  workspaceResumed: "WORKSPACE_RESUMED",
  debugEvents: "AGENT_DEBUG_EVENTS",

  taskPrompt: "TASK_PROMPT",
  /** Optional app-managed setup script for a fresh repository checkout. */
  setupScript: "REPO_SETUP_SCRIPT",

  /**
   * Optional JSON snapshot of resolved MCP server config for `createMcpAdapter`.
   * Absent or empty means zero MCP tools. Values may contain secrets; treat as
   * redacted material (never log or persist in run_events).
   */
  mcpConfig: "MCP_CONFIG",

  model: "LLM_MODEL",
  modelApi: "LLM_API",
  modelBaseUrl: "LLM_BASE_URL",
  modelApiKey: "LLM_API_KEY",
  modelAuthType: "LLM_AUTH_TYPE",
  modelAuthJson: "LLM_AUTH_JSON",
  modelContextWindow: "LLM_CONTEXT_WINDOW",
  modelMaxTokens: "LLM_MAX_TOKENS",
  modelThinkingLevel: "LLM_THINKING_LEVEL",

  repoProvider: "REPO_PROVIDER",
  repoHost: "REPO_HOST",
  repoOwner: "REPO_OWNER",
  repoName: "REPO_NAME",
  repoCloneUrl: "REPO_CLONE_URL",
  repoDefaultBranch: "REPO_DEFAULT_BRANCH",
  repoBaseSha: "REPO_BASE_SHA",
  repoHeadSha: "REPO_HEAD_SHA",
  repoHeadBranch: "REPO_HEAD_BRANCH",
  /** Original session revision used for the cumulative Changes sidebar. */
  sessionBaseSha: "SESSION_BASE_SHA",

  /** Git credentials, consumed by the checkout's credential helper. */
  scmToken: "SCM_TOKEN",
  scmTokenUsername: "SCM_TOKEN_USERNAME",
} as const;

export type SandboxEnvKey = keyof typeof SANDBOX_ENV;

/** Where the sandbox image puts things. Fixed by the image, not configurable. */
export const SANDBOX_PATHS = {
  workspace: "/workspace",
  state: "/workspace/.pi-cloud-agent",
  app: "/app",
} as const;
