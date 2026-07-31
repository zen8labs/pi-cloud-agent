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
  await ensureTestDatabase();
  const database = createDatabase(TEST_DATABASE_URL);
  try {
    await migrateDatabase(database);
  } finally {
    await closeDatabase(database);
  }
}

/** Keep integration rows away from a controller using the development database. */
async function ensureTestDatabase(): Promise<void> {
  const target = new URL(TEST_DATABASE_URL);
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
    throw new Error(
      `test database name must contain only letters, digits, or "_": ${databaseName}`,
    );
  }

  const adminUrl = new URL(target);
  adminUrl.pathname = "/postgres";
  const admin = createDatabase(adminUrl.toString());
  try {
    const [row] = await admin.$client<{ exists: boolean }[]>`
      select exists(select 1 from pg_database where datname = ${databaseName}) as exists
    `;
    if (!row?.exists) await admin.$client.unsafe(`create database "${databaseName}"`);
  } finally {
    await closeDatabase(admin);
  }
}
