import type { ReviewRepositoriesResponse, ReviewRepository } from "@pi-cloud-agent/protocol";
import { createGithubReviewReader, type GithubReviewReader } from "@pi-cloud-agent/vcs";
import { HTTPException } from "hono/http-exception";
import type { Config } from "../config";
import type { Database } from "../db/client";
import {
  listReviewInstallations,
  listReviewPolicies,
  reviewInstallationOwner,
} from "../db/reviews";
import { getVcsAccessToken } from "../vcs/connections";

export async function loadReviewRepositories(
  database: Database,
  config: Config,
  userId: string,
  readerFactory: (token: string) => GithubReviewReader = createGithubReviewReader,
): Promise<ReviewRepositoriesResponse & { reader: GithubReviewReader | null }> {
  const [bindings, policies, token] = await Promise.all([
    listReviewInstallations(database, userId),
    listReviewPolicies(database, userId),
    getVcsAccessToken(database, config, "github", userId),
  ]);
  const empty = { repositories: [], installUrl: null, reader: null };
  if (!token) return { ...empty, problem: "Connect your GitHub account in Settings first." };
  const reader = readerFactory(token);
  const live = await reader.installations();
  const repositories: ReviewRepository[] = [];
  const problems: string[] = [];
  problems.push(
    ...bindings
      .filter(
        (binding) =>
          !live.some(
            (item) => String(item.id) === binding.installationId && !item.suspended_at,
          ),
      )
      .map((binding) => `${binding.accountLogin}: GitHub App access is missing or suspended.`),
  );
  // GitHub is the inventory source, including installations whose setup redirect was missed.
  for (const installation of live.filter(
    (item) => String(item.app_id) === config.github.appId && !item.suspended_at,
  )) {
    const installationId = String(installation.id);
    const owner = await reviewInstallationOwner(database, installationId);
    if (owner && (owner.userId !== userId || !owner.active)) continue;
    const problem = permissionProblem(installation.permissions);
    try {
      for (const repo of await reader.repositories(installationId)) {
        repositories.push({
          installationId,
          repo: repo.full_name,
          autoReview:
            policies.find(
              (item) => item.installationId === installationId && item.repo === repo.full_name,
            )?.autoReview ?? false,
          problem,
        });
      }
    } catch {
      problems.push(
        `${installation.account.login}: could not load repositories from GitHub. Refresh to retry.`,
      );
    }
  }
  return { repositories, reader, installUrl: null, problem: problems.join(" ") || null };
}

function permissionProblem(permissions: Record<string, string>): string | null {
  return ["read", "write"].includes(permissions.contents ?? "") &&
    permissions.pull_requests === "write"
    ? null
    : "Grant Contents read and Pull requests write access in GitHub.";
}

export function reviewConfigurationProblem(config: Config): string | null {
  return config.github.appId && config.github.privateKey && config.github.webhookSecret
    ? null
    : "Automatic reviews are not configured on the server. Ask the operator to configure the GitHub App and webhook.";
}

export function requireReviewRepository(
  repositories: ReviewRepository[],
  installationId: string,
  repo: string,
): ReviewRepository {
  const item = repositories.find(
    (candidate) => candidate.installationId === installationId && candidate.repo === repo,
  );
  if (!item)
    throw new HTTPException(404, {
      message: "Repository is not accessible through your connected GitHub App.",
    });
  return item;
}
