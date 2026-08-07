# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/zen8labs/pi-cloud-agent/security/advisories/new). If that isn't available to you, email **hi@zen8labs.com**.

Please include, as far as you can:

- what an attacker achieves, not just what the bug is
- the affected component (controller, runtime, a sandbox or VCS provider)
- reproduction steps, a proof of concept, or the commit that introduced it
- the version or commit SHA you tested

What to expect:

| | |
|---|---|
| acknowledgement | within 3 business days |
| initial assessment | within 10 business days |
| fix or mitigation plan | communicated with the assessment |
| credit | offered in the advisory unless you'd rather stay anonymous |

Please give us a reasonable window to ship a fix before disclosing publicly.

## Supported versions

The project is pre-1.0. Only `main` is supported; fixes land there, and there are no backports to tags or older commits.

## Known and accepted limitations

These are documented design gaps, not vulnerabilities. Reporting them is welcome but won't be treated as a new finding. The full reasoning is in [docs/secrets.md](docs/secrets.md).

- **The sandbox holds credentials next to untrusted code.** Each run's sandbox receives one model API key and, when connected, one provider access token in its environment, then runs code from a repository. Once that happens, both credentials are compromised in principle. Redaction is not containment. Moving to a credential broker and an auth-injecting egress proxy, so the sandbox never holds a token, is the intended next step.
- **Provider permissions still need least-privilege review.** GitHub uses a GitHub App with Contents and Metadata permissions; Contents read/write permits repository mutation. Azure DevOps uses Microsoft Entra delegated permissions configured on the Entra app. Review both before operating against sensitive repositories.
- **The controller requires application authentication by default.** GitHub App authorization creates the local user session and every task, run, session, and model connection is user-scoped. `APP_AUTH_REQUIRED=false` permits only local read-only access to public metadata and repositories; task, run, session, and model-connection routes still require a session. Never expose either mode on a public deployment without real authentication. Sandbox callbacks verify a per-run bearer token, so they remain separately authenticated.

## In scope

Anything that breaks a boundary we claim to hold:

- credential exposure beyond what's described above: a token reaching logs, telemetry, an event payload, the dashboard, or another run
- a run's callback token being usable for a different run, or for anything beyond its two endpoints
- a run escaping its own state machine: a terminal decision being overwritten, or a run being claimed twice
- a workflow or provider gaining controller-side privileges it shouldn't have
- anything that lets sandbox-side code reach the controller's database or credential broker
- dependency vulnerabilities that are actually reachable from this code

## Out of scope

- sandbox escape in a third-party provider (report to E2B or the provider)
- the model doing something undesirable when prompted to; prompt injection through repository content is contained by the sandbox, not prevented
- findings that require an already-compromised controller host
- exposing the operator API publicly and then reporting it as unauthenticated
- automated scanner output with no demonstrated impact

## Operator checklist

If you run this yourself:

- keep the controller off the public internet, or put real authentication in front of it
- configure only the GitHub App and Azure DevOps permissions the product needs
- treat every sandbox as hostile after it clones a repository
- rotate the model API key and forge credentials on the schedule you'd use for any production secret
