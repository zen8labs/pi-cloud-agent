import type { RepoRef } from "./repo";
import type { Secret } from "./secret";
import type { ParsedWebhook } from "./trigger";

/**
 * Read and auth only.
 *
 * The agent posts its own comments and pushes its own commits from inside the
 * sandbox using the token this mints, so there is no write side here — no
 * publish, no comment API, no diff fetching. The controller needs exactly two
 * things from a forge: "is this webhook real, and what does it mean", and "give
 * me a credential scoped to this repository".
 *
 * `resolvePullRequest` exists only because some webhooks (GitHub
 * `issue_comment`) carry no commit SHAs, and the sandbox has to clone an exact
 * revision. It returns coordinates, not content: the agent reads the diff with
 * `git` in the checkout it already has.
 *
 * See docs/adding-a-vcs-provider.md.
 */
export interface VCSProvider {
  readonly name: string;

  /**
   * Verify authenticity, then normalize. Throws on a bad signature — never
   * returns a trigger it could not authenticate. Returns null for events that
   * are genuinely uninteresting.
   */
  verifyAndParseWebhook(headers: Headers, body: string): ParsedWebhook;

  /** A short-lived credential scoped to one repository. */
  mintRepoToken(repoFullName: string): Promise<Secret>;

  /** Fill in base/head SHAs a webhook did not carry. */
  resolvePullRequest(repo: RepoRef, prNumber: number): Promise<RepoRef>;

  /** The repository's real default branch. Null when it can't be resolved. */
  getDefaultBranch(repoFullName: string): Promise<string | null>;

  /** Best-effort, for the dashboard's selectors. Empty on failure, never throws. */
  listBranches(repoFullName: string): Promise<string[]>;
  listRepos(): Promise<string[]>;
}

/** A webhook could not be authenticated. Always answered with 401. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
