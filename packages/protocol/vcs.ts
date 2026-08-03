import type { VcsRepository } from "./repo";
import type { Secret } from "./secret";

/**
 * Read and auth only.
 *
 * The agent posts its own comments and pushes its own commits from inside the
 * sandbox using the token this mints, so there is no provider-specific write
 * side here — no publish, no comment API, no diff fetching. The controller
 * needs repository metadata plus the credential for a run.
 *
 * See docs/adding-a-vcs-provider.md.
 */
export interface VCSProvider {
  readonly name: string;

  /** Resolve one repository into the normalized clone shape. */
  getRepository(repoFullName: string): Promise<VcsRepository | null>;

  /** A credential for one repository run. */
  mintRepoToken(repoFullName: string): Promise<Secret>;

  /** The repository's real default branch. Null when it can't be resolved. */
  getDefaultBranch(repoFullName: string): Promise<string | null>;

  /** Best-effort, for the dashboard's selectors. Empty on failure, never throws. */
  listBranches(repoFullName: string): Promise<string[]>;
  listRepos(): Promise<VcsRepository[]>;
}
