import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client";

/**
 * Apply migrations to a database.
 *
 * Separate from `migrate.ts` so tests can migrate a database without running a
 * script that calls `process.exit`.
 */
export async function migrateDatabase(database: Database): Promise<void> {
  await migrate(database, { migrationsFolder: `${import.meta.dirname}/migrations` });
}
