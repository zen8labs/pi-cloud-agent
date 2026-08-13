import type { Config } from "../config";
import type { Database } from "../db/client";
import type { AppUserRow } from "../db/schema";
import type { IntegrationRegistry } from "../integrations";
import type { Logger } from "../logger";

/** What every route needs. Passed in rather than imported so tests can substitute. */
export interface Deps {
  config: Config;
  database: Database;
  log: Logger;
  integrations: IntegrationRegistry;
}

export type AppEnv = { Variables: Deps & { user: AppUserRow | null } };
