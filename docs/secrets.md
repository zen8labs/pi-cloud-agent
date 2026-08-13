# Secrets

## Current design

Users authenticate through the configured GitHub App. The controller creates a local application session and stores the GitHub App user access token encrypted in the user's `vcs_connections` row. Azure DevOps can be connected from Settings and is stored against the same local user. Users never enter a PAT.

`VCS_ENCRYPTION_KEY` is supplied only to the controller. The controller refreshes an expiring provider token, resolves the user's provider, and asks `CredentialBroker` for the credential needed by a run.

The current broker injects the token into the sandbox as `SCM_TOKEN` and provider-specific aliases. This is intentionally temporary: repository code and the agent run in the same untrusted machine, so a malicious repository can read or exfiltrate a token visible to its process.

The optional per-repository setup script in Settings runs in that same untrusted checkout. The Settings **Test setup** action uses a disposable sandbox with the same boundary, then destroys it. It can use the forge credential for private dependencies, but the runtime withholds model credentials, the run callback token, and plugin configuration before invoking it. Do not put any additional credentials in the script or its output.

## Security concerns

These are known limitations, not solved problems:

- The controller keeps a reusable provider token in memory while resolving and provisioning a run. The upcoming secrets broker must replace this with short-lived, repository-scoped credentials or a broker-backed git helper.
- Until the broker boundary exists, a sandbox can exfiltrate the token it is given. Do not treat redaction as containment.
- GitHub App permissions are intentionally narrow but Contents read/write still permits repository mutation. The App installation's repository selection is an additional policy boundary.
- Azure DevOps permissions are delegated through the Microsoft Entra app and must be reviewed separately for least privilege.
- Disconnect deletes the local connection but does not yet revoke the provider token. Add provider-side revocation to the broker/provider adapter.
- Database backups, logs, crash dumps, controller memory, and OAuth client secrets are sensitive. Never return or log them.
- The runtime must not persist model OAuth credentials in the parked session workspace. Pi may use a run-scoped temporary auth file during a turn. A rotated credential is returned only through the authenticated run callback using compare-and-set persistence, and the file is removed before the sandbox can be suspended.
- Session cookies are signed and HttpOnly. Local HTTP uses `SameSite=Lax`; HTTPS uses `SameSite=None` so a dashboard hosted on another site can call the controller. The controller requires an allowed `Origin` on authenticated state-changing browser requests, and `WEB_CORS_ORIGINS` must contain explicit origins rather than `*`. `APP_SESSION_SECRET` must be at least 32 characters and must be rotated using a planned session invalidation procedure.

## Application isolation

The application user is established by the GitHub App callback. VCS connections, runs, sessions, repository discovery, and dashboard reads are scoped by that user's database id. Internal sandbox callbacks use a separate per-run callback token and are not authenticated by the browser session.

## Plugin MCP OAuth

Host-mediated plugin OAuth reuses the same encryption key (`VCS_ENCRYPTION_KEY`)
and stores access/refresh tokens in `plugin_oauth_tokens` plus a copy of the
access token in `plugin_user_variables` under the manifest `tokenVariable`.

- Authorization-server hosts must be listed in `PLUGIN_OAUTH_ISSUER_ALLOWLIST`.
- Tokens must never appear in `run_events`, logs, or audit detail payloads.
- Dynamic client registration caches `client_id` in `plugin_oauth_clients` (public client, PKCE only — no client secret).

## Planned secrets broker

The broker should replace the direct token handoff, not add another token alias. The preferred shape is a broker-backed git credential helper or egress proxy that authorizes a repository operation and injects credentials outside the sandbox. GitHub installation tokens are the intended GitHub execution target: they can be limited to repositories and permissions and expire after one hour.

The seam is `CredentialBroker` in `apps/controller/secrets/broker.ts`. Keep the reconciler dependent on that small interface so the broker can change without spreading secret policy through run orchestration.
