import { DEFAULT_PROFILE, listProfiles } from "@pi-cloud-agent/profiles";
import type { BranchesResponse, ConfigResponse, ReposResponse } from "@pi-cloud-agent/protocol";
import { createVcsProvider } from "@pi-cloud-agent/vcs";
import { Hono } from "hono";
import type { Config } from "../config";
import type { AppEnv } from "./deps";

/**
 * What the dashboard needs to render itself: the configured model, the available
 * profiles and their settings schemas, and the repositories it can target.
 *
 * The selector endpoints are best-effort by design. A forge outage should leave
 * the dashboard usable with an empty list, not blank.
 */
export function metaRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/config", (c) => {
    const config = c.get("config");
    const response: ConfigResponse = {
      model: config.model.id,
      profiles: listProfiles().map((profile) => ({
        name: profile.name,
        description: profile.description,
        configJsonSchema: profile.configJsonSchema,
      })),
      defaultProfile: DEFAULT_PROFILE,
    };
    return c.json(response);
  });

  app.get("/repos", async (c) => {
    return c.json(await resolveRepos(c.get("config")));
  });

  app.get("/repos/:owner/:name/branches", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("name")}`;
    const provider = c.req.query("provider") ?? "github";
    const response: BranchesResponse = { branches: [], default: null };
    try {
      const vcs = createVcsProvider(provider, c.get("config").env);
      response.branches = await vcs.listBranches(fullName);
      response.default = await vcs.getDefaultBranch(fullName);
    } catch (error) {
      c.get("log").warn("branch lookup failed", { repo: fullName, error });
    }
    response.default ??= response.branches[0] ?? null;
    return c.json(response);
  });

  return app;
}

/**
 * Prefer the explicit allowlist; fall back to asking the forge what it can see.
 *
 * `source` is returned so the dashboard can explain an empty list instead of
 * looking broken.
 */
async function resolveRepos(config: Config): Promise<ReposResponse> {
  if (config.web.repos.length > 0) return { repos: config.web.repos, source: "config" };
  try {
    const vcs = createVcsProvider("github", config.env);
    const repos = await vcs.listRepos();
    if (repos.length > 0) return { repos, source: "provider" };
  } catch {
    // Fall through: an unconfigured forge is a normal first-run state.
  }
  return { repos: [], source: "none" };
}
