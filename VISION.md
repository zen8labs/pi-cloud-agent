# A minimal, self-contained, and extensible core for agents that run in the cloud

## The idea

Every team building an agentic product rebuilds the same 80%: a durable queue, an isolated machine, credentials that survive sitting next to untrusted code, and a log someone can replay. The interesting 20% is the prompt, the tools, and the taste. Today you either adopt a vendor's opinion about that 20% and inherit their 80%, or you spend six weeks on the 80% before writing anything interesting.

We want to build the 80% once, in the open, small enough to audit, and hand the 20% back to whoever is using it.

The philosophy comes from [pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), which rethought the *local* coding agent from first principles: strip it to the irreducible parts, refuse the bloat, and make everything else an *extension* you add rather than core you fork. We take that philosophy and Pi's embeddable agent loop, then apply both to a different problem: **cloud agents**.

A *cloud agent* is an agent that runs headless. It's triggered by an event (a PR, a chat message, a schedule), works inside an ephemeral sandbox, and actuates its own outcomes (posts comments, pushes commits) while a human watches the results rather than typing turn by turn.

Today every vendor ships a monolithic cloud agent. We want the opposite: a **minimal, task-agnostic core** that anyone extends into their own vertical (PR review, complete-a-PR, deep research, spreadsheet work…) by dropping in a *profile*, not by rewriting the core. An OSS core, with an ecosystem of profiles on top.

## What a cloud agent is, from first principles

Forget existing products for a moment. If you want a coding agent to do useful work in the cloud without a human driving it, what must exist? Reasoning it out, you land on seven parts:

- **Trigger**: something has to *start* a run. A webhook, an API call, a chat message, a schedule. This is the cloud agent's "prompt": it arrives as an event, not as typing.
- **Sandbox**: the agent needs somewhere to run. Isolated compute with a real checkout of the repo, network, and a shell. Because it will execute untrusted code, this environment is also the security boundary.
- **Harness**: the actual agent loop. Give the model tools, let it read/edit files and run commands, feed results back, repeat until done. This runs *inside* the sandbox, headless.
- **Secret broker**: the agent needs credentials (to clone, to comment, to push), but it's running untrusted code. So something *trusted* must mint scoped, short-lived credentials and hand only those into the sandbox.
- **Actuation**: the run has to change something in the outside world. A PR comment, a commit, a status. The agent does this itself with ordinary tools (`git`, `gh`), the same way a human would.
- **Observability**: no human is watching the loop live, so the run has to be *recorded*, both streamed as it happens and stored for later. This is how you trust, debug, and improve the agent.
- **Profiles**: a way to turn the generic core into a specific job (review this PR, triage this issue) without editing the core. This is the extension surface and the whole point of the project.

Everything we build should slot into one of these seven and stay out of the others.

## What's irreducible

The smallest thing that is still a cloud agent: **a trigger creates a run, a sandbox boots with the repo, the harness runs the model with a handful of tools until it's done, a broker supplies scoped creds, the agent actuates its result, and the whole run is observable.** That's it. A model, file/shell tools, a loop, an isolated box, short-lived creds, and a record of what happened.

Notably *not* irreducible: MCP, sub-agents, to-do plan tracking. Useful sometimes, but they are extensions, not the core.

## What we intentionally don't build (and why)

Saying no is how the core stays small. These are deliberate omissions, not missing features:

- **No controller-side publish step.** The controller does *not* collect structured findings and post them on the agent's behalf. The agent actuates its own outcomes with `git`/`gh` inside the sandbox. Parsing and re-structuring agent output on the controller is brittle, strips the agent's agency, and duplicates work the model already does well. (We used to have this; we removed it. This doc just names the principle.)
- **No baked-in MCP.** MCP is opt-in per profile, never in the kernel. A popular MCP server can burn 7–9% of the context window on tool descriptions before any work starts. Default runs carry zero MCP servers; a profile that genuinely needs one declares it, and it runs inside the sandbox boundary. Prefer a CLI tool with a README the agent reads on demand (progressive disclosure).
- **No baked sub-agents / plan mode / to-dos.** These add hidden state the model has to track and hurt observability. If a vertical wants them, it builds them as an extension or writes a plan/TODO file in the repo.

The one place we are *not* minimal, because the cloud makes it real: **a credential with write access to someone else's repo, sitting next to untrusted code.** That risk is handled properly (brokered, narrowly scoped, and short-lived) rather than waved away.

## The bet

If pi is right that a coding agent can be tiny and still excellent, a cloud agent can be too. Build the smallest correct core, make the extension surface delightful, and let an ecosystem grow the verticals.

The bet pays off in two directions at once. Someone who wants a specific agent (their review standards, their model, their infrastructure) writes a profile instead of a backend. And someone who wants to *understand* how a background agent works can read the whole thing in an evening, which is also the only honest reason to trust it with a credential.
