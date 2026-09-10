# Production deployment

Dashboard on Vercel, controller and Postgres on one VM, two HTTPS hostnames on the same registrable domain. Local development stays [DEVELOPMENT.md](../DEVELOPMENT.md). Run diagnosis stays [operations.md](operations.md).

## Shape

```text
Browser   https://agent.zen8labs.io          → Vercel (`apps/web`)
          https://agent-api.zen8labs.io      → Caddy :443 → 127.0.0.1:8080

Sandbox   CONTROL_PLANE_URL                  → https://agent-api.zen8labs.io
```

The dashboard and the API are different *origins* and the same *site* (`zen8labs.io`). The browser calls the API with CORS and credentials. Do not put the API under `agent.zen8labs.io/_api`, and do not proxy `/_api` through Vercel: the dashboard holds an `EventSource` for the whole run, and sandboxes must reach `CONTROL_PLANE_URL` without going through Vercel.

Copy this shape for another environment: one Vercel hostname for `apps/web`, one VM hostname for the controller, both HTTPS, both under the same apex.

## DNS

| Name | Type | Target | Proxy |
|---|---|---|---|
| `agent` | CNAME | Vercel (`cname.vercel-dns.com`, or the target Vercel shows) | as required by Vercel |
| `agent-api` | A | the VM public IPv4 | **DNS only** (grey cloud). If a CDN proxies this name, it must speak HTTPS to origin :443. |

`agent-api` must resolve to the VM. Confirm with `dig +short agent-api.zen8labs.io A`.

## Firewall

Inbound TCP **22**, **80**, and **443**. 80 is for Let's Encrypt HTTP-01 and HTTP→HTTPS. 443 is the public API. Compose binds Postgres and the controller to `127.0.0.1`; do not publish `8080` or `5532` on `0.0.0.0`.

Confirm from a laptop, not only from the VM:

```bash
nc -z -G 3 <vm-ipv4> 443 && echo open || echo closed
curl -sS https://agent-api.zen8labs.io/healthz
```

`Connection refused` on 443 means the firewall is open but nothing is listening (Caddy not serving HTTPS yet). A long timeout means the firewall is still dropping the port.

## Controller VM

Install Docker, Compose, and Caddy. Clone this repository. Copy [`.env.example`](../.env.example) to `.env` and fill credentials. Set `POSTGRES_PASSWORD` to a hex string (`openssl rand -hex 16`). Never print `.env`.

Production values that differ from local:

```dotenv
CONTROL_PLANE_URL=https://agent-api.zen8labs.io
WEB_URL=https://agent.zen8labs.io
WEB_CORS_ORIGINS=https://agent.zen8labs.io
SANDBOX_PROVIDER=e2b
SANDBOX_TIMEOUT_SECONDS=3600
E2B_TEMPLATE=pi-cloud-agent
GITHUB_APP_REDIRECT_URI=https://agent-api.zen8labs.io/auth/github/callback
# Optional, if webhooks and plugin OAuth are enabled:
# GITHUB_WEBHOOK_SECRET=…
# PLUGIN_OAUTH_REDIRECT_URI=https://agent-api.zen8labs.io/plugins/oauth/callback
```

E2B rejects sandbox lifetimes above one hour. Keep `SANDBOX_TIMEOUT_SECONDS` at **3600** (the code also caps the provider call; do not rely on a higher default).

`CONTROL_PLANE_URL` must be reachable **from inside the E2B sandbox**. That is this public HTTPS URL, not `localhost`. A run that provisions, produces no events, and fails with "stopped reporting" is almost always this value. See [operations.md](operations.md).

Copy [`deploy/Caddyfile`](../deploy/Caddyfile) to `/etc/caddy/Caddyfile`:

```caddyfile
agent-api.zen8labs.io {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
```

Caddy issues the certificate. Then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
docker compose up -d --build
docker compose exec -T controller pnpm db:migrate
docker compose exec -T controller pnpm plugins:seed
```

Migrations never run on boot. An empty database makes GitHub sign-in fail on `oauth_states`.

Do not run `pnpm sandbox:template` on this VM unless it can build the E2B template (Docker, enough disk). Build the template from a machine that can, then point `E2B_TEMPLATE` at the alias.

After any `.env` change: `docker compose up -d --force-recreate controller`.

## Dashboard (Vercel)

One Vercel project, **Root Directory** `apps/web`, framework Next.js, install from the pnpm workspace root. Link with:

```bash
vercel link --yes --scope <team> --project <project>
```

Set `NEXT_PUBLIC_API_BASE=https://agent-api.zen8labs.io` on the **Production** environment. It is inlined at **build** time; changing it requires a new deployment. Do not add `*.vercel.app` to `WEB_CORS_ORIGINS` to make Preview work.

Attach `agent.zen8labs.io` as the production domain. Deploy:

```bash
vercel deploy --prod --yes
```

`.vercelignore` at the repo root keeps local sockets and env files out of the upload. `.vercel/` is gitignored.

## GitHub App

In the App settings, the browser-facing URLs are the **API** host, not Vercel:

| Setting | URL |
|---|---|
| User authorization callback | `https://agent-api.zen8labs.io/auth/github/callback` |
| Webhook | `https://agent-api.zen8labs.io/webhooks/github` |
| Setup URL (if used) | dashboard Settings, as in [operations.md](operations.md) |

`GITHUB_APP_REDIRECT_URI` in `.env` must match the callback exactly.

## Verify

```bash
curl -sS https://agent-api.zen8labs.io/healthz    # {"ok":true}
curl -sS -o /dev/null -w "%{http_code}\n" https://agent.zen8labs.io
```

Then sign in from `https://agent.zen8labs.io`, add a model connection, and start a session. Cookies are set by `agent-api`; CORS must list `https://agent.zen8labs.io`.

## Later updates

| Change | What to run |
|---|---|
| Controller or schema | `git pull` on the VM, `docker compose up -d --build controller`, `pnpm db:migrate` if the schema changed |
| Dashboard | `vercel deploy --prod` (or the git integration) |
| Caddy | edit `/etc/caddy/Caddyfile`, `caddy validate`, `systemctl reload caddy` |
| Sandbox runtime / E2B template | `pnpm sandbox:template` from a Docker-capable machine |

Restarting the controller is safe at any moment; see [resumability.md](resumability.md).
