# Secrets

## What is actually true

The sandbox receives, in its environment:

- one model API key
- one forge token, scoped to a single repository and short-lived when the forge supports that

And then it runs code from a repository. **Once that happens, both credentials are compromised in principle.** No amount of wrapping, redaction, or care inside the sandbox changes that. The controls that matter are:

| Control | Status |
|---|---|
| narrow scope (one repository) | yes, with a GitHub App |
| short TTL (~1 hour) | yes, with a GitHub App |
| isolation (one workspace per standalone run or durable session; never reassigned) | yes |
| process memory discarded between session turns | yes, for the E2B filesystem-only pause |
| the sandbox never holding the token at all | **not yet**: see below |

A GitHub App is preferred for exactly this reason. A personal access token is accepted so a local setup works without registering an App, and it is strictly worse: broad and long-lived. GitLab has no mintable equivalent, so its token is a PAT, worth knowing before pointing it at a sandbox.

## What the code does

### One model, one key

The single configured model means there is exactly one model credential. There is no provider matrix, so there is no way to hand a sandbox a key for a model it is not using. The previous implementation had a function documented as returning "only the provider credentials required by `model_id`" that then appended every provider key it could find in the environment. That class of bug is gone by deletion, not by fixing.

### `Secret` makes leaks a type error

`packages/protocol/secret.ts`. The value lives in a `#private` field, and every implicit conversion redacts:

```ts
const token = new Secret(value, "github token");

`${token}`               // "[redacted github token]"
JSON.stringify({ token }) // {"token":"[redacted github token]"}
token.expose()            // the value, the only way to get it
```

It is opened at exactly one place: the sandbox provider boundary (`create` or `resume`), where credentials have to become plain strings to cross into the machine. This is not a security boundary; it is a guardrail that turns the accidental paths (string interpolation, serialization, a log line built from a template) from a code-review question into a compile-or-test failure.

### Redaction happens where the secrets are known

The sandbox is the only side that knows every credential in play, so it is the side that scrubs. `packages/runtime/reporter.ts` builds a redactor over its own environment and runs every outgoing event through it, including nested tool arguments and output.

Secret variables are matched by name, `/(TOKEN|API_KEY|SECRET|PASSWORD)$/`, rather than listed, so a credential introduced by a future provider is redacted by default instead of by remembering to update a list.

The controller adds a second, cheap pass on ingest that strips `user:token@` out of URLs, because git produces those constantly and a stray remote URL in an error message is the most common accidental leak.

### The callback token is not a credential for anything else

Each run gets a random 32-byte bearer token, compared in constant time. It authenticates events, terminal status, and that active session turn's checkpoint read/write routes for exactly one run. It cannot read another run or overwrite a stale session head.

### Durable session state is sensitive

A parked filesystem may contain arbitrary repository data, and Pi's JSONL checkpoint may contain prompts, source excerpts, tool arguments, and tool output. They have the same trust classification. E2B suspension retains only the filesystem, not process memory; every turn gets fresh credentials. The git helper stores environment-variable references rather than token values, but untrusted repository code can deliberately write any credential it sees, so a workspace is never reused across sessions and is deleted after `SESSION_WORKSPACE_RETENTION_SECONDS`.

The checkpoint is size-limited, stored without interpretation, and available only to the active run through its per-run bearer token. A production deployment should encrypt database storage and backups and apply a session deletion/retention policy appropriate to the repository data.

## Where this is going

The current design hands a token to code we do not trust. The fix is not better redaction; it is not giving it the token:

1. **A git credential helper backed by a broker.** The sandbox asks for credentials per operation instead of holding them in its environment.
2. **An egress proxy that injects auth.** Requests leave the sandbox unauthenticated and the proxy adds credentials for allowed destinations. The sandbox never has a token at all, and the allowlist becomes enforceable.

This is the shape of [Infisical's agent-vault](https://github.com/Infisical/agent-vault).

`CredentialBroker` in `apps/controller/secrets/broker.ts` exists so this is a second implementation rather than a refactor of everything that calls it. It has one method:

```ts
mintForRun({ provider, repoFullName, host, vcs }): Promise<RunCredentials>
```

## Rules when changing anything here

- Never widen `Secret` with a getter that returns the value implicitly. `expose()` is deliberately ugly to call.
- Never log a `RunCredentials` object, even though it would currently redact. Rely on scope, not on the wrapper.
- Anything new that the sandbox reads and that is a credential must end in `TOKEN`, `API_KEY`, `SECRET`, or `PASSWORD`, so the runtime's redactor picks it up without being told.
- New event payload fields carrying tool output must pass through the reporter's scrubber, which walks nested structures. Do not add a second send path.

## The operator API has no authentication

This is a deliberate gap in this phase, not an oversight. The `/runs` and `/sessions` operator APIs have no authentication because the intended deployment is localhost or a private network. Adding a half-designed auth layer would give a false sense of protection.

**Do not expose the controller publicly without adding real authentication first.** The sandbox callbacks verify a per-run token, so they are safe to expose; the operator API is not.

## Where this is tested

- `packages/protocol/secret.test.ts`: every implicit-conversion path, the longest-match redactor, and URL credential stripping
- `packages/runtime/reporter.test.ts`: secrets do not survive telemetry, however deeply nested, and are stripped from failure details
- `apps/controller/http/api.integration.test.ts`: a callback token is useless for any run but its own; leaked URL credentials are scrubbed on ingest
