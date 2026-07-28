import { and, eq } from "drizzle-orm";
import type { Database } from "./client";
import { type RepoConfigRow, repoConfig } from "./schema";

/**
 * Storage for configuration the controller does not understand.
 *
 * These functions move a JSON blob in and out of Postgres. Validation and
 * meaning belong to the profile that owns the row — see
 * `Profile.parseConfig` — which is why nothing here inspects `config`.
 */

export async function getRepoConfig(
  database: Database,
  key: { provider: string; repoFullName: string; profile: string },
): Promise<Record<string, unknown>> {
  const [row] = await database
    .select()
    .from(repoConfig)
    .where(
      and(
        eq(repoConfig.provider, key.provider),
        eq(repoConfig.repoFullName, key.repoFullName),
        eq(repoConfig.profile, key.profile),
      ),
    )
    .limit(1);
  return row?.config ?? {};
}

export async function listRepoConfig(database: Database): Promise<RepoConfigRow[]> {
  return database.select().from(repoConfig);
}

export async function setRepoConfig(
  database: Database,
  key: { provider: string; repoFullName: string; profile: string },
  config: Record<string, unknown>,
): Promise<void> {
  await database
    .insert(repoConfig)
    .values({ ...key, config, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [repoConfig.provider, repoConfig.repoFullName, repoConfig.profile],
      set: { config, updatedAt: new Date() },
    });
}
