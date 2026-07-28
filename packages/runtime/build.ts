/**
 * Bundle the runtime for the sandbox image.
 *
 * This is the one place in the repo with a build step, and it earns it: crossing
 * into a container image is exactly where "just run the TypeScript" stops being
 * simpler. The output is a single file plus a manifest pinning Pi to the version
 * this bundle was typechecked against — read from the installed package rather
 * than written by hand, so the image cannot drift from the workspace.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const PI = "@earendil-works/pi-coding-agent";

// Read the manifest through the workspace's node_modules rather than
// `require.resolve`: Pi does not export "./package.json", and the installed
// version is exactly what we want to pin.
const piVersion = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, "node_modules", PI, "package.json"), "utf8"),
  ) as { version: string }
).version;

await build({
  entryPoints: ["run.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Pi is installed in the image instead of bundled: it ships its own
  // shrinkwrap, native-adjacent deps, and extension loading that expects to
  // live in node_modules.
  external: [PI],
  outfile: "dist/run.js",
});

writeFileSync(
  "dist/package.json",
  `${JSON.stringify(
    {
      name: "pi-cloud-agent-sandbox-runtime",
      private: true,
      type: "module",
      dependencies: { [PI]: piVersion },
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`bundled dist/run.js against ${PI}@${piVersion}\n`);
