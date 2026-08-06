# Model connections

## Current contract

Authenticated users choose a model connection in Settings. A connection records the endpoint type, API shape, available model catalog, limits, and an encrypted credential. OAuth creates one connection for the authenticated provider and stores Pi's model catalog on that connection; it does not create one connection per model. The endpoint type derives the internal provider ID and API format, so users do not need to enter either identifier manually. The controller resolves the selected connection and model for every turn and snapshots it on the run. A session retains the latest selection as display metadata, but it does not pin future turns to that model.

Re-authenticating the same OAuth provider retires its current connection revision and creates a new active revision. Settings still shows one connection per provider, while queued runs retain the exact encrypted credential and catalog revision they resolved at submission. New turns see only the new revision.

Deleting a connection removes it from the active Settings list immediately. Runs that are already queued or running keep their historical model snapshot and credentials. On resume, the dashboard loads the current catalog and keeps the latest turn's model when it is still available; otherwise it selects the current default connection. The explicit visible selection is included in the new turn request. Unreferenced deleted rows are physically purged; referenced rows remain as tombstones until their historical references are gone.

API-key connections support OpenAI-compatible Chat Completions, OpenAI Responses, and Anthropic Messages endpoints. LiteLLM works when its proxy exposes one of the supported OpenAI-compatible APIs. The Test action sends one minimal request using the selected API format, endpoint, model, and credential: `POST /chat/completions`, `POST /responses`, or `POST /messages` with a one-token budget. It is a real provider request and may count as usage; a non-2xx response is shown to the user instead of being reported as success.

Pi's native ChatGPT OAuth provider is exposed as a ChatGPT Codex subscription connection button. Pi owns the provider login and token refresh. The browser receives only short-lived OAuth-flow events; the controller stores the resulting credential encrypted.

Every task resolves a user-owned model connection. There is no deployment-wide model credential.

Each OAuth model also advertises its available thinking levels from Pi's provider catalog. Custom API-key endpoints expose only `off` because the supported APIs do not provide a portable way to discover or map thinking parameters; provider-specific adapters can add that capability later without asking users to guess. The controller rejects a level outside the selected model's catalog. The chosen level is stored on the run and passed to Pi, so historical runs remain explainable and resumed sessions may change model and thinking level independently.

## Sandbox handoff and future vault migration

Today the trusted controller's `CredentialBroker` decrypts the selected model credential and injects the minimum values into the sandbox environment. API-key connections receive `LLM_API_KEY`; Pi OAuth connections additionally receive `LLM_AUTH_TYPE=oauth` and `LLM_AUTH_JSON`; every run receives its validated `LLM_THINKING_LEVEL`. The runtime writes the OAuth credential only to a run-scoped temporary Pi auth file and removes it when the process exits; it is not part of the parked session state. This is still not containment: repository code and the agent can read any credential visible to their process during the turn.

When a vault is introduced, preserve the reconciler-facing `CredentialBroker` interface and replace the implementation behind it. The likely target is:

1. Controller authorizes a run-scoped lease for a provider/model and records only a lease reference on the run.
2. Sandbox uses a controller-issued, short-lived `RUN_CALLBACK_TOKEN` to request a narrow model operation or an ephemeral credential from a broker endpoint.
3. The broker checks user, run, provider, repository, expiry, and operation policy before resolving a vault secret.
4. The model egress proxy or provider adapter keeps the reusable credential outside the sandbox; the sandbox sees only a short-lived capability or proxied response stream.

The vault migration must also decide where OAuth refresh occurs. Keeping refresh in the controller/vault service makes revocation and audit straightforward. Keeping refresh in Pi preserves provider-specific logic but requires a secure credential exchange and a way to persist rotated refresh tokens. Do not add a second secret store without defining ownership, rotation, revocation, audit events, and failure recovery.

## OAuth flow notes

The current OAuth browser bridge is an in-memory, short-lived flow manager with an SSE event stream and an input endpoint. A flow expires after ten minutes, and starting another sign-in for the same user and provider supersedes the previous attempt. Expiry aborts Pi's login so provider-side listeners and pending prompts are released. The bridge is suitable for a single controller instance and interactive login, but it is not restart-safe or horizontally scalable. Before multiple controller replicas, move flow state and pending challenges to shared durable storage, bind state to the authenticated user and an expiry, and route callbacks/events through a shared job or broker. Never put access or refresh tokens in query parameters, browser local storage, logs, or event history returned to the UI.

ChatGPT/Codex browser login currently follows Pi's local callback flow. That is appropriate when the browser and controller share the callback host, but a hosted deployment needs a public callback relay or a supported device-code flow before this can be treated as a general multi-user connection path.

The Pi dependency is intentionally kept in the trusted controller only for the login orchestration and in the sandbox runtime for provider execution. If Pi changes its provider auth contract, update this adapter rather than spreading Pi-specific types through the protocol package.
