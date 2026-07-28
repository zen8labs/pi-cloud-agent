import { defineConfig } from "vitest/config";

/**
 * Three test projects, separated by what they need to run — not by which
 * package they live in.
 *
 *   unit         no I/O. Runs everywhere, including a fresh clone with no .env.
 *   integration  needs Postgres (`pnpm up`). Exercises the real state machine.
 *   live         needs real E2B + model credentials. Opt-in, never in CI.
 *
 * `pnpm ci` runs unit + integration. See docs/testing.md for the policy on what
 * deserves a test at all.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{apps,packages}/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/*.integration.test.ts", "**/*.live.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["{apps,packages}/**/*.integration.test.ts"],
          exclude: ["**/node_modules/**"],
          testTimeout: 30_000,
          // One schema, applied once, before anything runs.
          globalSetup: ["./apps/controller/test-global-setup.ts"],
          // These files share one Postgres and truncate between tests, so they
          // must not overlap. A single fork keeps them strictly sequential.
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: "live",
          include: ["{apps,packages}/**/*.live.test.ts"],
          exclude: ["**/node_modules/**"],
          testTimeout: 600_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
