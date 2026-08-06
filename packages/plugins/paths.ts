import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

/**
 * Resolve a manifest-relative path, rejecting traversal and absolute paths.
 * Same hardening Cursor applies to plugin component paths.
 */
export function resolvePackagePath(packageRoot: string, relativePath: string): string {
  const trimmed = relativePath.trim();
  if (!trimmed) throw new Error("plugin path is empty");
  if (isAbsolute(trimmed)) throw new Error(`plugin path must be relative: ${trimmed}`);
  if (trimmed.split(/[/\\]/).includes("..")) {
    throw new Error(`plugin path must not contain '..': ${trimmed}`);
  }

  const root = resolve(packageRoot);
  const target = normalize(resolve(root, trimmed));
  const rel = relative(root, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`plugin path escapes package root: ${trimmed}`);
  }
  return target;
}
