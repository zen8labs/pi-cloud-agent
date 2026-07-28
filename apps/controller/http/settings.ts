import { getProfile } from "@pi-cloud-agent/profiles";
import type { RepoConfigResponse } from "@pi-cloud-agent/protocol";
import { repoConfigRequestSchema } from "@pi-cloud-agent/protocol";
import { Hono } from "hono";
import { listRepoConfig, setRepoConfig } from "../db/repo-config";
import type { AppEnv } from "./deps";
import { resolveRepos } from "./meta";

/**
 * Per-repository, per-profile settings.
 *
 * Two endpoints for every profile that will ever exist, because the controller
 * stores this configuration without understanding it. Validation is delegated to
 * the owning profile's schema, so a profile can add a setting without a migration
 * and without a route change — and cannot smuggle an unvalidated field past the
 * boundary either.
 */
export function settingsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/repo-config", async (c) => {
    const rows = await listRepoConfig(c.get("database"));
    const { repos, source } = await resolveRepos(c.get("config"));
    const response: RepoConfigResponse = {
      entries: rows.map((row) => ({
        repo: row.repoFullName,
        provider: row.provider,
        profile: row.profile,
        config: row.config,
      })),
      // Include repositories that only exist as a saved override, so a setting
      // never silently disappears when the live repo list is briefly empty.
      repos: [...new Set([...repos, ...rows.map((row) => row.repoFullName)])].sort(),
      source,
    };
    return c.json(response);
  });

  app.put("/repo-config", async (c) => {
    const parsed = repoConfigRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 422);
    }
    const { repo, provider, profile: profileName, config } = parsed.data;

    let normalized: unknown;
    try {
      // The profile is the only thing that knows what its settings mean, so it is
      // the only thing that validates them. Storing the parsed result also applies
      // the profile's defaults, which keeps stored rows self-describing.
      normalized = getProfile(profileName).parseConfig(config);
    } catch (error) {
      return c.json(
        { error: `invalid config for "${profileName}"`, detail: String(error) },
        422,
      );
    }

    await setRepoConfig(
      c.get("database"),
      { provider, repoFullName: repo, profile: profileName },
      normalized as Record<string, unknown>,
    );
    return c.json({ repo, provider, profile: profileName, config: normalized });
  });

  return app;
}
