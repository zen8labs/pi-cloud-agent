import type { Config } from "../config";
import type { Database } from "../db/client";
import type { AppUserRow } from "../db/schema";
import type { Logger } from "../logger";
import type { Observability } from "../observability";

/** What every route needs. Passed in rather than imported so tests can substitute. */
export interface Deps {
  config: Config;
  database: Database;
  log: Logger;
  observability?: Observability;
}

export type AppEnv = { Variables: Deps & { user: AppUserRow | null } };
