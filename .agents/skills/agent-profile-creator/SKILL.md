---
name: agent-profile-creator
description: Designs and scaffolds an agent profile for the minimal cloud-agent core. Use when adding a new agent vertical, trigger-to-task mapping, or reusable Pi instructions.
---

# Agent Profile Creator

Create a focused profile without adding behavior to the controller.

Read [references/profile-anatomy.md](references/profile-anatomy.md) before
editing. Also read the repository `VISION.md` and `ARCHITECTURE.md`.

## 1. Establish the irreducible job

Write down:

- the trigger and its normalized fields;
- the concrete outcome the agent owns;
- the repository state it needs;
- the minimum credentials and external tools required;
- the observable proof that the job completed.

Challenge anything proposed for the core. If only this vertical needs it, it
belongs in the profile instructions or an opt-in sandbox tool.

## 2. Create the profile

Add:

```text
agent/profiles/<name>/
  __init__.py
  profile.py
  task.py
  SKILL.md        # only when reusable instructions are needed
```

`profile.py` implements `Profile` and delegates trigger normalization to
`task.py`. `task.py` returns a `TaskSpec` with `profile`, `prompt`, `RepoRef`,
inputs, and limits.

Add the explicit module/class mapping to `_BUILTINS` in
`agent/core/profiles.py`.

## 3. Write the instructions

Keep `SKILL.md` short and operational:

- state the outcome and available environment;
- name hard safety or quality rules;
- tell the agent how it actuates the result;
- define completion in observable terms.

Do not add generic coding advice, controller callbacks, output schemas,
subagents, MCP, or planning machinery by default. Pi already supplies read,
write, edit, and bash tools.

## 4. Wire only the trigger surface

A new automatic trigger may require a thin API or provider adapter. Normalize it
into the same flat trigger shape and call `runs.create_run(profile=...)`.

Do not branch `execute_run` by profile.

## 5. Validate

```bash
cd agent
pytest -m "not live" -q
ruff check core profiles runtime tests
```

Add:

- a task-mapping unit test;
- any trigger parsing test;
- one focused prompt-loading test if `SKILL.md` exists.

For changes to profile assets, rebuild the E2B template and run the live Pi
suite. Use a real agent session when the profile's actuation path is material.

## Done criteria

- The profile is discoverable by `get_profile`.
- `TaskSpec.profile` matches its registry name.
- No profile-specific branch exists in the orchestrator.
- Credentials are no broader than the job requires.
- Completion is visible in stored events and terminal run state.
