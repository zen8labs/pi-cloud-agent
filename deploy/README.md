# deploy

Production reverse proxy for the controller. The procedure is [docs/deployment.md](../docs/deployment.md).

| File | Role |
|---|---|
| `Caddyfile` | Caddy site: `agent-api.zen8labs.io` → `127.0.0.1:8080` |
