# @pi-cloud-agent/profiles

The verticals — and the reason the controller has no idea what a code review is.

A profile owns three decisions and nothing else:

1. **whether a trigger should start a run** (`accepts`)
2. **what the agent is asked to do** (`buildTask`)
3. **what per-repository settings exist** (`configSchema`)

**Depends on:** `@pi-cloud-agent/protocol` only.

## Files

| Path | Role |
|---|---|
| `index.ts` | the registry, `getProfile`, `listProfiles`, `DEFAULT_PROFILE` |
| `general/profile.ts` | a free-form request against a checkout. Deliberately has no config |
| `pr-review/profile.ts` | reviews one pull request; owns its own triggering policy |
| `pr-review/SKILL.md` | the instructions the agent follows, prepended to the prompt |
| `profiles.test.ts` | the shared contract every profile must satisfy, plus per-profile policy |

## Invariants

- **`accepts` must never green-light something `buildTask` would refuse.** The shared test block asserts this for every registered profile.
- **Every config field needs a default.** Stored config is validated through your schema on read, so a schema that rejects `{}` breaks every unconfigured repository.
- **The controller never reads inside a config.** It stores the JSON opaquely in `repo_config` and hands it back. That is what keeps profile settings out of the core — and it means a new setting needs no migration and no API change.
- **No network calls in `buildTask`.** It runs on the provisioning path. Enrichment that needs a forge belongs in webhook intake.
- **Profiles do not publish results.** The agent posts its own outcomes from inside the sandbox with `git` and `gh`. There is no reporting tool behind you.

## Adding one

One directory and one line in `index.ts`. Full walkthrough, including how skills and config schemas work: [../../docs/adding-a-profile.md](../../docs/adding-a-profile.md).

```bash
pnpm vitest run packages/profiles/profiles.test.ts
```
