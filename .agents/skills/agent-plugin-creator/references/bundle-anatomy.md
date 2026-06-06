# Bundle Anatomy Reference

## Directory Layout

```
agent/bundles/{bundle_name}/
├── __init__.py               # Empty or docstring only
├── bundle.py                 # Bundle protocol implementation + registration
├── task.py                   # Trigger dict → TaskSpec converter
├── schema.py                 # (Optional) Pydantic output contract
├── tools/
│   ├── __init__.py
│   └── {tool_name}.js        # (Optional) OpenCode plugin tools (ESM)
└── opencode/                 # Per-harness prompt assets
    ├── opencode.jsonc         # OpenCode config (model, permissions, tools)
    ├── skills/
    │   └── {skill_name}/
    │       └── SKILL.md       # Main agent orchestration prompt
    └── subagents/
        └── {agent_name}.md    # (Optional) Delegated subagent prompts
```

## bundle.py

```python
from pathlib import Path
from typing import Any
from core.bundles import Bundle, McpToolServer, register_bundle
from core.types import TaskSpec
from .task import build_task

class MyBundle(Bundle):
    name: str = "{bundle_name}"

    def mcp_tools(self) -> list[McpToolServer]:
        # Return [] unless using MCP servers (rare; plugin tools preferred)
        return []

    def harness_assets(self, harness: str) -> Path:
        # Points to opencode/ (or future harness dirs)
        return Path(__file__).parent / harness

    def build_task(self, trigger: dict[str, Any]) -> TaskSpec:
        return build_task(trigger)

register_bundle("{bundle_name}", MyBundle)
```

## task.py

```python
from typing import Any
from core.types import TaskSpec, RepoRef, RunLimits

def build_task(trigger: dict[str, Any]) -> TaskSpec:
    repo = RepoRef(
        provider=trigger["provider"],    # "github", "gitlab", etc.
        host=trigger["host"],
        owner=trigger["owner"],
        name=trigger["name"],
        clone_url=trigger["clone_url"],
        default_branch=trigger["default_branch"],
        base_sha=trigger["base_sha"],
        head_sha=trigger["head_sha"],
        head_branch=trigger["head_branch"],
        pr_number=trigger.get("pr_number"),
    )
    return TaskSpec(
        bundle="{bundle_name}",
        instructions="One-line pointer that activates the bundle's skill",
        repo=repo,
        inputs=trigger,       # Carry custom fields through to sandbox env
        limits=RunLimits(),   # Use defaults; orchestrator may overlay from settings
    )
```

## schema.py (structured output only)

```python
from typing import Literal
from pydantic import BaseModel

Severity = Literal["blocker", "warning", "nit"]

class Finding(BaseModel):
    file: str
    line: int | None
    severity: Severity
    title: str
    body: str
    evidence: str   # Grounding proof — quote or command output
```

## tools/{tool_name}.js (OpenCode plugin tool)

ESM module using `@opencode-ai/plugin`. The agent calls this tool to emit structured output or call external services.

```js
import { createPlugin } from "@opencode-ai/plugin";
import { z } from "zod";

const plugin = createPlugin({
  name: "{tool_name}",
  tools: {
    {tool_name}: {
      description: "What this tool does",
      parameters: z.object({
        field: z.string().describe("Description"),
      }),
      execute: async ({ field }) => {
        const res = await fetch(
          `${process.env.CONTROL_PLANE_URL}/internal/runs/${process.env.RUN_ID}/{endpoint}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.SANDBOX_AUTH_TOKEN}`,
            },
            body: JSON.stringify({ field }),
          }
        );
        return res.ok ? "Submitted" : `Error: ${await res.text()}`;
      },
    },
  },
});

export default plugin;
```

**Env vars always injected by supervisor:**
- `CONTROL_PLANE_URL` — public HTTPS URL of the controller
- `RUN_ID` — current run UUID
- `SANDBOX_AUTH_TOKEN` — bearer token scoped to this run only

## opencode.jsonc

```jsonc
{
  // Model is injected by supervisor from AGENT_MODEL env var
  "model": "{env:AGENT_MODEL}",
  "small_model": "{env:AGENT_MODEL}",
  // Headless — no interactive prompts
  "permission": {
    "*": { "*": "allow" }
  },
  "tools": {
    "read": true,
    "grep": true,
    "glob": true,
    "bash": true,
    "edit": false,   // true if bundle modifies files
    "write": false   // true if bundle creates files
  }
}
```

## opencode/skills/{skill_name}/SKILL.md

The main orchestration prompt. OpenCode auto-discovers it from `.opencode/skill/`. This is where the actual task logic lives — structured as a skill the agent activates.

Patterns from pr_review:
- Declare a clear multi-phase flow (e.g., split → fan-out → critic → report)
- Delegate each phase to a named subagent via `/agent {name}`
- Call custom plugin tools (e.g., `report_finding`) for structured output
- Keep each phase focused; the critic pattern verifies before committing output

## opencode/subagents/{name}.md

Subagent prompts. OpenCode stages them to `.opencode/agent/`. The parent skill spawns them via `/agent {name}`.

Structure:
```markdown
# {Name} Agent

## Role
One-paragraph description of this subagent's job.

## Inputs
What it receives from the parent skill.

## Process
Step-by-step instructions.

## Output
What it must return (format, required fields, etc.).
```

## Registration

`bundle.py` calls `register_bundle("{bundle_name}", MyBundle)` at module level.
The orchestrator lazy-imports `bundles.{bundle_name}.bundle` on first use — no other wiring needed.

Add the module to `_import_builtin_bundles()` in `agent/core/bundles.py`:
```python
for module in (
    "bundles.pr_review.bundle",
    "bundles.general_agent.bundle",
    "bundles.{bundle_name}.bundle",   # ← add this line
):
```

## How Supervisor Stages Files

The supervisor (`runtime/entrypoint.py`) reads `BUNDLES_DIR/{BUNDLE}/opencode/`:
- `opencode.jsonc` → parsed, JSONC comments stripped, model injected, passed as `OPENCODE_CONFIG_CONTENT`
- `tools/*.js` → staged to `.opencode/tool/` in the cloned repo
- `skills/**` → staged to `.opencode/skill/`
- `subagents/*.md` → staged to `.opencode/agent/`

OpenCode auto-discovers from those paths. No additional config needed.
