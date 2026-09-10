# Secrets

## Current design

Users authenticate through the configured GitHub App. The controller creates a local application session and stores the GitHub App user access token encrypted in the user's `vcs_connections` row. This user authorization establishes identity but does not by itself authorize repository work: authenticated production users must also install the GitHub App and select at least one repository. Manual GitHub task creation revalidates that the target repository belongs to an accessible installation. Azure DevOps can be connected from Settings and is stored against the same local user. Users never enter a PAT.

`VCS_ENCRYPTION_KEY` is supplied only to the controller. The controller refreshes an expiring provider token, resolves the user's provider, and asks `CredentialBroker` for the credential needed by a run.

The current broker injects a short-lived credential into the sandbox as `SCM_TOKEN` and provider-specific aliases. GitHub runs receive an installation token minted for exactly the selected repository with Contents and pull-request permissions; the connected-user token remains controller-only for identity and entitlement checks. Controller-owned reviews and comment replies also require short-lived installation tokens, so GitHub attributes automation to the App and scopes it to the installation. Missing App credentials or token-minting failures stop GitHub runs and publication; the controller never falls back to a connected-user token. The private key never crosses into the sandbox. Repository code and the agent still share one untrusted machine, so malicious code could exfiltrate the one-hour, single-repository credential while a run is active.

Repository-specific dependencies belong in a user-selected base image/template. Settings **Test** runs a disposable compatibility check and destroys it. The image executes in the same untrusted sandbox as repository code, so image authors must be trusted. Provider checkpoints are filesystem-only and must not retain credential values.

## Security concerns

These are known limitations, not solved problems:

- The controller keeps the reusable GitHub user token in memory while checking identity and installation entitlement, but it never sends that token to the sandbox. Other VCS providers still require an equivalent repository-scoped credential design.
- A sandbox can exfiltrate its short-lived GitHub installation token while a run is active. Repository and time scoping limit the blast radius; eliminating token visibility entirely requires an authenticated Git transport proxy outside the sandbox. Do not treat redaction as containment.
- GitHub App permissions are intentionally narrow but Contents read/write still permits repository mutation. The App installation's repository selection is an additional policy boundary.
- Azure DevOps permissions are delegated through the Microsoft Entra app and must be reviewed separately for least privilege.
- Disconnect deletes the local connection but does not yet revoke the provider token. Add provider-side revocation to the broker/provider adapter.
- Database backups, logs, crash dumps, controller memory, and OAuth client secrets are sensitive. Never return or log them.
- The runtime must not persist model OAuth credentials in the parked session workspace. Pi may use a run-scoped temporary auth file during a turn. A rotated credential is returned only through the authenticated run callback using compare-and-set persistence, and the file is removed before the sandbox can be suspended.
- Session cookies are signed and HttpOnly. Local HTTP uses `SameSite=Lax`; HTTPS uses `SameSite=None` so a dashboard hosted on another site can call the controller. The controller requires an allowed `Origin` on authenticated state-changing browser requests, and `WEB_CORS_ORIGINS` must contain explicit origins rather than `*`. `APP_SESSION_SECRET` must be at least 32 characters and must be rotated using a planned session invalidation procedure.

## Application isolation

The application user is established by the GitHub App callback. VCS connections, runs, sessions, repository discovery, and dashboard reads are scoped by that user's database id. Internal sandbox callbacks use a separate per-run callback token and are not authenticated by the browser session.

## Plugin MCP OAuth

Host-mediated plugin OAuth reuses the same encryption key (`VCS_ENCRYPTION_KEY`) and stores access/refresh tokens in `plugin_oauth_tokens` plus a copy of the access token in `plugin_user_variables` under the manifest `tokenVariable`.

- Authorization-server hosts must be listed in `PLUGIN_OAUTH_ISSUER_ALLOWLIST`.
- Tokens must never appear in `run_events`, logs, or audit detail payloads.
- Dynamic client registration caches `client_id` in `plugin_oauth_clients` (public client, PKCE only — no client secret).

## Planned secrets broker

GitHub checkout now uses a repository-scoped installation token that expires after one hour rather than a reusable user credential. The next hardening step is a broker-backed Git transport or egress proxy that authorizes a repository operation and injects credentials entirely outside the sandbox. That removes even the short-lived token from the repository process boundary.

The seam is `CredentialBroker` in `apps/controller/secrets/broker.ts`. Keep the reconciler dependent on that small interface so the broker can change without spreading secret policy through run orchestration.
