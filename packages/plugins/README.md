# @pi-cloud-agent/plugins

Plugin package format and attach resolution. Trusted-side only.

A **plugin** is an installable bundle of skills and/or MCP servers. Profiles stay marketplace-ignorant; this package composes plugin capabilities *beside* a profile at provision time.

**Depends on:** `zod` only (no protocol types — keep the runtime free of plugin-domain imports). The sandbox runtime never imports this package — skills fold into `TASK_PROMPT`, and MCP arrives as resolved `MCP_CONFIG`.

## Files

| Path | Role |
|---|---|
| `index.ts` | public exports |
| `manifest.ts` | `plugin.json` schema |
| `paths.ts` | relative-path hardening (no `..`, no absolute) |
| `skills.ts` | discover `skills/*/SKILL.md` |
| `mcp.ts` | load `mcp.json`, substitute `${VAR}`, command allowlist |
| `resolve.ts` | org defaults + user override → effective set; skill composition |
| `load.ts` | load and validate a plugin package from disk |
| `types.ts` | shared attach / catalog types |
| `plugins.test.ts` | unit tests |

## Invariants

- **Path traversal is rejected.** Component paths in the manifest must stay inside the package root.
- **Secrets never live in the package.** `variables` declare names only; values come from the dashboard broker.
- **Plugin skills replace the profile skill** when any enabled plugin contributes skills. Otherwise the profile skill is unchanged.
- **MCP is never taken from the cloned user repository.** Only the resolved snapshot from the catalog package.
- **No plugin TypeScript runs on the controller.** This package only reads manifests and markdown.

## Adding a plugin

See [../../docs/adding-a-plugin.md](../../docs/adding-a-plugin.md). Reference packages live under `marketplace/plugins/` (`context7`, `exa` with host-mediated OAuth).

```bash
pnpm vitest run packages/plugins/plugins.test.ts
```
