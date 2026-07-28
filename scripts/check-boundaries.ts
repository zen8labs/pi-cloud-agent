/**
 * Dependency-boundary check.
 *
 * The trust boundary between the controller (holds credentials, reaches
 * Postgres) and the runtime (executes untrusted repository code) is the single
 * most important line in this codebase. pnpm's isolated node_modules already
 * makes an undeclared import unresolvable — this script makes a *declared* one
 * a CI failure too, so the boundary can't be widened by adding a dependency
 * without someone editing this file and explaining why.
 *
 * Run: pnpm boundaries
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCOPE = "@pi-cloud-agent/";

/** Which workspace packages each package is allowed to depend on. */
const ALLOWED: Record<string, string[]> = {
  // Contracts only. Depending on anything would make it not a contract.
  protocol: [],
  // Implementations depend on the contracts and nothing else.
  profiles: ["protocol"],
  sandbox: ["protocol"],
  vcs: ["protocol"],
  // UNTRUSTED ZONE. Runs inside the sandbox alongside repository code.
  // It must never be able to reach a credential broker, a VCS client, a
  // sandbox provider, or the database. It talks to the controller over HTTP.
  // Note it does not depend on `profiles` either: the controller composes the
  // full prompt, so the sandbox image carries no profile code at all.
  runtime: ["protocol"],
  // TRUSTED ZONE. The only package that may compose everything.
  controller: ["protocol", "profiles", "sandbox", "vcs"],
  // Browser client. Types only — it reaches the controller over HTTP.
  web: ["protocol"],
  tsconfig: [],
};

type Violation = { pkg: string; dep: string };

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function shortName(name: string): string {
  return name.startsWith(SCOPE) ? name.slice(SCOPE.length) : name;
}

/** Every workspace package on disk, keyed by its short name. */
function readManifests(): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  for (const dir of ["apps", "packages"]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(
          readFileSync(join(dir, entry.name, "package.json"), "utf8"),
        ) as Manifest;
        manifests.set(shortName(manifest.name ?? entry.name), manifest);
      } catch {
        // A directory without a readable manifest is not a package.
      }
    }
  }
  return manifests;
}

function checkPackage(pkg: string, manifest: Manifest): Violation[] {
  const allowed = ALLOWED[pkg];
  if (!allowed) return [{ pkg, dep: "<not listed in scripts/check-boundaries.ts>" }];

  const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  return (
    deps
      .filter((dep) => dep.startsWith(SCOPE))
      .map(shortName)
      // Shared compiler options are not a dependency in any meaningful sense.
      .filter((target) => target !== "tsconfig" && !allowed.includes(target))
      .map((target) => ({ pkg, dep: target }))
  );
}

function collect(): Violation[] {
  const manifests = readManifests();
  const violations = [...manifests].flatMap(([pkg, manifest]) => checkPackage(pkg, manifest));

  // A stale entry here is as much of a problem as a missing one: it means the
  // boundary being asserted no longer describes the repository.
  for (const pkg of Object.keys(ALLOWED)) {
    if (!manifests.has(pkg)) {
      violations.push({ pkg, dep: "<declared here but no such package>" });
    }
  }

  return violations;
}

const violations = collect();
if (violations.length > 0) {
  console.error("Dependency boundary violations:\n");
  for (const { pkg, dep } of violations) {
    console.error(`  ${pkg} may not depend on ${dep}`);
  }
  console.error("\nIf a boundary genuinely needs to move, change ALLOWED in");
  console.error("scripts/check-boundaries.ts and say why in the commit message.");
  process.exit(1);
}

process.stdout.write(`Dependency boundaries OK (${Object.keys(ALLOWED).length} packages)\n`);
