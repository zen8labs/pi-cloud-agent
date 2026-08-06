# exa

First-party plugin: skills + remote Exa MCP (web search / page fetch).

## Auth (OAuth preferred)

Exa MCP supports **OAuth 2.1**. This package declares host-mediated OAuth against:

```text
resource: https://mcp.exa.ai/mcp
MCP URL:  https://mcp.exa.ai/mcp/oauth
```

1. Install the plugin in the dashboard.
2. Click **Connect** — the controller runs RFC 9728 discovery + PKCE against Exa's AS.
3. After sign-in, `EXA_ACCESS_TOKEN` is stored encrypted and injected as
   `Authorization: Bearer …` at provision time.

Paste fallback: configure `EXA_ACCESS_TOKEN` manually with an API key from
https://dashboard.exa.ai/api-keys (Exa accepts a plain API key as Bearer).

Remote HTTP only — no local `npx` / `exa-mcp-server` command.
