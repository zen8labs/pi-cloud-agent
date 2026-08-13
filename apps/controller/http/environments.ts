import { randomUUID } from "node:crypto";
import {
  createRedactor,
  type RepositoryEnvironmentSummary,
  redactUrlCredentials,
  SANDBOX_ENV,
  type SandboxProvider,
  Secret,
  updateRepositoryEnvironmentRequestSchema,
} from "@pi-cloud-agent/protocol";
import { type Context, Hono } from "hono";
import {
  deleteRepositoryEnvironment,
  listRepositoryEnvironments,
  saveRepositoryEnvironment,
} from "../db/environments";
import { getVcsProvider } from "../vcs/connections";
import { requireAuthenticatedUser } from "./auth";
import type { AppEnv, Deps } from "./deps";

type EnvironmentContext = Context<AppEnv>;

/** User-owned setup scripts for connected repositories. */
export function environmentRoutes(deps: Pick<Deps, "broker" | "sandbox">): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuthenticatedUser);

  app.get("/", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const environments = await listRepositoryEnvironments(c.get("database"), user.id);
    return c.json({ environments: environments.map(toSummary) });
  });

  app.put("/", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const parsed = updateRepositoryEnvironmentRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 422);

    const setupScript = parsed.data.setupScript.trim();
    if (!setupScript) {
      await deleteRepositoryEnvironment(c.get("database"), {
        userId: user.id,
        provider: parsed.data.provider,
        repoFullName: parsed.data.repo,
      });
      return c.json({ ok: true, configured: false });
    }

    const saved = await saveRepositoryEnvironment(c.get("database"), {
      userId: user.id,
      provider: parsed.data.provider,
      repoFullName: parsed.data.repo,
      setupScript,
    });
    return c.json({ ok: true, configured: true, environment: toSummary(saved) });
  });

  app.post("/test", async (c) => {
    return testEnvironment(c, deps);
  });

  return app;
}

async function testEnvironment(c: EnvironmentContext, deps: Pick<Deps, "broker" | "sandbox">) {
  const user = c.get("user");
  if (!user) return c.json({ error: "authentication required" }, 401);
  const request = await readSetupTestRequest(c);
  if (!request.ok) return c.json(request.body, request.status);
  const execute = deps.sandbox?.execute;
  if (!execute || !deps.broker) {
    return c.json({ error: "sandbox setup tests are not available" }, 503);
  }

  try {
    const result = await executeEnvironmentTest(
      c,
      execute,
      deps.broker,
      user.id,
      request.value,
    );
    return c.json(result);
  } catch (error) {
    if (error instanceof SetupTestInputError) {
      return c.json({ error: error.message }, 422);
    }
    return c.json(
      { error: error instanceof Error ? error.message : "sandbox setup test failed" },
      502,
    );
  }
}

async function readSetupTestRequest(c: EnvironmentContext) {
  const parsed = updateRepositoryEnvironmentRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return {
      ok: false as const,
      status: 422 as const,
      body: { error: "invalid request", issues: parsed.error.issues },
    };
  }
  const setupScript = parsed.data.setupScript.trim();
  if (!setupScript) {
    return {
      ok: false as const,
      status: 422 as const,
      body: { error: "setup script cannot be empty" },
    };
  }
  return { ok: true as const, value: { ...parsed.data, setupScript } };
}

async function executeEnvironmentTest(
  c: EnvironmentContext,
  execute: NonNullable<SandboxProvider["execute"]>,
  broker: NonNullable<Deps["broker"]>,
  userId: string,
  request: { provider: string; repo: string; setupScript: string },
) {
  const vcs = await getVcsProvider(
    c.get("database"),
    c.get("config"),
    request.provider,
    userId,
  );
  const repository = await vcs.getRepository(request.repo);
  if (!repository) throw new SetupTestInputError("repository is not available");

  const credentials = await broker.mintForRepository({
    userId,
    provider: request.provider,
    repoFullName: request.repo,
  });
  const result = await execute({
    runId: `environment-test-${randomUUID()}`,
    image: "",
    timeoutSeconds: Math.max(300, Math.min(c.get("config").sandbox.timeoutSeconds, 600)),
    env: { ...credentials.env, [SANDBOX_ENV.repoCloneUrl]: repository.cloneUrl },
    secrets: {
      ...credentials.secrets,
      [SANDBOX_ENV.setupScript]: new Secret(request.setupScript, "repository setup script"),
    },
    command: repositorySetupTestCommand(),
  });
  const redactor = createRedactor(Object.values(credentials.secrets));
  const output = redactUrlCredentials(
    redactor([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")),
  ).slice(-20_000);
  return { ok: result.code === 0, code: result.code, output };
}

class SetupTestInputError extends Error {}

const SETUP_TEST_TIMEOUT_SECONDS = 300;

function repositorySetupTestCommand(): string {
  return [
    "set -eu",
    "unset BASH_ENV ENV NODE_ENV",
    "rm -rf /workspace/repository-environment-test",
    "mkdir -p /workspace/repository-environment-test",
    `if [ -n "\${SCM_TOKEN:-}" ]; then`,
    '  git -c \'credential.helper=!f() { printf "username=%s\\npassword=%s\\n" "$SCM_TOKEN_USERNAME" "$SCM_TOKEN"; }; f\' clone --depth 1 "$REPO_CLONE_URL" /workspace/repository-environment-test',
    "else",
    '  git clone --depth 1 "$REPO_CLONE_URL" /workspace/repository-environment-test',
    "fi",
    "cd /workspace/repository-environment-test",
    'setup_script="$REPO_SETUP_SCRIPT"',
    "unset REPO_SETUP_SCRIPT",
    `timeout --signal=KILL ${SETUP_TEST_TIMEOUT_SECONDS}s bash --noprofile --norc -e -u -o pipefail -c "$setup_script"`,
  ].join("\n");
}

function toSummary(row: {
  provider: string;
  repoFullName: string;
  setupScript: string;
  updatedAt: Date;
}): RepositoryEnvironmentSummary {
  return {
    provider: row.provider,
    repo: row.repoFullName,
    setupScript: row.setupScript,
    updatedAt: row.updatedAt.toISOString(),
  };
}
