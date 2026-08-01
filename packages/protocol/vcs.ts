import type { Secret } from "./secret";

/**
 * Read and auth only.
 *
 * The agent posts its own comments and pushes its own commits from inside the
 * sandbox using the token this mints, so there is no write side here — no
 * publish, no comment API, no diff fetching. The controller needs exactly one
 * thing from a forge: "give me a credential scoped to this repository", plus
 * the read-only metadata the dashboard's selectors ask for.
 *
 * See docs/adding-a-vcs-provider.md.
 */
export interface VCSProvider {
  readonly name: string;

  /** A short-lived credential scoped to one repository. */
  mintRepoToken(repoFullName: string): Promise<Secret>;

  /** The repository's real default branch. Null when it can't be resolved. */
  getDefaultBranch(repoFullName: string): Promise<string | null>;

  /** Best-effort, for the dashboard's selectors. Empty on failure, never throws. */
  listBranches(repoFullName: string): Promise<string[]>;
  listRepos(): Promise<string[]>;
}
