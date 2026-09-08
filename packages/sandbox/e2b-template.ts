/**
 * Build the hosted `pi-cloud-agent` template using the shared machine size.
 *
 * Invoked by `pnpm sandbox:template` after the runtime bundle is built.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import e2bCliPackage from "@e2b/cli/package.json" with { type: "json" };
import { SANDBOX_CPU_COUNT, SANDBOX_MEMORY_MB } from "./machine.js";

const sandboxDir = fileURLToPath(new URL(".", import.meta.url));
const e2bCli = resolve(
  dirname(fileURLToPath(import.meta.resolve("@e2b/cli/package.json"))),
  e2bCliPackage.bin.e2b,
);

const result = spawnSync(
  process.execPath,
  [
    e2bCli,
    "template",
    "create",
    "pi-cloud-agent",
    "-c",
    "sleep infinity",
    "--ready-cmd",
    "true",
    "-d",
    "Dockerfile.sandbox",
    "--cpu-count",
    String(SANDBOX_CPU_COUNT),
    "--memory-mb",
    String(SANDBOX_MEMORY_MB),
  ],
  {
    cwd: resolve(sandboxDir, "../runtime"),
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
