import { defineConfig } from "@playwright/test";

/**
 * Browser smoke tests against the real stack: controller, Postgres, dashboard.
 *
 * CI builds and serves the dashboard and provides the database; locally the
 * running dev servers are reused (`pnpm up && pnpm controller && pnpm web`).
 * No forge or sandbox credentials are assumed — see e2e/smoke.spec.ts for how
 * the run lifecycle is asserted without them.
 */
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  retries: CI ? 1 : 0,
  reporter: CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @pi-cloud-agent/controller start",
      port: 8080,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      // CI serves the production build (the job builds it first); locally the
      // dev server is the one already running.
      command: CI
        ? "pnpm --filter @pi-cloud-agent/web start"
        : "pnpm --filter @pi-cloud-agent/web dev",
      port: 3000,
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
