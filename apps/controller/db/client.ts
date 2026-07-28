import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfig } from "../config";
import * as schema from "./schema";

/**
 * One connection pool, one Postgres. No cache, no queue broker, no pub/sub
 * service — the database is all three, which is the reason this file is short.
 */

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(url: string = getConfig().databaseUrl) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return drizzle(client, { schema });
}

/** Release the pool. Used by tests and by shutdown, not during normal operation. */
export async function closeDatabase(database: Database): Promise<void> {
  await database.$client.end();
}

let cached: Database | null = null;

export function db(): Database {
  if (cached === null) cached = createDatabase();
  return cached;
}

/**
 * A dedicated connection for LISTEN/NOTIFY.
 *
 * This is the piece that replaces the in-process event bus the Python version
 * had. Postgres already durably holds every event, so a notification carries no
 * payload that matters — it is purely a "wake up and re-read" hint that makes
 * claiming and streaming feel instant. Correctness never depends on it: every
 * listener also polls, so a dropped notification costs latency, not an event.
 * Unlike an in-memory bus it works across processes, so splitting the API from
 * the reconciler is a deployment choice rather than a rewrite.
 */
export const CHANNELS = {
  runQueued: "run_queued",
  runEvent: "run_event",
} as const;

export function createNotifier(url: string = getConfig().databaseUrl) {
  const client = postgres(url, { max: 1, onnotice: () => {} });

  return {
    async listen(channel: string, onNotify: (payload: string) => void): Promise<() => void> {
      const subscription = await client.listen(channel, onNotify);
      return () => void subscription.unlisten();
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
}

export async function notify(database: Database, channel: string, payload = ""): Promise<void> {
  // `pg_notify` takes the channel as an argument, so both values bind as
  // parameters. The `NOTIFY` statement form would require interpolating the
  // channel name into SQL.
  await database.execute(sql`select pg_notify(${channel}, ${payload})`);
}
