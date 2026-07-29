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

The project is pre-1.0. Only `main` is supported — fixes land there, and there are no backports to tags or older commits.

## Known and accepted limitations

These are documented design gaps, not vulnerabilities. Reporting them is welcome but won't be treated as a new finding. The full reasoning is in [docs/secrets.md](docs/secrets.md).

- **The sandbox holds credentials next to untrusted code.** Each run's sandbox receives one model API key and one forge token in its environment, then runs code from a repository. Once that happens, both credentials are compromised in principle. The controls that matter are scope (one repository), TTL (~1 hour with a GitHub App), and isolation (one machine per run, destroyed after) — not redaction. Moving to a credential broker and an auth-injecting egress proxy, so the sandbox never holds a token, is the intended next step.
- **A personal access token is worse than a GitHub App.** PATs are accepted so a local setup works without registering an App. They are broad and long-lived. GitLab has no mintable equivalent, so its token is always a PAT.
- **The operator API has no authentication.** `POST /runs` and `GET /runs` are unauthenticated because the intended deployment is localhost or a private network. **Do not expose the controller publicly without adding real authentication first.** Webhook routes verify signatures and sandbox callbacks verify a per-run bearer token, so those are safe to expose; the operator API is not.

## In scope

Anything that breaks a boundary we claim to hold:

- credential exposure beyond what's described above — a token reaching logs, telemetry, an event payload, the dashboard, or another run
- a run's callback token being usable for a different run, or for anything beyond its two endpoints
- webhook signature verification accepting a forged or replayed delivery
- a run escaping its own state machine: a terminal decision being overwritten, or a run being claimed twice
- a profile or provider gaining controller-side privileges it shouldn't have
- anything that lets sandbox-side code reach the controller's database or credential broker
- dependency vulnerabilities that are actually reachable from this code

## Out of scope

- sandbox escape in a third-party provider (report to E2B or the provider)
- the model doing something undesirable when prompted to — prompt injection through repository content is contained by the sandbox, not prevented
- findings that require an already-compromised controller host
- exposing the operator API publicly and then reporting it as unauthenticated
- automated scanner output with no demonstrated impact

## Operator checklist

If you run this yourself:

- keep the controller off the public internet, or put real authentication in front of it
- prefer a GitHub App over a PAT, and scope it to the repositories you actually need
- set webhook secrets, and confirm signature verification is on
- treat every sandbox as hostile after it clones a repository
- rotate the model API key and forge credentials on the schedule you'd use for any production secret
