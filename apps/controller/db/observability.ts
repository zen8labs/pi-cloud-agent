import { TERMINAL_STATUSES } from "@pi-cloud-agent/protocol";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Database } from "./client";
import { type ObservabilityExportRow, observabilityExports, runs } from "./schema";

const CLAIM_LEASE_MS = 120_000;

export async function enqueueExport(
  database: Database,
  runId: string,
  destination: string,
): Promise<void> {
  await database
    .insert(observabilityExports)
    .values({ runId, destination })
    .onConflictDoNothing();
}

/** Seed delivery rows for terminal runs not seen by this destination yet. */
export async function ensurePendingExports(
  database: Database,
  destination: string,
  limit: number,
): Promise<void> {
  const terminalRuns = await database
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, [...TERMINAL_STATUSES]))
    .orderBy(asc(runs.updatedAt))
    .limit(limit);
  if (terminalRuns.length === 0) return;

  await database
    .insert(observabilityExports)
    .values(terminalRuns.map(({ id }) => ({ runId: id, destination })))
    .onConflictDoNothing();
}

/** Claim one export without allowing two controller processes to work it twice. */
export async function claimExport(
  database: Database,
  destination: string,
): Promise<ObservabilityExportRow | null> {
  const staleAt = new Date(Date.now() - CLAIM_LEASE_MS);
  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(observabilityExports)
      .where(
        and(
          eq(observabilityExports.destination, destination),
          or(
            eq(observabilityExports.status, "pending"),
            and(
              eq(observabilityExports.status, "processing"),
              or(
                isNull(observabilityExports.claimedAt),
                lt(observabilityExports.claimedAt, staleAt),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(observabilityExports.updatedAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;

    const [claimed] = await tx
      .update(observabilityExports)
      .set({
        status: "processing",
        attempt: candidate.attempt + 1,
        claimedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(observabilityExports.runId, candidate.runId),
          eq(observabilityExports.destination, destination),
        ),
      )
      .returning();
    return claimed ?? null;
  });
}

export async function markExported(
  database: Database,
  exportRow: ObservabilityExportRow,
): Promise<void> {
  await updateProcessingExport(database, exportRow, {
    status: "exported",
    exportedAt: new Date(),
    claimedAt: null,
    lastError: null,
    updatedAt: new Date(),
  });
}

export async function retryExport(
  database: Database,
  exportRow: ObservabilityExportRow,
  error: string,
): Promise<void> {
  await updateProcessingExport(database, exportRow, {
    status: "pending",
    claimedAt: null,
    lastError: error.slice(0, 1000),
    updatedAt: new Date(),
  });
}

type ExportUpdate = {
  status: "pending" | "exported";
  exportedAt?: Date;
  claimedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
};

async function updateProcessingExport(
  database: Database,
  exportRow: ObservabilityExportRow,
  values: ExportUpdate,
): Promise<void> {
  await database
    .update(observabilityExports)
    .set(values)
    .where(
      and(
        eq(observabilityExports.runId, exportRow.runId),
        eq(observabilityExports.destination, exportRow.destination),
        eq(observabilityExports.status, "processing"),
      ),
    );
}
