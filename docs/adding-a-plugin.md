# Adding a plugin

A plugin is an installable bundle of **skills** and/or **MCP servers**. It
attaches to a user task: the task request decides what job to
do; plugins add extra capabilities for users who install them.

The reference package is [`marketplace/plugins/context7`](../marketplace/plugins/context7).
`marketplace/plugins/` is the in-repo single source of truth for plugin packages.

## Package layout

```text
my-plugin/
  .pi-plugin/
    plugin.json          # required manifest
  skills/                # optional
    my-skill/
      SKILL.md
  mcp.json               # optional MCP server definitions
  README.md
```

### `plugin.json`

```json
{
  "name": "context7",
  "version": "1.0.0",
  "description": "Up-to-date library docs via Context7 MCP",
  "author": { "name": "Zen8" },
  "skills": "skills/",
  "mcpServers": "mcp.json",
  "variables": {
    "type": "object",
    "properties": {
      "CONTEXT7_API_KEY": {
        "type": "string",
        "title": "Context7 API key"
      }
    },
    "required": ["CONTEXT7_API_KEY"]
  }
}
```

Rules:

- `name` is lowercase kebab-case and unique in the catalog.
- Component paths are relative; no `..`, no absolute paths.
- `variables` declare **names** only. Values are configured in the dashboard and
  never live in the package.

### Skills

Each `skills/*/SKILL.md` may have frontmatter `name` + `description`. When any
enabled plugin contributes skills, those skills are composed into `TASK_PROMPT`.

### MCP

Declarative servers in `mcp.json`. Prefer remote URL/SSE with header secrets and
`lifecycle: "lazy"`. Use `${VAR}` placeholders for secrets. Command-based
servers require an operator `MCP_COMMAND_ALLOWLIST` entry.

The sandbox loads MCP **only** via resolved `MCP_CONFIG` from the controller —
never from the cloned repository's `.mcp.json`.

### Host-mediated OAuth (optional)

When an MCP server supports OAuth 2.1 (RFC 9728), declare it on the manifest.
The controller discovers the authorization server, registers a public client
(DCR + PKCE), and stores tokens encrypted — no plugin `install/` code runs.

```json
"oauth": {
  "resource": "https://mcp.exa.ai/mcp",
  "tokenVariable": "EXA_ACCESS_TOKEN",
  "scopes": ["mcp:tools"]
}
```

The issuer host must be on `PLUGIN_OAUTH_ISSUER_ALLOWLIST` (default
`auth.exa.ai`). See [`marketplace/plugins/exa`](../marketplace/plugins/exa).

Dashboard flow: Install → **Connect** → browser sign-in → token injected as
`${tokenVariable}` at provision. Paste into Configure remains a fallback.

## Marketplace (MVP)

One catalog per deployment. Packages live under `marketplace/plugins/`; seeding
copies them into `PLUGIN_ARTIFACT_ROOT` and registers catalog rows.

| Actor | Can |
|---|---|
| Operator (`OPERATOR_GITHUB_LOGINS`) | Seed marketplace packages, publish, approve/yank, set install mode |
| User | Browse approved plugins, install/disable (unless Required), configure variables, complete OAuth when offered |

Install modes: **Default Off**, **Default On**, **Required**.

```bash
pnpm db:migrate
pnpm plugins:seed   # publishes every package under marketplace/plugins as approved / default_off
```

Then open the dashboard **Plugins** page: Install → Connect (OAuth) or Configure → run a task.

## Trust boundary

- Controller reads manifests and substitutes variables. It never executes plugin
  TypeScript or MCP servers.
- Runtime may load `pi-mcp-adapter` with the resolved config snapshot only.
- `packages/runtime` still depends only on `protocol` (+ harness). Plugin
  packages are data, not workspace dependencies of the runtime.
