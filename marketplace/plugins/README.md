# Marketplace plugins

In-repo **single source of truth** for plugin packages. The controller seeds and
publishes from this directory into the catalog; published copies live under
`PLUGIN_ARTIFACT_ROOT` (default `.pi-plugin-artifacts/`).

| Package | Role |
|---|---|
| [`context7`](context7/) | skills + remote Context7 MCP (reference package) |
| [`exa`](exa/) | skills + remote Exa MCP (OAuth endpoint; Bearer token) |

```bash
pnpm plugins:seed   # publish every package here as approved / default_off
```

See [docs/adding-a-plugin.md](../../docs/adding-a-plugin.md).
