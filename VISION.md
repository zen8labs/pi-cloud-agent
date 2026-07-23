# Cloud Agent — a minimal, extensible core for agents that run in the cloud

> Borrowing the pi philosophy: build the smallest correct core, and make
> everything else an extension.

## The idea

[pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) rethought the
local coding agent from first principles: strip it to the irreducible parts,
refuse the bloat, and make everything else an *extension* you add rather than
core you fork. The result is small enough to understand in an afternoon and
extensible enough that power users can grow it into whatever they need.

We're taking that philosophy and Pi's embeddable agent loop, then applying both
to a different problem: **cloud agents**.

A *cloud agent* is a coding agent that runs headless. It's triggered by an event
(a PR, a chat message, a schedule), works on a real checkout inside an ephemeral
sandbox, and actuates its own outcomes (posts comments, pushes commits) while a
human watches the results rather than typing turn by turn.

Today every vendor ships a monolithic cloud agent. We want the opposite: a
**minimal, task-agnostic core** that anyone extends into their own vertical (PR
review, complete-a-PR, deep research, spreadsheet work…) by dropping in a
*profile* — not by rewriting the core. An OSS core, with an ecosystem of profiles
on top.

## What a cloud agent is, from first principles

Forget existing products for a moment. If you want a coding agent to do useful
work in the cloud without a human driving it, what must exist? Reasoning it out,
you land on seven parts:

- **Trigger** — something has to *start* a run. A webhook, an API call, a chat
  message, a schedule. This is the cloud agent's "prompt": it arrives as an
  event, not as typing.
- **Sandbox** — the agent needs somewhere to run: isolated compute with a real
  checkout of the repo, network, and a shell. Because it will execute untrusted
  code, this environment is also the security boundary.
- **Harness** — the actual agent loop: give the model tools, let it read/edit
  files and run commands, feed results back, repeat until done. This runs
  *inside* the sandbox, headless.
- **Secret broker** — the agent needs credentials (to clone, to comment, to
  push), but it's running untrusted code. So something *trusted* must mint
  scoped, short-lived credentials and hand only those into the sandbox.
- **Actuation** — the run has to change something in the outside world: a PR
  comment, a commit, a status. The agent does this itself with ordinary tools
  (`git`, `gh`), the same way a human would.
- **Observability** — no human is watching the loop live, so the run has to be
  *recorded* — both streamed as it happens and stored for later. This is how you
  trust, debug, and improve the agent.
- **Profiles** — a way to turn the generic core into a specific job (review this
  PR, triage this issue) without editing the core. This is the extension surface
  and the whole point of the project.

Everything we build should slot into one of these seven and stay out of the
others.

## What's irreducible

The smallest thing that is still a cloud agent: **a trigger creates a run, a
sandbox boots with the repo, the harness runs the model with a handful of tools
until it's done, a broker supplies scoped creds, the agent actuates its result,
and the whole run is observable.** That's it. A model, file/shell tools, a loop,
an isolated box, short-lived creds, and a record of what happened.

Notably *not* irreducible: MCP, sub-agents, plan mode, to-do tracking, a
retrieval index, a permissions UI, controller-side output parsing. Useful,
sometimes — but they are extensions, not the core.

## What we intentionally don't build (and why)

Saying no is how the core stays small. These are deliberate omissions, not
missing features:

- **No controller-side publish step.** The controller does *not* collect
  structured findings and post them on the agent's behalf. The agent actuates
  its own outcomes with `git`/`gh` inside the sandbox. Parsing and re-structuring
  agent output on the controller is brittle, strips the agent's agency, and
  duplicates work the model already does well. (We used to have this; we removed
  it — this doc just names the principle.)
- **No baked-in MCP.** MCP is opt-in per profile, never in the kernel. A popular
  MCP server can burn 7–9% of the context window on tool descriptions before any
  work starts. Default runs carry zero MCP servers; a profile that genuinely needs
  one declares it, and it runs inside the sandbox boundary. Prefer a CLI tool
  with a README the agent reads on demand (progressive disclosure).
- **Minimal system prompt.** Frontier models are already trained to be coding
  agents. We don't ship thousands of tokens of instructions; the vertical's
  behavior comes from its profile (a skill/prompt), loaded when relevant.
- **The sandbox is the security model — no controller-side guardrails.** Once an
  agent can write and run code, permission prompts and output-scanning are mostly
  theater. We don't pretend otherwise. Safety comes from the sandbox being
  isolated, ephemeral, and network-scoped, plus the one control that genuinely
  matters in the cloud (below).
- **No baked sub-agents / plan mode / to-dos.** These add hidden state the model
  has to track and hurt observability. If a vertical wants them, it builds them
  as an extension or writes a plan/TODO file in the repo.

The one place we are *not* minimal, because the cloud makes it real: **a
credential with write access to someone else's repo, sitting next to untrusted
code.** That risk is handled properly — brokered, narrowly scoped, and
short-lived — rather than waved away.

## Observability is two things

Because nobody watches the loop live, "record the run" splits into two distinct
needs, and we want both:

1. **Live stream (the web UI).** While a run is working, its output — messages,
   tool calls, results — streams to a dashboard so a human can watch, follow
   along, and step in. This is the real-time "watch it work" view.
2. **Trace store (Langfuse-style).** Every run is also persisted as structured
   traces to a data store, so we can browse and replay *all* past sessions,
   debug failures after the sandbox is gone, and use real runs to improve the
   agent over time (prompts, tools, evals, regression tracking). This is the
   long-term memory of how the agent behaves.

The live stream is for *this* run; the trace store is for *every* run.

## Where we are today

A working MVP that proves the pipeline end to end:

```
trigger (webhook) → controller (FastAPI + worker, Postgres queue)
        → mint scoped SCM token → E2B sandbox → agent loop
        → agent reviews the checkout and posts its own PR comments
        → live events streamed to the controller + web dashboard
```

- **Clean seams already exist.** Infrastructure sits behind `VCSProvider` and
  `SandboxProvider`; `Profile` turns triggers into `TaskSpec`. Pi is embedded
  inside the sandbox rather than represented by controller-side session glue.
- **Two profiles:** `pr_review` (GitHub / GitLab / Bitbucket) and a free-form
  `general_agent`.
- **Already trending this way:** we dropped the structured-output publish path
  and the MCP tool — the agent now actuates its own outcomes. Good instinct; we
  just hadn't named the principle.

The OpenCode server and its bridge workarounds have been removed. The sandbox
now embeds Pi directly, and Pi's native session events feed the same durable
event stream used by the dashboard.

## What's next

**0. Restructure — bet on Pi, drop OpenCode. Complete.** Pi runs as a one-shot
embedded session in each sandbox. There is no agent server, inbound sandbox
connection, or controller-side harness session to coordinate.

**1. Core agent capabilities.** Make the agent smarter without bloating the
kernel: first-class Skills, opt-in MCP, and grounding experiments (code-graph /
retrieval so the agent understands code by structure, not blind grep).

**2. Integrations.** Meet teams where they work — trigger from and report back to
Slack, Microsoft Teams, Linear, and more, each a thin adapter on the same core.

**3. Advanced runtime.** The infrastructure that makes it feel fast and powerful:
sandbox boot-time optimization, more sandbox backends, an in-app browser, and the
runtime capabilities leading agents ship — each built as an opt-in tool, the
pi way.

## The bet

If pi is right that a coding agent can be tiny and still excellent, a cloud
agent can be too. Build the smallest correct core, make the extension surface
delightful, and let an ecosystem grow the verticals. Power users get a cloud
agent shaped exactly to their workflow — fully customized, fully featured, and
theirs.
