import {
  type RepositoryEnvironmentSummary,
  updateRepositoryEnvironmentRequestSchema,
} from "@pi-cloud-agent/protocol";
import { Hono } from "hono";
import {
  deleteRepositoryEnvironment,
  listRepositoryEnvironments,
  saveRepositoryEnvironment,
} from "../db/environments";
import { requireAuthenticatedUser } from "./auth";
import type { AppEnv } from "./deps";

/** User-owned setup scripts for connected repositories. */
export function environmentRoutes(): Hono<AppEnv> {
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

  return app;
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
