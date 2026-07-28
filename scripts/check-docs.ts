/**
 * Documentation checks.
 *
 * Two invariants, both cheap and both things that rot silently:
 *
 *   1. Every workspace package has a README. It is the local entry point — what
 *      you read when you arrive at a directory from a stack trace or a diff,
 *      rather than from the root index. A package without one is a package a
 *      newcomer has to reverse-engineer.
 *   2. Every relative link in every Markdown file resolves. Moving a file is
 *      easy; finding the six documents that pointed at it is not.
 *
 * Deliberately not checked: prose quality, heading structure, or link text. Those
 * are review's job, and a linter that argues about them gets disabled.
 *
 * Run: pnpm docs:check
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WORKSPACE_DIRS = ["apps", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  ".specstory",
  // Third-party code kept for reference; not ours to fix.
  "references",
]);

/**
 * GitHub templates whose links are resolved by GitHub's UI relative to the pull
 * request or issue page, not by the filesystem. Checking them here would report
 * a working link as broken.
 */
const SKIP_LINK_CHECK = new Set(["PULL_REQUEST_TEMPLATE.md"]);

const problems: string[] = [];

function workspacePackages(): string[] {
  const found: string[] = [];
  for (const dir of WORKSPACE_DIRS) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = join(dir, entry.name);
      if (existsSync(join(pkg, "package.json"))) found.push(pkg);
    }
  }
  return found;
}

/** Every workspace package documents itself, under its own name. */
function checkPackageReadmes(): void {
  for (const pkg of workspacePackages()) {
    const readme = join(pkg, "README.md");
    if (!existsSync(readme)) {
      problems.push(
        `${pkg}: no README.md. Every package needs a local entry point — ` +
          "what it owns, what it may depend on, and a map of its files.",
      );
      continue;
    }

    // The first heading names the package, so a reader who lands here from a
    // search knows which one they are in.
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
      name?: string;
    };
    const heading = readFileSync(readme, "utf8").split("\n")[0]?.trim() ?? "";
    if (manifest.name && heading !== `# ${manifest.name}`) {
      problems.push(`${readme}: first line should be "# ${manifest.name}", found "${heading}"`);
    }
  }
}

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

function checkLink(file: string, target: string): void {
  const resolved = resolve(dirname(file), target);
  if (!existsSync(resolved)) {
    problems.push(`${file}: broken link to "${target}"`);
    return;
  }
  // A link to a directory only reads as intentional if it renders something.
  if (statSync(resolved).isDirectory() && !existsSync(join(resolved, "README.md"))) {
    const shown = relative(".", resolved);
    problems.push(`${file}: links to directory "${target}" but ${shown}/README.md is missing`);
  }
}

/** Relative links point at something that exists. */
function checkLinks(): void {
  // [text](target) where target is not a URL, a mailto, or a bare anchor.
  const linkPattern = /\[[^\]]*\]\((?!https?:\/\/|mailto:|#)([^)\s]+)\)/g;

  for (const file of markdownFiles(".")) {
    if (SKIP_LINK_CHECK.has(file.split("/").at(-1) ?? "")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(linkPattern)) {
      const target = (match[1] ?? "").split("#")[0];
      if (target) checkLink(file, target);
    }
  }
}

checkPackageReadmes();
checkLinks();

if (problems.length > 0) {
  console.error("Documentation problems:\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("");
  process.exit(1);
}

process.stdout.write("Docs OK (package READMEs present, relative links resolve)\n");
