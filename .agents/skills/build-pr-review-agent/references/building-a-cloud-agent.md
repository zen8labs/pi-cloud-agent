# Building a cloud coding agent — patterns & rationale

Deep background for `agent/`. Read when designing a new capability, changing the
sandbox/harness lifecycle, or reasoning about *why* the architecture is shaped
this way. Each pattern lists the reasoning **and our implementation status**
(done / deferred / different), so you know what's load-bearing vs aspirational.

Primary source: Ramp's "Why we built our background agent"
(https://builders.ramp.com/post/why-we-built-our-background-agent) and the
`ref/background-agents` (Open-Inspect) reference implementation.

## Contents
1. Agentic-in-sandbox vs one-shot (the thesis)
2. Process model: controller / sandbox / supervisor+bridge / harness
3. Sandbox lifecycle & latency economics
4. Git auth: brokered short-lived tokens
5. Read-during-sync (large repos)
6. Untrusted-code isolation
7. Reliability, observability, failure modes
8. Sub-agents & fan-out
9. What we deferred (roadmap)

---

## 1. Agentic-in-sandbox vs one-shot — the thesis
A one-shot reviewer (stuff the diff into one prompt → parse → comment) is
context- and verification-starved: it can't read across files, run a linter, or
check a test, so it hallucinates and misses real bugs. The agentic bet: put a
capable model **in a loop with tools, on a real checkout, in a sandbox**, and it
self-corrects — "limited only by model intelligence, not by missing context or
tools." For review specifically: pull surrounding code on demand, run
linters/tests, then **ground** each finding against the actual file/command
output before posting. The deprecated `../pr-agent` is the one-shot baseline we
replaced; `agent/` is the agentic version.

**Design implication:** invest in *tools and verification*, not bigger prompts.
Findings without evidence are speculation — require a read-range or command
output (our `report_finding` MCP tool enforces this).

## 2. Process model: controller / sandbox / supervisor+bridge / harness
Four roles, two trust zones (see SKILL.md for the diagram):
- **Controller** (`core/`, your VPC): coordinator + trust boundary. Holds
  secrets, brokers tokens, queues runs, publishes results. Runs no untrusted code.
- **Sandbox** (E2B microVM): ephemeral compute with the repo + dev tools.
- **Supervisor** (`runtime/entrypoint.py`, PID-equivalent in the sandbox): clones,
  configures git, starts the harness, drives the review, monitors with backoff.
- **Bridge** (`runtime/bridge.py`): the harness↔controller link. **It dials the
  controller outbound** (HTTP POST to `/internal/runs/{id}/…`), rather than the
  controller reaching in. Outbound-dial is the key choice: it works through NAT/
  firewalls and means the sandbox needs no inbound exposure.
- **Harness** = OpenCode, **server-first** (REST + `/event` SSE). Why a
  server-first, open-source harness: you can drive it from any controller, build
  many clients later, and — crucially — the agent can read the harness's own
  source to resolve ambiguous behavior instead of hallucinating it. Don't build a
  bespoke agent loop; drive a real one behind `HarnessAdapter` so it's swappable.

## 3. Sandbox lifecycle & latency economics
The expensive work (clone, dependency install, build) is amortized into a
**prebuilt image**, so per-session start is cheap. Ramp's ladder, fastest last:
- **Prebuilt per-repo images**, rebuilt on a cadence (~30 min) so the checkout is
  at most ~30 min stale.
- **Filesystem/memory snapshots**: freeze a ready sandbox, restore near-instantly.
- **Warm pools** for high-volume repos; **warm-on-typing** (start provisioning as
  the user types the prompt) so the env is ready before they hit enter.
- Net effect: sessions are "fast to start and effectively free to idle," which
  changes behavior — run several variants, swap models, fire-and-forget overnight.

**Our status:** we build one template (`make sandbox-template`, image
`coreview-agent`) and create a fresh sandbox per run. E2B supports
`pause`/`resume` + snapshots, but **warm pools / snapshot-restore / per-repo
prebuilt-with-deps / warm-on-trigger are DEFERRED** (see §9). Today's start cost
is "boot template + clone + `npm`/OpenCode already baked." First optimization
when latency matters: per-repo images with deps prebuilt + a small warm pool.

## 4. Git auth: brokered short-lived tokens (no baked secrets)
Never bake a git token into the sandbox. Mint a **fresh short-lived GitHub App
installation token per clone**, brokered from the controller on demand via a git
**credential helper** — so the sandbox running untrusted code never holds a
long-lived secret, and the token's blast radius is one run. Implemented:
`runtime/git_credential_helper.py` (git's credential protocol) → controller
`/internal/runs/{id}/git-credentials` → `core/vcs/*.mint_clone_token`.

**App-token vs user-token (important):** clone/read uses the **App installation
token** (bot identity) — right for a review bot that posts comments. Writing code
attributed to a human (commits, PR creation) should use that **user's OAuth
token**, not the app's. Mixing them lets a user effectively approve their own
unreviewed code via the bot — a privilege-escalation vector. We are review-only
(bot identity); a future "complete-a-PR" bundle that pushes/opens PRs must add
per-user OAuth + attribution.

## 5. Read-during-sync (large repos)
To cut latency on big monorepos: let the agent **start reading immediately** while
the base-branch sync finishes in the background, but **block writes/edits until
sync completes** (a recent file is unlikely to collide; reads are safe, writes
aren't). OpenCode makes this a plugin on the `tool.execute.before` event.
**Our status: not applicable yet** — we clone the exact head SHA up front (no
background sync). Adopt this only if/when we move to prebuilt-image + delta-sync.

## 6. Untrusted-code isolation
The sandbox runs PR-author code, so treat it as hostile: ephemeral per-run VM,
**non-root user** (everything it writes must be user-writable — `/workspace`,
`/tmp/...`, never root-owned `/run`), egress allowlist, hard CPU/mem/wall caps,
and **no secrets except the LLM keys the agent genuinely needs**. Git creds are
brokered (§4); the per-run `SANDBOX_AUTH_TOKEN` is the only bearer the sandbox
holds, scoped to that run's callbacks. The LLM-keys-in-sandbox exposure is
mitigated by egress + ephemerality; the planned hardening is a controller-side
LLM proxy (DEFERRED).

## 7. Reliability, observability, failure modes
- **Observability is not optional** for a detached agent. The sandbox's stdout is
  invisible (E2B's Logs tab shows only the template start command), so the
  supervisor **forwards its own log lines to the controller** as `log` events,
  streamed to the dashboard Sessions live log. This is the primary debug surface.
- **Killswitch / cancel**: always be able to stop a run mid-flight. We have
  `POST /runs/{id}/cancel` (stops the sandbox + marks cancelled) + the Sessions
  Kill button.
- **Orphan reconciliation**: completion logic lives in-process, so a controller
  restart (or an externally-killed sandbox) would strand a run as `running`
  forever. On boot we mark in-flight runs `failed` (`reconcile_orphaned_runs`).
  An externally-killed sandbox isn't auto-detected — a heartbeat reaper is
  DEFERRED; use cancel/restart.
- **Fail fast + surface the reason**: a terminal error from the supervisor must
  end the controller's run loop (not wait out the wall-clock) and land in
  `run.error`. Don't let failures hang.
- **North-star metric**: track *merged PRs influenced* (or, for review,
  findings-acted-on), not raw run counts — it's the signal that the agent
  produces value. (Not yet instrumented.)
- **Queued follow-ups, resume from snapshot, voice, multiplayer** — Ramp niceties
  we intentionally dropped for a headless review bot.

## 8. Sub-agents & fan-out
For large PRs, split into independent review units and **fan out reviewer
subagents in parallel**, then aggregate + run a critic/grounding pass. Keep this
*declarative in the bundle's skill/subagents* (the harness spawns them), not as
controller code — that keeps the core task-agnostic. Frontier models self-limit
spawning; bound it with run limits rather than elaborate quotas. (Our
`pr_review` skill is structured for this; heavy parallel child-sandbox fan-out is
DEFERRED.)

## 9. What we deferred (roadmap, roughly in priority order)
- **Triage gate**: cheaply decide review depth (or skip) before booting a sandbox.
- **Latency**: per-repo prebuilt images with deps, snapshot-restore, warm pools,
  warm-on-trigger (§3).
- **Heartbeat reaper** for externally-killed/stuck sandboxes (§7).
- **Controller-side LLM proxy** so LLM keys never enter the sandbox (§6).
- **Parallel child-sandbox fan-out** for very large PRs (§8).
- **Knowledge base** (learnings fed back into review) — dropped from the old
  system, to be redesigned as MCP tools.
- **Value metrics** instrumentation (§7).

When picking up any of these, update this file's status markers so it stays an
honest map of done-vs-aspirational.
