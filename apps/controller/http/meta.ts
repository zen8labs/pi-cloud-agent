import { DEFAULT_PROFILE, listProfiles } from "@pi-cloud-agent/profiles";
import type {
  BranchesResponse,
  ConfigResponse,
  ReposResponse,
  VcsRepository,
} from "@pi-cloud-agent/protocol";
import { vcsProviderNames } from "@pi-cloud-agent/vcs";
import { Hono } from "hono";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { getVcsProvider } from "../vcs/connections";
import type { AppEnv } from "./deps";

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
    return c.json(
      await resolveRepos(c.get("database"), c.get("config"), c.get("user")?.id ?? null),
    );
  });

  app.get("/repos/branches", async (c) => {
    const provider = c.req.query("provider") ?? "github";
    const repo = c.req.query("repo") ?? "";
    const response: BranchesResponse = { branches: [], default: null };
    try {
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
      repos.push(...(await vcs.listRepos()));
    } catch {
      // A disconnected or expired identity contributes no repositories.
    }
  }
  return {
    repos: repos.sort((left, right) => left.fullName.localeCompare(right.fullName)),
    source: repos.length > 0 ? "connection" : "none",
  };
}
