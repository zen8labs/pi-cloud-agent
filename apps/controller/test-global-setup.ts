/**
 * Migrate the test database once, before any integration test file runs.
 *
 * Doing it per file raced: three files calling `migrate` at the same moment each
 * try to create the migrations table. One setup, one schema.
 */
import { closeDatabase, createDatabase } from "./db/client";
import { migrateDatabase } from "./db/migrate-runner";
import { TEST_DATABASE_URL } from "./test-support";

export async function setup(): Promise<void> {
  const database = createDatabase(TEST_DATABASE_URL);
  try {
    await migrateDatabase(database);
  } finally {
    await closeDatabase(database);
  }
}
