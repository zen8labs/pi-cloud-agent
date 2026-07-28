import type { Config } from "../config";
import type { Database } from "../db/client";
import type { Logger } from "../logger";

/** What every route needs. Passed in rather than imported so tests can substitute. */
export interface Deps {
  config: Config;
  database: Database;
  log: Logger;
}

export type AppEnv = { Variables: Deps };
