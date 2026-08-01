/**
 * The environment contract between the controller and the sandbox.
 *
 * The controller writes these; the runtime reads them. Both sides import this
 * object, so a rename is a type error instead of a run that boots with an empty
 * prompt. Provider-specific credential variables (GH_TOKEN, GITLAB_TOKEN, …)
 * are not listed here — those are shaped by the credential broker for whichever
 * CLI the agent will use, and only the broker and the CLI need to agree.
 */
export const SANDBOX_ENV = {
  controlPlaneUrl: "CONTROL_PLANE_URL",
  runId: "RUN_ID",
  callbackToken: "RUN_CALLBACK_TOKEN",

  sessionId: "SESSION_ID",
  workspaceResumed: "WORKSPACE_RESUMED",

  profile: "PROFILE",
  taskPrompt: "TASK_PROMPT",

  model: "AGENT_MODEL",
  modelBaseUrl: "MODEL_BASE_URL",
  modelApiKey: "MODEL_API_KEY",
  modelContextWindow: "MODEL_CONTEXT_WINDOW",
  modelMaxTokens: "MODEL_MAX_TOKENS",

  repoProvider: "REPO_PROVIDER",
  repoHost: "REPO_HOST",
  repoOwner: "REPO_OWNER",
  repoName: "REPO_NAME",
  repoCloneUrl: "REPO_CLONE_URL",
  repoDefaultBranch: "REPO_DEFAULT_BRANCH",
  repoBaseSha: "REPO_BASE_SHA",
  repoHeadSha: "REPO_HEAD_SHA",
  repoHeadBranch: "REPO_HEAD_BRANCH",

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
  /** Optional repo-provided hook, run after clone. */
  setupScript: ".pi-cloud-agent/setup.sh",
} as const;
