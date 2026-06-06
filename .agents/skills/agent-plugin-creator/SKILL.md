---
name: agent-plugin-creator
description: >
  Design and scaffold new capability bundles for the Cloud-Agent system, extending it into new
  vertical domains (finance, BA, growth, HR, security, etc.). Use when the user wants to add a new
  agent bundle, create a new vertical use-case for the agent, or add domain-specific automated
  review/analysis workflows. Triggers on phrases like "new bundle", "create a bundle for X",
  "add a {domain} agent", "extend the agent to do X", or any request to give the agent a new
  capability domain.
---

# Bundle Creator

This skill guides you through designing and scaffolding a new bundle for the Cloud-Agent system.
Bundles are vertical capability plugins — they give the agent a specialized role (PR reviewer,
finance analyst, BA assistant, growth analyst, etc.) without touching the core orchestrator.

Full anatomy reference: [bundle-anatomy.md](references/bundle-anatomy.md)

## Phase 1 — Discovery (do this before writing any code)

Interview the user with the questions below. Ask them in natural conversation, not as a form.
Group related questions together; don't fire them all at once. Adapt based on answers.

### 1a. Domain & trigger

- What domain or team is this bundle for? (finance, BA, growth, HR, DevOps, security, …)
- What should trigger it? Options:
  - **PR/MR webhook** — runs on every pull request (like pr_review)
  - **On-demand API call** — triggered manually or by a script
  - **Scheduled** — runs on a cron-like schedule (not yet supported natively; note this)
- If PR-triggered: what repo events should fire it? (opened, synchronize, labeled?)
- If on-demand: what does the caller pass in? (a document, a URL, a ticket ID, free text?)

### 1b. Workflow & output

- Walk me through what the agent should *do* step by step. What does success look like?
- What should the agent produce at the end?
  - Inline PR comments / annotations?
  - A written report posted somewhere?
  - A structured JSON payload sent to an external service?
  - A file committed back to the repo?
- Are there multiple phases (e.g., analysis → review → summarise)?
- Should any phases be parallelisable (fan-out to multiple subagents)?

### 1c. Tools & data sources

- What data does the agent need to read? (code diff, docs, database, external API, Jira, Slack…)
- Does the agent need write access to the repo (edit/create files) or is it read-only?
- Are there any external services it must call? (Slack, Notion, Linear, an internal API…)
- Does it need any custom output tools (like `report_finding.js` in pr_review)?

### 1d. Agent design

- Should there be specialist subagents (like reviewer + critic in pr_review), or a single agent?
- If multi-agent: what is each subagent responsible for?
- What model behaviour matters most — speed, depth, or cost?
- Are there hard constraints? (must not modify files, must always cite evidence, etc.)

### 1e. Examples (most valuable input)

- Can you share an example of a task this agent would handle end-to-end?
- What would a *good* output look like? What would a *bad* output look like?
- Is there an existing human workflow this replaces or augments?

---

## Phase 2 — Design synthesis

After the interview, summarise your understanding back to the user:

1. **Bundle name** — kebab-case, short, descriptive (e.g., `finance-review`, `ba-assist`, `growth-analyst`)
2. **Trigger type** — webhook event, on-demand, etc.
3. **Agent flow** — numbered phases with agent/subagent responsibilities
4. **Structured output** — schema fields if the bundle emits structured findings
5. **Custom tools** — any plugin tools or MCP servers needed
6. **File permissions** — read-only vs. read-write in the sandbox

Ask the user to confirm or correct before generating any files.

---

## Phase 3 — Scaffold

Generate files in this order. Read [bundle-anatomy.md](references/bundle-anatomy.md) for exact
file patterns, env vars, and registration steps.

### Required files (every bundle)

1. `agent/bundles/{name}/__init__.py` — empty or one-line docstring
2. `agent/bundles/{name}/bundle.py` — implement `Bundle` protocol, call `register_bundle()`
3. `agent/bundles/{name}/task.py` — `build_task(trigger) → TaskSpec`
4. `agent/bundles/{name}/opencode/opencode.jsonc` — model, permissions, tools config

### Conditional files

| Add when | File |
|---|---|
| Structured output (e.g., findings) | `schema.py` |
| Custom tool the agent calls | `tools/__init__.py` + `tools/{name}.js` |
| Main orchestration prompt | `opencode/skills/{skill_name}/SKILL.md` |
| Delegated subagents | `opencode/subagents/{name}.md` (one per subagent) |

### Wiring

After creating the files, add the bundle module to `_import_builtin_bundles()` in
`agent/core/bundles.py` so the orchestrator can discover it.

---

## Phase 4 — Skill & subagent prompts

This is the highest-leverage work. Prompts drive all agent behaviour.

**SKILL.md (main skill)** — write as a skill the OpenCode agent activates:
- Open with the agent's role and what triggers this skill
- Declare a phased flow: number each phase, name inputs/outputs
- Specify exactly when to call subagents (`/agent {name}`) and what to pass
- Specify exactly when to call custom tools and what fields are required
- End with quality criteria (what makes output acceptable)

**Subagent prompts** — write as focused single-responsibility agents:
- One paragraph role description
- Explicit input format (what the parent passes)
- Step-by-step process
- Explicit output format (what the parent expects back)
- Hard constraints (must cite line numbers, must not invent data, etc.)

Treat prompt quality with the same rigour as code quality. Vague prompts produce inconsistent agents.

---

## Phase 5 — Validation checklist

Before calling the bundle done, verify:

- [ ] `register_bundle()` called at module level in `bundle.py`
- [ ] Bundle name added to `_import_builtin_bundles()` in `core/bundles.py`
- [ ] `opencode.jsonc` uses `{env:AGENT_MODEL}` (not a hardcoded model string)
- [ ] Plugin tools use `CONTROL_PLANE_URL`, `RUN_ID`, `SANDBOX_AUTH_TOKEN` env vars
- [ ] `harness_assets("opencode")` returns `Path(__file__).parent / "opencode"`
- [ ] Any structured output validated against `schema.py` before posting
- [ ] Skill/subagent prompts reviewed against the user's example workflow
- [ ] `make compile` passes in `agent/` (syntax check, no external deps needed)
- [ ] `make test` passes (existing tests still green)

If the bundle has a live trigger (webhook), note to the user that end-to-end testing requires
`AGENT_RUN_WORKER=1` and a real or mocked webhook delivery.
