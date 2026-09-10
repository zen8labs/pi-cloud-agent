import type { BranchesResponse, ReposResponse, VcsRepository } from "@pi-cloud-agent/protocol";
import { vcsProviderNames } from "@pi-cloud-agent/vcs";
import { Hono } from "hono";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { loadReviewRepositories } from "../integrations/review-repositories";
import { getVcsProvider } from "../vcs/connections";
import type { AppEnv } from "./deps";

export function metaRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/repos", async (c) => {
    return c.json(
      await resolveRepos(c.get("database"), c.get("config"), c.get("user")?.id ?? null),
    );
  });

  app.get("/repos/branches", async (c) => {
    const provider = c.req.query("provider") ?? "github";
    const repo = c.req.query("repo") ?? "";
    const response: BranchesResponse = { branches: [], default: null };
    try {
      if (
        !(await repositoryIsSelectable(
          c.get("database"),
          c.get("config"),
          c.get("user")?.id ?? null,
          provider,
          repo,
        ))
      ) {
        return c.json(response);
      }
      const vcs = await getVcsProvider(
        c.get("database"),
        c.get("config"),
        provider,
        c.get("user")?.id ?? null,
      );
      response.branches = await vcs.listBranches(repo);
      response.default = await vcs.getDefaultBranch(repo);
    } catch (error) {
      c.get("log").warn("branch lookup failed", { provider, repo, error });
    }
    return c.json(response);
  });

  return app;
}

async function resolveRepos(
  database: Database,
  config: Config,
  userId: string | null,
): Promise<ReposResponse> {
  const repos: VcsRepository[] = [];
  for (const provider of vcsProviderNames()) {
    try {
      const vcs = await getVcsProvider(database, config, provider, userId);
      const available = await vcs.listRepos();
      if (provider !== "github" || !requiresGithubInstallation(config)) {
        repos.push(...available);
        continue;
      }
      if (!userId) continue;
      const access = await loadReviewRepositories(database, config, userId);
      const allowed = new Set(
        access.repositories.filter((item) => !item.problem).map((item) => item.repo),
      );
      repos.push(...available.filter((repo) => allowed.has(repo.fullName)));
    } catch {
      // A disconnected or expired identity contributes no repositories.
    }
  }
  return {
    repos: repos.sort((left, right) => left.fullName.localeCompare(right.fullName)),
    source: repos.length > 0 ? "connection" : "none",
  };
}

async function repositoryIsSelectable(
  database: Database,
  config: Config,
  userId: string | null,
  provider: string,
  repo: string,
): Promise<boolean> {
  if (provider !== "github" || !requiresGithubInstallation(config)) return true;
  if (!userId) return false;
  const access = await loadReviewRepositories(database, config, userId);
  return access.repositories.some((item) => item.repo === repo && !item.problem);
}

function requiresGithubInstallation(config: Config): boolean {
  return config.auth.requireUser && Boolean(config.github.appId);
}
