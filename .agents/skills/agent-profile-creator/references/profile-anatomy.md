# Profile Anatomy

## Contract

```python
class Profile(Protocol):
    name: str
    def build_task(self, trigger: dict[str, Any]) -> TaskSpec: ...
```

Profiles are behavior modules. They do not provision sandboxes, resolve model
credentials, manage Postgres, or consume runtime events.

## `profile.py`

```python
from typing import Any

from core.profiles import Profile
from core.types import TaskSpec
from profiles.example.task import build_task


class ExampleProfile(Profile):
    name = "example"

    def build_task(self, trigger: dict[str, Any]) -> TaskSpec:
        return build_task(trigger)
```

Add `("profiles.example.profile", "ExampleProfile")` to the explicit registry
mapping.

## `task.py`

Normalize provider or API input into stable core types:

```python
def build_task(trigger: dict[str, Any]) -> TaskSpec:
    repo = RepoRef(...)
    return TaskSpec(
        profile="example",
        prompt=str(trigger["user_prompt"]),
        repo=repo,
        inputs=trigger,
        limits=RunLimits(),
    )
```

The prompt is the concrete request for this run. Reusable behavior belongs in
`SKILL.md`.

## `SKILL.md`

The sandbox supervisor loads `profiles/<name>/SKILL.md` and prepends it to the
task prompt. The file is optional.

Good instructions explain:

- what outcome to produce;
- the checkout and credentials already available;
- which CLI or API actuates the outcome;
- strict quality/safety rules;
- when to stop.

Avoid repeating repository facts discoverable at runtime. Avoid prescribing
long fixed workflows when the model can choose tools from evidence.

## Tools and integrations

Start with Pi's built-in tools and installed CLIs. Add MCP or another server only
when a concrete profile cannot accomplish its job with progressive disclosure
and ordinary commands. Any such process runs inside the sandbox boundary.

## Controller invariant

The controller receives `TaskSpec`, prepares environment and credentials, waits
for terminal events, and tears down the sandbox. It must not import the profile
implementation or interpret profile output.
