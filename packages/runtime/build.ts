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
const PI_AI = "@earendil-works/pi-ai";
const PI_TUI = "@earendil-works/pi-tui";
const MCP_ADAPTER = "pi-mcp-adapter";
const TSX = "tsx";
const TYPEBOX = "typebox";

type PackageJson = {
  version: string;
  dependencies?: Record<string, string>;
};

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

/** Prefer an exact installed version; fall back to the range declared by a parent. */
function pinnedDependency(name: string, candidates: string[], declaredBy: PackageJson): string {
  for (const candidate of candidates) {
    try {
      return readPackageJson(join(candidate, "package.json")).version;
    } catch {
      // Keep looking; the package may only be nested under another install.
    }
  }
  const declared = declaredBy.dependencies?.[name];
  if (!declared) throw new Error(`could not pin ${name}: not installed and not declared`);
  return declared.replace(/^[~^]/, "");
}

const runtimeRoot = import.meta.dirname;
const piRoot = join(runtimeRoot, "node_modules", PI);
const piManifest = readPackageJson(join(piRoot, "package.json"));
const piVersion = piManifest.version;

const mcpAdapterVersion = readPackageJson(
  join(runtimeRoot, "node_modules", MCP_ADAPTER, "package.json"),
).version;

const tsxVersion = readPackageJson(
  join(runtimeRoot, "../../node_modules", TSX, "package.json"),
).version;

// pi-mcp-adapter peers must be top-level in the image. npm nests Pi's copies
// under pi-coding-agent, and Node will not resolve those from the adapter.
const typeboxVersion = pinnedDependency(
  TYPEBOX,
  [join(piRoot, "node_modules", TYPEBOX), join(runtimeRoot, "node_modules", TYPEBOX)],
  piManifest,
);
const piAiVersion = pinnedDependency(
  PI_AI,
  [join(piRoot, "node_modules", PI_AI), join(runtimeRoot, "node_modules", PI_AI)],
  piManifest,
);
const piTuiVersion = pinnedDependency(
  PI_TUI,
  [join(piRoot, "node_modules", PI_TUI), join(runtimeRoot, "node_modules", PI_TUI)],
  piManifest,
);

await build({
  entryPoints: ["run.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Pi and the MCP adapter stay in node_modules: Pi ships shrinkwrap + extension
  // loading; the adapter is TypeScript-source-only and is loaded via `tsx`.
  external: [PI, MCP_ADAPTER],
  outfile: "dist/run.js",
});

writeFileSync(
  "dist/package.json",
  `${JSON.stringify(
    {
      name: "pi-cloud-agent-sandbox-runtime",
      private: true,
      type: "module",
      dependencies: {
        [PI]: piVersion,
        [PI_AI]: piAiVersion,
        [PI_TUI]: piTuiVersion,
        [MCP_ADAPTER]: mcpAdapterVersion,
        [TYPEBOX]: typeboxVersion,
        [TSX]: tsxVersion,
      },
    },
    null,
    2,
  )}\n`,
);

// pi-mcp-adapter still imports `complete` from `@earendil-works/pi-ai` main;
// on 0.82 that export lives only on `/compat`, which re-exports main. Point the
// image's main entry at compat so the adapter and Pi share one install.
writeFileSync(
  "dist/patch-pi-ai-exports.mjs",
  [
    'import { readFileSync, writeFileSync } from "node:fs";',
    "",
    'const path = new URL("./node_modules/@earendil-works/pi-ai/package.json", import.meta.url);',
    'const manifest = JSON.parse(readFileSync(path, "utf8"));',
    "manifest.exports ??= {};",
    'manifest.exports["."] = {',
    '  types: "./dist/compat.d.ts",',
    '  import: "./dist/compat.js",',
    "};",
    'writeFileSync(path, JSON.stringify(manifest, null, 2) + "\\n");',
    'process.stdout.write("patched @earendil-works/pi-ai main export -> compat\\n");',
    "",
  ].join("\n"),
);

process.stdout.write(
  `bundled dist/run.js against ${PI}@${piVersion}, ${MCP_ADAPTER}@${mcpAdapterVersion}, ${PI_AI}@${piAiVersion}, ${PI_TUI}@${piTuiVersion}, ${TYPEBOX}@${typeboxVersion}, ${TSX}@${tsxVersion}\n`,
);
