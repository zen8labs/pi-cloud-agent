/**
 * Seed in-repo marketplace plugins into the catalog.
 *
 * Usage: pnpm plugins:seed
 */
import { getConfig } from "../config";
import { createDatabase } from "../db/client";
import { seedMarketplacePlugins } from "./marketplace";

const config = getConfig();
const database = createDatabase(config.databaseUrl);
await seedMarketplacePlugins(database, config);
process.stdout.write(`marketplace plugins seeded from ${config.plugins.marketplaceRoot}\n`);
process.exit(0);
