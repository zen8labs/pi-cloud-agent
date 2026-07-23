---
name: build-pr-review-agent
description: Builds or rebuilds the PR-review profile and its cloud runtime. Use when implementing the CoReview review path from webhook through E2B, embedded Pi, and direct VCS actuation.
---

# Build the PR Review Agent

Start with `VISION.md` and `ARCHITECTURE.md`. Preserve the two-zone design:
trusted controller, untrusted ephemeral sandbox.

## Target flow

```text
verified webhook → queued Run(profile=pr_review) → worker claim
→ scoped credentials → E2B sandbox → checkout at PR head
→ pr_review SKILL.md + concrete task prompt → embedded Pi session
→ Pi inspects diff and posts through gh → outbound events → terminal status
```

## Build order

1. Implement provider webhook verification and normalize it to `RepoRef` fields.
2. Persist a queued run and return `202` immediately.
3. Implement `profiles/pr_review/task.py` without profile branches in the core.
4. Write a high-signal `SKILL.md` that limits findings to PR-introduced issues
   and makes the agent post its own review through authenticated `gh`.
5. Provision E2B with only run config and required short-lived secrets.
6. Let `runtime/supervisor.py` clone, optionally set up, and launch Pi once.
7. Persist native token/tool/status events and always stop the sandbox.

## Invariants

- The controller never runs repository code.
- The controller never parses findings or publishes review output.
- The sandbox never accepts inbound controller connections.
- Subscribe to the event bus before creating the sandbox.
- Pi completion/status is authoritative; telemetry does not infer completion.
- The profile does not know E2B, Postgres, or credential implementation details.
- No MCP, subagents, or custom server unless a measured need justifies them.

## Validation

```bash
cd agent
pytest -m "not live" -q
ruff check core profiles runtime tests
pytest tests/test_harness_live.py -m live -q -s
```

For a complete proof, publish the template, run the controller behind a URL the
sandbox can reach, create a `pr_review` run on a repository authorized for the
configured VCS app, and verify terminal state, real tool events, direct review
actuation, and sandbox deletion.
