import { z } from "zod";
import { type GithubAppCredentials, signGithubAppJwt } from "./github";
import { fetchJson } from "./http";

const installationSchema = z.object({
  id: z.number(),
  app_id: z.number(),
  account: z.object({ id: z.number(), login: z.string() }),
  permissions: z.record(z.string(), z.string()).default({}),
  suspended_at: z.string().nullish(),
});

const repositorySchema = z.object({ full_name: z.string() });
const pullSchema = z.object({
  number: z.number(),
  title: z.string(),
  draft: z.boolean().default(false),
  updated_at: z.string(),
  head: z.object({ sha: z.string() }),
});

export type GithubOpenPull = z.infer<typeof pullSchema>;

/** Unlike selector helpers, these reads fail explicitly so outages aren't empty lists. */
export function createGithubReviewReader(accessToken: string) {
  const get = <T>(path: string) =>
    fetchJson<T>(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  return {
    async installations() {
      return collectPages(async (page) => {
        const response = await get<unknown>(`/user/installations?per_page=100&page=${page}`);
        return z.object({ installations: z.array(installationSchema) }).parse(response)
          .installations;
      });
    },
    async repositories(installationId: string) {
      return collectPages(async (page) => {
        const response = await get<unknown>(
          `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100&page=${page}`,
        );
        return z.object({ repositories: z.array(repositorySchema) }).parse(response)
          .repositories;
      });
    },
    async openPulls(repo: string) {
      return collectPages(async (page) =>
        z
          .array(pullSchema)
          .parse(
            await get<unknown>(
              `/repos/${repo.split("/").map(encodeURIComponent).join("/")}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`,
            ),
          ),
      );
    },
  };
}

export type GithubReviewReader = ReturnType<typeof createGithubReviewReader>;

export async function githubAppInstallUrl(credentials: GithubAppCredentials): Promise<string> {
  const app = await fetchJson<{ slug: string }>("https://api.github.com/app", {
    headers: {
      Authorization: `Bearer ${signGithubAppJwt(credentials.appId, credentials.privateKey)}`,
      Accept: "application/vnd.github+json",
    },
  });
  return `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`;
}

async function collectPages<T>(load: (page: number) => Promise<T[]>): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const batch = await load(page);
    result.push(...batch);
    if (batch.length < 100) return result;
  }
  throw new Error("GitHub result exceeds the supported 5,000 items; narrow repository access.");
}
