# Brokered secrets for untrusted cloud agents

## Executive decision

Add a user-facing secret vault, but do not expose stored values to the agent, the agent harness, repository code, shell commands, MCP processes, or a parked workspace. The durable product primitive should be a **credential binding**: a secret value plus a narrow rule describing where and how it may be used. At run time, the controller grants the sandbox a short-lived proxy capability and, when compatibility requires it, an opaque placeholder. A separate broker injects the real credential only after the request has left the sandbox and matched the binding.

This is stronger than the general secret features publicly documented by Devin and Cursor. Devin documents that secrets become ordinary environment variables. Cursor's Runtime Secrets are also environment variables; Cursor redacts their values from model-visible output, but a terminal user can still read them. Claude Code's newer API Credentials and dedicated GitHub proxy are the closest public match to the desired architecture: credentials are attached after a matching request leaves the VM, and GitHub operations are additionally scoped by repository and operation.[^1][^2][^3]

Use Infisical Agent Vault as the first broker implementation, deployed as a separate service and hidden behind a small app-owned adapter. Do not fork it into this repository and do not make its management UI the product UI. Its transparent proxy, host/path service rules, short-lived vault sessions, TypeScript SDK, network guard, audit log, and PostgreSQL support remove a large amount of security-sensitive work.[^4][^5] However, it is still marked Preview, its API may change, proxy sessions are vault-wide rather than restricted to a subset of services, its host mode is cooperative, and its matcher cannot restrict HTTP methods, headers, query values, or bodies.[^4][^6][^7] It is therefore an implementation candidate, not a security claim by itself.

The first production slice should support static HTTP API credentials only. Git forge credentials, model OAuth credentials, browser cookies/TOTP, SSH keys, database protocols, and arbitrary raw-secret access require different capabilities and should not be mislabeled as safely brokered.

## What the public evidence actually says

### Devin

Devin provides organization-global, personal, repository, and session scopes. Its Note field is explicitly described as context or instructions for Devin and organization members. Sensitive values are encrypted at rest and can be redacted in logs; new global secrets apply only to sessions created after the secret was added.[^1]

The screenshot is consistent with those docs. It is reasonable to infer that the secret name and Note are made available to the model or another planning layer so Devin knows when to use the credential. It is not reasonable to infer placeholder substitution or a secret-injection proxy from that UI. Devin explicitly says configured secrets are accessed as normal environment variables, including repository-specific secrets placed into environment configuration or `.env` files.[^1]

Consequently, the likely documented flow is:

```text
encrypted storage -> session environment variable -> command/application
                                      |
                                      +-> value redacted from selected output paths
```

This protects storage and accidental display, but repository code in the same machine can still read the value. The Note should be treated as discoverability UX, not evidence of an enforcement mechanism.

### Cursor Cloud Agents

Cursor now distinguishes three types:[^2]

| Type | Runtime behavior | Security property |
|---|---|---|
| Environment Variable | Ordinary environment variable | Visible to the agent and commands |
| Runtime Secret | Ordinary environment variable with output/commit/transcript redaction | Reduces accidental disclosure; does not contain a hostile process |
| Build Secret | Available only to the Docker build step | Not present in the running agent |

Cursor separately provides configurable network egress modes and recommends short-lived OIDC tokens for cloud roles and internal APIs.[^2] Its security overview describes per-agent microVMs and a separate AWS account for agent compute.[^8] These are useful defense-in-depth controls, but the public Runtime Secret contract is still materialization plus redaction, not general request-time credential brokering.

### Claude Code on the web

Claude Code documents two stronger mechanisms in Anthropic-hosted environments:

1. A dedicated GitHub proxy keeps the real GitHub credential outside the VM. The guest uses a scoped placeholder; the proxy swaps it for the real token, restricts access to repositories attached to the session, restricts pushes to the current branch, and permits only a pinned GraphQL subset.[^3]
2. API Credentials, currently documented for Pro and Max environments, bind a credential to allowed hosts and header injection rules. The proxy adds the credential after a request leaves the VM; commands, Claude, and environment variables never receive the value.[^9]

Ordinary environment variables remain readable by every command, and Team/Enterprise API Credentials are not yet documented as available.[^9] This distinction is important: even a vendor with a broker still has unsafe compatibility paths.

### Vercel Sandbox and E2B

Vercel exposes the same primitive at the sandbox network-policy layer: a matching outbound domain receives injected or overwritten headers, while the credential stays outside the VM.[^10] Vercel also states the key residual risk accurately: the proxy prevents credential extraction and reuse elsewhere, but compromised code can still misuse the credential through allowed requests while the run is active.[^11]

E2B's current public SDK exposes an `allow_internet_access` switch, while its enterprise material advertises per-sandbox egress rules and credentials resolved at egress.[^12][^13] The app must verify which contract is available to its installed E2B version and plan. A cooperative `HTTPS_PROXY` configuration is insufficient for hostile-code containment.

## Security objective and non-objectives

### Objective

Compromise of the complete untrusted zone—including the model, Pi harness, repository, custom base image, shell, child processes, MCP servers, and a resumed workspace—must not reveal a reusable third-party credential value.

The attacker may:

- control repository contents, dependency install behavior, test code, tool output, and prompt-injection text;
- execute arbitrary commands as the runtime user;
- inspect process arguments, environment variables, files, `/proc`, local sockets, and outbound responses;
- unset proxy variables, use a client that ignores them, open raw sockets, manipulate DNS, follow redirects, and try alternate protocols;
- steal any capability that is present in the sandbox and use it until expiry;
- intentionally call an allowed upstream in a harmful way.

### Non-objectives

A credential broker does not by itself prevent:

- authorized-but-harmful actions against an allowed upstream;
- data exfiltration through the body of an allowed request or through an allowed model API;
- a target API reflecting its own credential back in a response;
- abuse of a stolen run proxy token while that token remains valid;
- compromise of the trusted controller, broker, key-management service, database, or their operators;
- TLS interception bypass by non-HTTP protocols, certificate-pinned clients, QUIC/HTTP/3, custom trust stores, or clients that ignore proxy settings;
- browser logins, TOTP, SSH, raw database protocols, or arbitrary secrets that cannot be expressed as a constrained HTTP credential binding.

The product should say “the credential value is not present in the sandbox,” not “the agent cannot misuse the credential” or “secrets cannot leak.”

## Recommended architecture

```text
                           TRUSTED CONTROL PLANE

  Settings UI ──write only──► Controller API ───────► secret metadata + ciphertext
                                    │                       (app Postgres/KMS)
                                    │ resolve exact effective set
                                    │ for user + repository + run
                                    ▼
                              Broker adapter
                                    │ creates ephemeral run vault/rules
                                    │ mints short-lived proxy session
                                    ▼
                         Agent Vault on separate host
                         credentials decrypted only here
                                    │
                                    │ matched HTTPS request with
                                    │ server-side auth injection
                                    ▼
                               Third-party API
                                    ▲
                                    │ response, never injected headers
  ┌─────────────────────────────────┴─────────────────────────────────┐
  │                         UNTRUSTED SANDBOX                          │
  │ repo + custom image + Pi + shell + MCP + tested application      │
  │                                                                  │
  │ placeholder env + short-lived proxy capability + public CA       │
  │ egress: controller callback and broker proxy only; DNS locked     │
  └──────────────────────────────────────────────────────────────────┘
```

The controller remains the authority for app users, repository authorization, run lifecycle, and scope resolution. Agent Vault is a replaceable broker data plane, not a second product control plane. This matches the existing architecture: the trusted controller owns credentials, the untrusted runtime calls outward, and the reconciler already depends on the small `CredentialBroker` seam.

### A run gets an immutable credential snapshot

At provisioning time, resolve credentials in this order:

1. credentials owned by the authenticated app user;
2. global credentials for that user;
3. repository credentials matching `(provider, repoFullName)`;
4. explicit per-run selections, when that UX is added.

A repository binding with the same logical name may override a global binding only when the UI shows the shadowing explicitly. Ambiguous collisions—same placeholder name with different hosts or auth shapes—should block provisioning rather than be renamed silently.

Persist only the selected credential IDs and versions on the run. Never persist values, generated placeholders, proxy tokens, or the broker CA private key. A running session keeps its original snapshot. A later turn resolves a new snapshot and receives a new proxy session, so rotation and revocation take effect at a clear turn boundary.

### Per-run broker isolation

Agent Vault currently scopes a short-lived session to an entire vault, and any proxy-role session can use all services in that vault.[^14] A single per-user vault would therefore let a run for repository A use repository B's credentials. Until Agent Vault supports service-subset sessions or composable vault overlays, create an ephemeral vault per run containing only the resolved credentials and service rules.

The lifecycle must be durable:

```text
run claimed
  -> persist broker provisioning intent
  -> create run vault and exact rules
  -> mint session with TTL <= run deadline
  -> persist opaque broker resource id (never token)
  -> start sandbox
  -> revoke session/delete run vault on every terminal or reclamation path
  -> retry cleanup until confirmed
```

TTL is the hard backstop, not the normal cleanup mechanism. Broker provisioning and sandbox launch need attempt fencing just like current sandbox allocation, so an expired reconciler lease cannot leave a usable orphan capability.

This approach temporarily duplicates each selected ciphertext into Agent Vault for the lifetime of the run. Treat that as an explicit tradeoff: the controller is the canonical store, Agent Vault copies must be deleted durably, and backup/retention policy must cover both databases. If service-subset sessions or a controller-backed credential store become available, remove the per-run copies.

### Non-cooperative network enforcement

`HTTPS_PROXY`, `HTTP_PROXY`, placeholder variables, and a trusted CA only make compatible clients work. They do not force hostile code through the broker. Agent Vault's own docs state that host mode can be bypassed by unsetting environment variables, spawning a non-inheriting process, using raw sockets, or exfiltrating over DNS; its opt-in container mode uses iptables to allow only the proxy.[^7]

For this app, enforcement belongs behind `SandboxProvider`:

- microSandbox: replace the current “public TCP 80/443” rule for brokered runs with default-deny egress that permits only the controller callback and broker endpoints. Do not expose general DNS if the broker address can be pinned safely.
- E2B: do not enable brokered secrets until the deployed plan/API can enforce a proxy-only route or equivalent egress transformation. An environment-only proxy is a compatibility demo, not the production security boundary.
- future providers: capability support must be explicit. A provider either proves enforced broker egress or the controller rejects runs that select brokered secrets.

This probably requires widening the sandbox contract with an app-owned egress policy or capability declaration. That is a deliberate protocol change and should be reviewed before implementation.

### Credential binding, not a raw secret

Each stored value must declare how it can leave the broker:

```ts
type HttpCredentialBinding = {
  name: string;
  scope: { kind: "global" } | {
    kind: "repository";
    provider: string;
    repoFullName: string;
  };
  target: {
    scheme: "https";
    host: string;
    pathPrefix?: string;
    methods?: ("GET" | "POST" | "PUT" | "PATCH" | "DELETE")[];
  };
  auth:
    | { kind: "bearer" }
    | { kind: "header"; headerName: string; prefix?: string }
    | { kind: "basic"; usernameSecretId: string };
  placeholderEnv?: string;
  usageHint?: string;
};
```

This is a design shape, not a recommendation to place it immediately in `packages/protocol`. The public browser API can own it until the provider-neutral contract is proven.

Rules should default to exact HTTPS hosts, exact paths where known, and the narrowest methods. Wildcard hosts require a warning and should match exactly one subdomain segment. Redirects must be re-evaluated against the destination rule; injected authorization must never follow to a different host. Private, loopback, link-local, cloud metadata, and rebinding targets must be rejected. Agent Vault already implements IP validation and DNS-rebinding protection, including unconditional metadata blocking.[^5]

Agent Vault currently matches host and optional path only, not HTTP method, header, query, or body.[^6] If method-level policy is required for a high-impact credential, use a typed controller actuator or a narrower provider-specific proxy rather than claiming the generic broker enforces it.

## How the agent should learn about credentials

The model needs capability metadata, not secret values. Add a generated, structured block to the trusted task prompt containing:

- logical name or environment variable name;
- target service and allowed host/path;
- scope (`global` or the current repository);
- a short usage hint;
- whether the binding is automatically injected or requires a placeholder environment variable.

For example:

```text
Available brokered credential:
- OPENAI_API_KEY: usable only for HTTPS requests to api.openai.com.
  The environment contains a non-secret placeholder so standard OpenAI SDKs work.
  The real value cannot be read from the environment.
```

The Note in the Devin screenshot probably serves a similar discoverability purpose, but a note must never define security policy. Treat it as user-authored metadata, delimit it as data, cap its length, strip control characters, and do not let it override host, method, scope, approval, or logging rules.

Prefer broker-owned header overwrite to placeholder substitution when the client can omit authentication. For SDK compatibility, expose an opaque per-run placeholder such as `__broker_7f...__`, not the secret name or a stable global placeholder. The broker may substitute that token only in the specific authorized header/path/query surface. Placeholder substitution across every header or body creates unnecessary confused-deputy and reflection risks.

## Settings UX

Add a third Settings tab: **Secrets**. “Global” means available to all repositories owned by the current app user, not deployment-wide or organization-wide. The app has no organization/RBAC model today, so an organization scope would be misleading.

### List view

Show:

| Field | Purpose |
|---|---|
| Name | Stable logical/environment name |
| Scope | Global or one repository |
| Service | Exact host and optional path |
| Authentication | Bearer, named header, or Basic pair |
| Updated | Rotation timestamp and actor |
| Last used | Latest brokered request time, never a value |
| Status | Active, disabled, invalid, or pending deletion |

Values are write-only: never return them after creation and do not offer a reveal button. “Replace value” performs rotation. Deletion and scope expansion require confirmation; scope reduction and disabling should be immediate.

### Create/edit form

Use these fields:

1. Name (`UPPER_SNAKE_CASE`, unique within an effective repository scope).
2. Scope: Global or Repository; repository selection uses the existing authorized repository list.
3. Target HTTPS host; optional path prefix.
4. Authentication type and header mapping.
5. Secret value, accepted only on creation/rotation.
6. Usage hint, clearly labeled “shown to the agent; do not put secrets here.”
7. Optional read-only connection test endpoint.

Do not copy Devin's “Sensitive” toggle. Every value in this feature is sensitive and every output path is redacted. Public configuration belongs in environment settings, not a secret vault. A toggle invites users to disable the only safeguard while still believing the value is protected.

Before save, show a plain-language grant summary:

> Tasks for `owner/repo` may authenticate to `api.openai.com` with this credential during a run. The value will not enter the sandbox, but code in the sandbox can make any broker-permitted request to that service until the run ends.

### Repository view

Settings → Repositories should link to “Effective secrets” for each repository. Show inherited global bindings and repository overrides together, with inherited rows labeled. This makes global blast radius visible and prevents scope surprises.

## Storage, keys, rotation, and audit

The current `encryptSecret` helper uses AES-256-GCM with one deployment-supplied key. That provides authenticated encryption but not production key hierarchy, independent tenant keys, managed rotation, or auditable decrypt authorization. Keep it for a prototype only.

Production storage should use envelope encryption:

- a random data-encryption key per secret version;
- AES-256-GCM with authenticated context containing user ID, secret ID, scope, and version;
- the data key wrapped by a KMS/HSM-managed key;
- ciphertext, nonce, wrapped key, key ID, and version in Postgres;
- decrypt permission available only to the controller's broker-provisioning identity;
- key rotation by rewrapping data keys, and value rotation by creating a new immutable secret version.

Never log request/response bodies, headers, query strings, secret values, placeholders, proxy tokens, or full URLs. Audit records may include user, run, credential ID/version, method, normalized host/path template, result class, upstream status, byte counts, latency, and timestamp. Agent Vault documents credential-value-free request logging and has configurable retention, but the app should ingest only its minimal normalized audit schema rather than expose a second audit UI.[^15]

Deletion should be a state machine: disable new use immediately, revoke active run grants, delete broker copies, then cryptographically erase or remove the canonical ciphertext. Failed broker cleanup remains visible and retryable. Database backups follow the documented retention window; “deleted” must not promise instant removal from historical backups.

## Credential classes and safe handling

| Credential class | Recommended mechanism | Initial status |
|---|---|---|
| Static HTTP API key | Host/path-bound broker injection | Build first |
| GitHub repository access | Dedicated Git transport/API proxy with repo, branch, operation constraints | Build after generic broker |
| Cloud access | OIDC/workload identity -> short-lived role credentials, preferably used by a broker | Prefer over static keys |
| Model API key | Broker the streaming HTTPS request | Migrate after proxy reliability is proven |
| Model OAuth JSON | Controller/model gateway owns refresh and injects current access token | Do not pass opaque OAuth JSON into sandbox |
| MCP OAuth | Run MCP remotely/trusted or broker its outbound HTTP auth | Migrate per plugin |
| Browser cookies/TOTP | Typed browser-auth capability with explicit human approval | Out of first scope |
| SSH key | SSH certificate authority or dedicated Git proxy | Never expose raw private key |
| Database password | Dynamic DB user with TTL plus protocol-aware proxy | Out of generic HTTP broker scope |
| Arbitrary raw secret/file | Cannot guarantee non-disclosure while remaining generally usable | Do not offer as “safe” |

For GitHub, preserve the existing App installation and selected-repository authorization. The controller can mint the one-hour installation token, but deliver it to the broker rather than the sandbox. The proxy must bind the run to the selected repository, restrict pushes to the task branch, and constrain API/GraphQL operations. Claude's public GitHub proxy contract is a useful target.[^3]

For cloud providers, follow Cursor's documented OIDC direction: give the sandbox a short-lived signed workload identity, then let AWS/GCP/Azure/Vault exchange it for a narrowly scoped role.[^2] The identity token is still a stealable capability, so bind audience, user, run, repository, expiry, and nonce, and keep TTL short.

## Agent Vault integration decision

### Reuse

- HTTP/HTTPS MITM proxy and CA bootstrap;
- server-side Bearer, Basic, API-key, custom-header, and narrowly scoped placeholder injection;
- IP-range and metadata blocking plus DNS-rebinding defense;
- hashed short-lived session tokens and proxy-only roles;
- request audit metadata and rate limiting;
- PostgreSQL deployment support;
- TypeScript SDK for session creation and proxy environment generation.[^4][^5]

### Keep app-owned

- Settings UX and authenticated HTTP API;
- app-user, repository, and run authorization;
- global/repository inheritance and collision semantics;
- KMS envelope encryption and secret version metadata;
- run snapshot, lifecycle fencing, cleanup/revocation, and audit projection;
- provider capability checks and egress enforcement;
- typed actuators for operations too powerful for generic host/path rules.

### Do not rely on

- the Agent Vault management UI or its separate user/RBAC model;
- a long-lived agent token inside a sandbox;
- one vault shared by all repositories;
- its default unmatched-host pass-through; use strict deny;
- `HTTPS_PROXY` without kernel/provider egress enforcement;
- automatic migrations without a deployment rollout plan;
- its current Preview API remaining stable;
- host/path matching as authorization for high-impact write operations.

Pin an audited release image by digest and pin the SDK version. Run the broker on a separate host or separately isolated data plane; its own guidance warns that sharing the agent host/kernel weakens the threat model.[^4] Keep the management API controller-only and the proxy port reachable only from sandbox networks. Use TLS or a private link between sandbox and broker because Agent Vault documents that its proxy session token travels in cleartext in `Proxy-Authorization` on the agent-to-broker hop.[^5]

## Implementation sequence

### Phase 0 — prove the boundary

1. Write an ADR fixing the threat model and the meaning of “global.”
2. Add an Agent Vault deployment in a non-production environment, pinned by digest.
3. Prove one static OpenAI-compatible test key through a disposable microSandbox.
4. Demonstrate that `env`, `/proc`, files, shell history, telemetry, diffs, checkpoints, and crash logs contain no real value.
5. Demonstrate that unsetting proxy variables, raw TCP, alternate DNS, redirects, and a non-proxy-aware client cannot bypass the enforced route.
6. Measure streaming model latency and common client compatibility.

Exit only when the network test is non-cooperative. A successful `curl` through a configured proxy is not sufficient.

### Phase 1 — product model and UI

1. Add secret metadata, immutable versions, repository bindings, and audit tables with generated migrations.
2. Add authenticated CRUD APIs that never return values.
3. Add Settings → Secrets and Effective secrets in repository settings.
4. Implement global/repository resolution and store selected IDs/versions on each run.
5. Keep all code controller/web-local until a stable cross-package contract is necessary.

### Phase 2 — brokered static HTTP credentials

1. Add an app-owned broker adapter backed by the Agent Vault SDK.
2. Provision an ephemeral per-run vault and short-lived session.
3. Pass only proxy configuration, public CA, capability token, and placeholders to the sandbox.
4. Set strict unmatched-host deny and exact service rules.
5. Add durable cleanup/revocation state and reconciliation.
6. Gate the feature on provider-enforced egress capability; microSandbox first, E2B only after live proof.

### Phase 3 — migrate existing ambient credentials

1. Move model API keys behind the proxy; retain a placeholder only for SDK compatibility.
2. Move GitHub installation tokens into a dedicated Git/API proxy with repository and branch policy.
3. Move plugin MCP header/env credentials to broker rules or trusted remote MCP execution.
4. Move model and MCP OAuth refresh into trusted controller-side gateways.
5. Remove the superseded `spec.secrets` injections rather than preserving compatibility fallbacks.

The run callback token is not a third-party secret and still needs a sandbox-readable capability so the runtime can report. Keep it per-run, narrowly scoped, hashed server-side, and short-lived. Treat theft as the ability to submit callbacks for that run, not as third-party account compromise.

### Phase 4 — stronger capabilities

1. Add OIDC workload identity for cloud providers and internal APIs.
2. Add approval gates for new domains, scope expansion, production credentials, and high-impact methods.
3. Add budgets: request rate, total requests, bytes, cost, and write-operation count per credential/run.
4. Contribute service-subset sessions and method constraints upstream to Agent Vault or replace the adapter if those guarantees cannot be obtained.

## Verification plan

### Isolation tests

- `printenv`, `/proc/<pid>/environ`, process arguments, shell history, core dumps, temp files, checkpoints, and provider snapshots never contain a real secret.
- Agent Vault token theft does not allow management API access, value reveal, another vault, another run, or use after expiry/revocation.
- a run for repository A cannot use repository B or another user's bindings;
- warm resume receives a fresh grant and cannot recover the previous grant from disk;
- stale provisioning attempts cannot leave active broker sessions;
- broker or KMS failure prevents the run from starting and never falls back to ambient injection.

### Network tests

- unsetting all proxy and CA variables still cannot reach the public internet directly;
- raw IPv4/IPv6 TCP, UDP, ICMP, DNS tunneling, DoH, QUIC, WebSocket, and alternate ports cannot bypass policy;
- redirects are re-authorized at every host hop and never carry an injected header cross-host;
- DNS rebinding, private ranges, loopback, link-local, and cloud metadata remain blocked;
- unmatched hosts fail closed;
- certificate-pinned clients fail clearly without prompting users to disable TLS verification;
- proxy outage, timeout, partial response, and restart are retry-safe and observable.

### Policy and misuse tests

- exact host does not match attacker-controlled suffixes;
- wildcard behavior is documented and tested one label at a time;
- path normalization, percent encoding, dot segments, Unicode/punycode, query placement, duplicate headers, and header case cannot widen a binding;
- a client-supplied auth header is overwritten, not combined;
- method restrictions are enforced by a component that actually supports them;
- response headers, redirects, and bodies are scanned for accidental credential reflection before entering the sandbox, or the unsupported risk is documented per provider;
- rate/cost/write budgets stop abuse and create a durable audit event.

### Leakage tests

Seed canary credentials and assert they never appear in controller logs, broker logs, events, transcripts, model prompts, tool results, error objects, database query logs, metrics labels, traces, URLs, diffs, commits, artifacts, or backups created after deletion policy takes effect. Test transformed forms where relevant: URL encoding, Base64, JSON escaping, Basic auth, substrings, and multi-line values. Redaction remains defense in depth even after raw values leave the sandbox.

## Go/no-go gates

The feature is not production-ready until all are true:

- real credentials are absent from the sandbox and all persisted workspace state;
- every supported sandbox provider enforces broker-only egress, or rejects brokered-secret runs;
- run grants are exact-user, exact-repository, exact-service, short-lived, revocable, and fenced;
- management API and proxy ingress are private and mutually authenticated or network-bound;
- encryption uses managed envelope keys with rotation and audited decrypt permission;
- CRUD, use, rotation, revocation, cleanup, and failure events are durable without values;
- no compatibility fallback reinjects the real value;
- hostile repository, redirect, DNS, raw-socket, resume, crash, and cleanup tests pass;
- the UI states residual misuse risk plainly.

## Sources

[^1]: Cognition, [“Secrets & Site Cookies”](https://docs.devin.ai/product-guides/secrets), accessed September 2026.
[^2]: Cursor, [“Secrets & Network”](https://cursor.com/docs/cloud-agent/security-network), accessed September 2026.
[^3]: Anthropic, [“Configure cloud environments — GitHub proxy”](https://code.claude.com/docs/en/cloud-environments#github-proxy), accessed September 2026.
[^4]: Infisical, [Agent Vault repository and README](https://github.com/Infisical/agent-vault), accessed September 2026.
[^5]: Infisical, [“Agent Vault Security”](https://docs.agent-vault.dev/learn/security), accessed September 2026.
[^6]: Infisical, [“Agent Vault Services”](https://docs.agent-vault.dev/learn/services), accessed September 2026.
[^7]: Infisical, [“Agent Vault Container isolation”](https://docs.agent-vault.dev/guides/container-isolation), accessed September 2026.
[^8]: Cursor, [“Cloud Agent Security overview”](https://cursor.com/docs/cloud-agent/security), accessed September 2026.
[^9]: Anthropic, [“Configure cloud environments — API credentials”](https://code.claude.com/docs/en/cloud-environments#add-api-credentials), accessed September 2026.
[^10]: Vercel, [“Safely inject credentials in HTTP headers with Vercel Sandbox”](https://vercel.com/changelog/safely-inject-credentials-in-http-headers-with-vercel-sandbox), February 23, 2026.
[^11]: Vercel, [“Security boundaries in agentic architectures”](https://vercel.com/blog/security-boundaries-in-agentic-architectures), accessed September 2026.
[^12]: E2B, [Sandbox SDK reference](https://e2b.dev/docs/sdk-reference/python-sdk/v2.6.2/sandbox_async), accessed September 2026.
[^13]: E2B, [Enterprise security and deployment](https://e2b.dev/enterprise), accessed September 2026.
[^14]: Infisical, [“Agent Vault agent protocol”](https://github.com/Infisical/agent-vault/blob/main/docs/agents/protocol.mdx), accessed September 2026.
[^15]: Infisical, [“Agent Vault CLI reference”](https://docs.agent-vault.dev/reference/cli), accessed September 2026.

## Repository evidence reviewed

- [`VISION.md`](../VISION.md): brokered, narrowly scoped, short-lived credentials are an explicit product primitive.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md): the controller is trusted; runtime and repository share the untrusted sandbox.
- [`docs/secrets.md`](secrets.md): current GitHub installation tokens and model/plugin credentials remain visible inside the sandbox; redaction is not containment.
- [`apps/controller/secrets/broker.ts`](../apps/controller/secrets/broker.ts): `CredentialBroker` currently shapes environment-variable secrets for each run.
- [`apps/controller/reconcile/provision.ts`](../apps/controller/reconcile/provision.ts): provisioning passes model, VCS, MCP, and callback secrets to `SandboxSpec`.
- [`packages/sandbox/environment.ts`](../packages/sandbox/environment.ts): every `Secret` is deliberately exposed into the sandbox environment at the provider boundary.
- [`packages/sandbox/microsandbox.ts`](../packages/sandbox/microsandbox.ts): current policy default-denies generally but permits public TCP 80/443, so it does not force proxy use.
- [`packages/sandbox/e2b.ts`](../packages/sandbox/e2b.ts): current adapter flattens secrets into E2B command environment variables and does not configure egress restrictions.
- [`packages/runtime/README.md`](../packages/runtime/README.md): the runtime and repository are explicitly one untrusted zone.
