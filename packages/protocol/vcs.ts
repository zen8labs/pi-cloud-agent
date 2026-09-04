import type { VcsRepository } from "./repo";
import type { Secret } from "./secret";

/**
 * Repository metadata and checkout authentication.
 *
 * The VCSProvider interface stays deliberately read/auth-only. Provider-specific
 * trusted actuators, such as GitHub review publication, are separate functions
 * in the implementation package so repository checkout and external side effects
 * remain composable boundaries.
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
