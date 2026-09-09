# Adding an external trigger integration

External systems are clients of the same session API as the dashboard. An integration should translate an event into a validated `SessionCommand`, then let the ordinary controller queue, reconciler, sandbox, checkpoint, and observability paths do the rest. Do not create a provider-specific run loop or an in-memory event bus.

```text
external event
    │ verify + persist delivery
    ▼
provider projection ──► SessionCommand ──► queueSessionCommand()
                                             │
                                             ▼
                                       ordinary run/session
                                             │
                                             ▼
                         structured provider actuator (optional)
```

## The command contract

`packages/protocol/session-command.ts` is the shared input shape. A client provides a repository, prompt, mode, intent, optional model selection, optional `thinkingLevel` (default `medium`), and provider-neutral provenance:

```ts
const command = sessionCommandSchema.parse({
  repo,
  prompt,
  mode: "new_session",
  intent: "general",
  thinkingLevel: "medium",
  provenance: {
    source: "example",
    deliveryId: "provider-delivery-id",
    eventType: "task.created",
    action: "created",
    externalThreadKey: "example:thread:123",
    integrationId: "installed-account-id",
    externalMessageId: "message-456",
    externalActor: "alice",
  },
});
await queueSessionCommand(database, config, { ...command, userId });
```

`externalThreadKey` maps repeated events to one durable session. The message and actor fields are optional context for a provider's reply actuator. Keep them opaque and do not add Slack-, Linear-, or GitHub-specific fields to the shared contract.

## Webhook adapter checklist

Implement the adapter in the trusted controller:

1. Verify the provider signature on the raw request body.
2. Require a provider delivery id and persist the payload in an inbox table before acknowledging it. A unique `(provider, deliveryId)` key deduplicates intake, while the same unique origin on the created run makes recovery after queueing idempotent.
3. Return quickly (GitHub returns `202`); process pending deliveries from the reconciler or another durable worker, and retry transient projection failures with a bounded lease/backoff policy.
4. Ignore unsupported event types/actions, bot senders, and events that do not contain the configured mention or policy signal.
5. Resolve immutable repository coordinates before queueing: owner/name, clone URLs, base/head branches, and exact SHAs. A comment event often omits these, so fetch the current PR revision before creating the command.
6. Project to `SessionCommand` and call `queueSessionCommand`. The adapter must not create sandboxes, parse agent prose, or write provider comments itself.

GitHub is the reference implementation in `apps/controller/integrations/github.ts`:

- `githubWebhookRoutes()` verifies `X-Hub-Signature-256` and stores deliveries.
- `projectGithubEvent()` handles PR review events and mentioned issue/inline review comments.
- `processPendingGithubDeliveries()` claims and projects the durable inbox.
- PR task prompts include the exact head/base revision and expose the typed `reply_github_comment` runtime tool.

## Provider-owned side effects

Agent output that must become an external side effect needs a protocol schema, a runtime tool, an authenticated controller callback, and durable idempotency. For example, GitHub reviews use `submit_github_review`; comment tasks use `reply_github_comment`. The runtime sends structured data only. The controller validates the run's target and calls the provider adapter. Completion is rejected if a required publication was not recorded as successful.

Keep provider credentials in the trusted controller. GitHub publication requires a short-lived App installation token minted with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; the connected user token remains useful for checkout but is never used for publication. Missing App credentials or token-minting failures stop publication. Never pass an App private key to the sandbox.

## Adding another integration

For Slack, Linear, Azure DevOps, or another source:

- add only normalized provenance and any truly provider-neutral schema to `packages/protocol`;
- add a trusted inbox/projection module under `apps/controller/integrations/`;
- reuse `queueSessionCommand` and `Trigger`, including `thinkingLevel`;
- add an actuator only when the agent must reply or mutate the source system;
- add migration, unit, integration, and live contract tests; and
- document webhook verification, permissions, retry/idempotency, and the exact checkout revision requirements.

## Configuration ownership roadmap

Today, integration secrets are process environment variables read by `apps/controller/config.ts`. This is an MVP deployment boundary, not the final organization model. A future trusted admin web and RBAC layer should store organization-scoped integration configuration (for example the GitHub App private key, webhook secret, App id, and allowed installations), encrypt values at rest, restrict read/write access by role, and hand a typed configuration snapshot to the controller. Runs should continue to receive only the short-lived operation capability they need; admin UI data must never be copied into `packages/runtime` or exposed in run events.

Until that layer exists, keep secrets in the server environment, rotate them through deployment configuration, and treat `GITHUB_APP_PRIVATE_KEY` as a controller-only secret.

## GitHub review controls

After installation, the setup callback returns to Settings and the authenticated browser
binds the installation. Settings also discovers installations whose callback was missed; enabling a repository binds an unowned installation without transferring another user's ownership. Enable each repository under **Settings → Repositories**; the
controller verifies current installation access, Contents read and Pull requests write
permissions, server configuration, and the default model before saving. The generated
`github_review_repositories` table is explicit opt-in: no row means off. Deployment of
this MVP therefore requires enabling repositories previously reviewed implicitly.

Automatic reviews handle opened, reopened, ready-for-review and synchronize events,
skipping drafts and bot senders. Turning off stops new automatic review events; queued
or running work continues. Enabling does not backfill existing PRs: open a non-draft PR
or push a new commit to exercise the webhook. Integration runs prefer medium thinking
when the selected model supports it, otherwise off.

**Reviews → Refresh** reads open PRs from GitHub and joins owned delivery/run/publication
records. A missing delivery appears as not reviewed; ignored events retain their reason;
publication failure differs from execution failure. Only a published review for the
current head is labelled Reviewed. Older commits appear Outdated. GitHub read failures
remain visible and never become a successful empty list. There is no background PR
poller, automatic catch-up, manual review endpoint, or publication retry UI in this MVP.
