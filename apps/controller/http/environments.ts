import { randomUUID } from "node:crypto";
import {
  type RepositoryEnvironmentSummary,
  SANDBOX_PATHS,
  updateRepositoryEnvironmentRequestSchema,
} from "@pi-cloud-agent/protocol";
import { type Context, Hono } from "hono";
import {
  deleteRepositorySandboxImage,
  listRepositorySandboxImages,
  saveRepositorySandboxImage,
} from "../db/environments";
import { requireAuthenticatedUser } from "./auth";
import type { AppEnv, Deps } from "./deps";

type EnvironmentContext = Context<AppEnv>;

/** User-owned base image/template mappings for connected repositories. */
export function environmentRoutes(deps: Pick<Deps, "sandbox">): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuthenticatedUser);

  app.get("/", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const images = await listRepositorySandboxImages(c.get("database"), user.id);
    return c.json({ environments: images.map(toSummary) });
  });

  app.put("/", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const request = await readImageRequest(c);
    if (!request) return c.json({ error: "invalid request" }, 422);

    const imageRef = request.imageRef.trim();
    if (!imageRef) {
      await deleteRepositorySandboxImage(c.get("database"), {
        userId: user.id,
        provider: request.provider,
        repoFullName: request.repo,
      });
      return c.json({ ok: true, configured: false });
    }

    const saved = await saveRepositorySandboxImage(c.get("database"), {
      userId: user.id,
      provider: request.provider,
      repoFullName: request.repo,
      imageRef,
    });
    return c.json({ ok: true, configured: true, environment: toSummary(saved) });
  });

  app.post("/test", async (c) => testEnvironment(c, deps));
  return app;
}

async function testEnvironment(c: EnvironmentContext, deps: Pick<Deps, "sandbox">) {
  const user = c.get("user");
  if (!user) return c.json({ error: "authentication required" }, 401);
  const request = await readImageRequest(c);
  if (!request) return c.json({ error: "invalid request" }, 422);
  const imageRef = request.imageRef.trim();
  if (!imageRef) return c.json({ error: "image reference cannot be empty" }, 422);
  const execute = deps.sandbox?.execute;
  if (!execute) return c.json({ error: "sandbox image tests are not available" }, 503);

  try {
    const result = await execute({
      runId: `environment-test-${randomUUID()}`,
      image: imageRef,
      timeoutSeconds: Math.max(30, Math.min(c.get("config").sandbox.timeoutSeconds, 120)),
      env: {},
      secrets: {},
      command: imageCompatibilityTestCommand(),
    });
    const output = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n")
      .slice(-20_000);
    return c.json({ ok: result.code === 0, code: result.code, output });
  } catch (error) {
    c.get("log").warn("repository image preflight failed", {
      provider: request.provider,
      repo: request.repo,
      imageRef,
      error,
    });
    return c.json({ error: "could not test repository image" }, 502);
  }
}

async function readImageRequest(c: EnvironmentContext) {
  const parsed = updateRepositoryEnvironmentRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  return parsed.success ? parsed.data : null;
}

function imageCompatibilityTestCommand(): string {
  return [
    "set -eu",
    `test -r ${SANDBOX_PATHS.app}/run.js`,
    `test -r ${SANDBOX_PATHS.app}/package.json`,
    "test -d /workspace",
    "test -w /workspace",
    "command -v git",
    "command -v gh",
    `cd ${SANDBOX_PATHS.app}`,
    "./bin/node --import tsx -e \"await import('@earendil-works/pi-coding-agent'); process.stdout.write('runtime-loader-ok\\n')\"",
    "./bin/node --version",
    "git --version",
    "gh --version | head -n 1",
  ].join("\n");
}

function toSummary(row: {
  provider: string;
  repoFullName: string;
  imageRef: string;
  updatedAt: Date;
}): RepositoryEnvironmentSummary {
  return {
    provider: row.provider,
    repo: row.repoFullName,
    imageRef: row.imageRef,
    updatedAt: row.updatedAt.toISOString(),
  };
}
