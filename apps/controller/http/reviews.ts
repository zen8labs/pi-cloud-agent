import {
  type PullRequestReviewsResponse,
  reviewRepositoryRequestSchema,
} from "@pi-cloud-agent/protocol";
import { githubAppInstallUrl } from "@pi-cloud-agent/vcs";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { claimReviewInstallation, reviewEvidence, saveReviewPolicy } from "../db/reviews";
import {
  loadReviewRepositories,
  requireReviewRepository,
  reviewConfigurationProblem,
} from "../integrations/review-repositories";
import { summarizeReview } from "../integrations/review-status";
import { LlmModelSelectionError, resolveDefaultLlmModel } from "../llm/connections";
import { requireAuthenticatedUser } from "./auth";
import type { AppEnv, Deps } from "./deps";

export function reviewRoutes(deps: Pick<Deps, "createGithubReviewReader"> = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuthenticatedUser);
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof LlmModelSelectionError) return c.json({ error: error.message }, 422);
    c.get("log").warn("review dashboard request failed", { path: c.req.path, error });
    return c.json({ error: "Could not read GitHub review data. Refresh to retry." }, 502);
  });
  const load = (c: Context<AppEnv>) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "authentication required" });
    return loadReviewRepositories(
      c.get("database"),
      c.get("config"),
      user.id,
      deps.createGithubReviewReader,
    );
  };

  app.get("/repositories", async (c) => {
    const { reader: _reader, ...result } = await load(c);
    const config = c.get("config");
    const configurationProblem = reviewConfigurationProblem(config);
    if (configurationProblem) result.problem = configurationProblem;
    if (config.github.appId && config.github.privateKey) {
      try {
        result.installUrl = await githubAppInstallUrl({
          appId: config.github.appId,
          privateKey: config.github.privateKey,
        });
      } catch {
        result.problem ??= "Could not load the GitHub App installation link. Refresh to retry.";
      }
    }
    return c.json(result);
  });

  app.put("/repositories", async (c) => {
    const parsed = reviewRepositoryRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "invalid repository setting" }, 422);
    const { repositories, reader } = await load(c);
    const { installationId, repo, autoReview } = parsed.data;
    const target = requireReviewRepository(repositories, installationId, repo);
    if (autoReview) {
      const problem = target.problem ?? reviewConfigurationProblem(c.get("config"));
      if (problem) return c.json({ error: problem }, 422);
      const user = c.get("user");
      if (!user) return c.json({ error: "authentication required" }, 401);
      await resolveDefaultLlmModel(c.get("database"), c.get("config"), user.id);
    }
    await claimInstallation(c, reader, installationId);
    await saveReviewPolicy(c.get("database"), installationId, repo, autoReview);
    return c.json({ ok: true });
  });

  app.get("/", async (c) => {
    const { repositories, reader, problem } = await load(c);
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const response: PullRequestReviewsResponse = {
      pullRequests: [],
      problems: problem ? [problem] : [],
      fetchedAt: new Date().toISOString(),
    };
    const configurationProblem = reviewConfigurationProblem(c.get("config"));
    if (configurationProblem) response.problems.push(configurationProblem);
    if (!reader) return c.json(response);
    // Bound concurrency avoids a request burst against GitHub on larger installations.
    for (let offset = 0; offset < repositories.length; offset += 5) {
      await Promise.all(
        repositories.slice(offset, offset + 5).map(async (repo) => {
          try {
            const [pulls, evidence] = await Promise.all([
              reader.openPulls(repo.repo),
              reviewEvidence(c.get("database"), user.id, repo.repo, repo.installationId),
            ]);
            response.pullRequests.push(
              ...pulls.map((pull) => summarizeReview(repo, pull, evidence)),
            );
          } catch {
            response.problems.push(
              `${repo.repo}: could not refresh open PRs. Refresh to retry.`,
            );
          }
        }),
      );
    }
    response.pullRequests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    response.fetchedAt = new Date().toISOString();
    return c.json(response);
  });
  return app;
}

async function claimInstallation(
  c: Context<AppEnv>,
  reader: import("@pi-cloud-agent/vcs").GithubReviewReader | null,
  installationId: string,
) {
  const user = c.get("user");
  const installation = (await reader?.installations())?.find(
    (item) => String(item.id) === installationId,
  );
  if (!user || !installation)
    throw new HTTPException(409, { message: "GitHub installation is no longer accessible." });
  const owner = await claimReviewInstallation(c.get("database"), {
    installationId,
    userId: user.id,
    accountId: String(installation.account.id),
    accountLogin: installation.account.login,
  });
  if (owner?.userId !== user.id || !owner.active)
    throw new HTTPException(409, {
      message: "GitHub installation is connected to another account or inactive.",
    });
}
