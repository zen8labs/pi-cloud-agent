import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "./client";
import { type RunRow, runs } from "./schema";

/** Only the still-live attempt may extend its ownership; expiry cannot be revived. */
export async function renewProvisioningClaim(
  database: Database,
  run: RunRow,
  leaseSeconds: number,
) {
  const now = new Date();
  const updated = await database
    .update(runs)
    .set({ claimExpiresAt: new Date(now.getTime() + leaseSeconds * 1000) })
    .where(
      and(
        eq(runs.id, run.id),
        eq(runs.attempt, run.attempt),
        eq(runs.status, "provisioning"),
        isNull(runs.sandboxId),
        gt(runs.claimExpiresAt, now),
      ),
    )
    .returning({ id: runs.id });
  return updated.length > 0;
}

/** A failed old worker must never fail or requeue the newer attempt. */
export async function failProvisioningAttempt(database: Database, run: RunRow, error: string) {
  await database
    .update(runs)
    .set({ status: "failed", error, updatedAt: new Date() })
    .where(
      and(eq(runs.id, run.id), eq(runs.attempt, run.attempt), eq(runs.status, "provisioning")),
    );
}
