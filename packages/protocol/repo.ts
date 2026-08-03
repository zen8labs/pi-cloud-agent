import { z } from "zod";

/**
 * Everything needed to clone and address a repository at one point in time.
 *
 * This is the only repository shape in the system. A trigger produces one, the
 * sandbox clones from one, and nothing downstream needs to know which provider
 * it came from.
 */
export const repoRefSchema = z.object({
  /** Provider name, e.g. "github". Resolves a VCSProvider. */
  provider: z.string().min(1),
  /** API/clone host, e.g. "github.com". Enterprise installs differ. */
  host: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  cloneUrl: z.string().url(),
  defaultBranch: z.string().default("main"),
  /** Merge base, when the trigger is a pull request. */
  baseSha: z.string().default(""),
  /** Exact commit to check out. Empty means "tip of the branch". */
  headSha: z.string().default(""),
  headBranch: z.string().default(""),
  prNumber: z.number().int().positive().nullable().default(null),
});

export type RepoRef = z.infer<typeof repoRefSchema>;

/** A repository exposed by a connected VCS identity. */
export interface VcsRepository {
  provider: string;
  host: string;
  fullName: string;
  owner: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string | null;
}
