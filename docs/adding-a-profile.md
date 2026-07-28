# Adding a profile

A profile is a vertical: it decides **whether a trigger should start a run**,
**what the agent is asked to do**, and **what per-repository settings exist**.
Those three decisions are the entire extension surface. Everything else —
sandboxes, credentials, state, streaming — is infrastructure the profile inherits.

The controller must not learn anything about your vertical. If you find yourself
wanting to add a condition to `apps/controller`, that condition belongs in
`accepts` instead.

## The shape

```text
packages/profiles/
  my-profile/
    profile.ts     the definition
    SKILL.md       optional: reusable instructions for the agent
  index.ts         add one line to REGISTRY
```

## 1. Define it

```ts
import { defineProfile } from "@pi-cloud-agent/protocol";
import { z } from "zod";

export const myProfile = defineProfile({
  name: "my-profile",
  description: "One line, shown in the dashboard",

  // Per-repository settings. The dashboard renders this schema directly, so
  // every field needs a default: an unconfigured repository must still work.
  configSchema: z.object({
    enabled: z.boolean().default(true),
  }),

  // Should this trigger start a run? This is your triggering policy — the
  // controller has no opinion and will not second-guess you.
  accepts(trigger, config) {
    return config.enabled && trigger.kind === "manual";
  },

  // Turn the trigger into a task. This is the pivot between behavior and
  // infrastructure.
  buildTask(trigger, config) {
    return {
      profile: "my-profile",
      prompt: `Do the thing on ${trigger.repo.owner}/${trigger.repo.name}`,
      repo: trigger.repo,
    };
  },
});
```

`defineProfile` gives you full type inference on `config` inside your definition,
while the controller only ever sees a config-erased `Profile`. That asymmetry is
what makes the boundary real: the controller *cannot* branch on a field it has no
type for.

## 2. Register it

```ts
// packages/profiles/index.ts
const REGISTRY: Record<string, Profile> = {
  [generalProfile.name]: generalProfile,
  [prReviewProfile.name]: prReviewProfile,
  [myProfile.name]: myProfile,        // ← this line
};
```

That is the whole integration. Your profile now appears in `GET /config`, in the
dashboard's profile selector, and — if `accepts` returns true for repository
events — in webhook intake. Its settings appear on the settings page, rendered
from your schema, with no migration and no API change.

## 3. Optionally add a SKILL.md

Reusable instructions, prepended to the concrete prompt:

```ts
const skill = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8").trim();

export const myProfile = defineProfile({ /* … */ skill });
```

The **controller** composes `skill + prompt` and passes the result to the sandbox
as one finished prompt. The sandbox image therefore ships no profile code at all
and never learns that profiles exist. Do not try to load a skill inside the
runtime.

Write a skill as instructions to a capable colleague, not as a script. The
`pr-review` skill is the reference: hard rules first, then a workflow, then how to
handle failure.

## Rules

**`accepts` must never green-light something `buildTask` would refuse.** If your
task needs a pull request number, check for it in `accepts`. Otherwise a run gets
written to the database and then fails in provisioning for a reason nobody can
see. `packages/profiles/profiles.test.ts` asserts this for every registered
profile, so getting it wrong fails the suite.

**Every config field needs a default.** Stored config is validated *through your
schema* on read, so a schema that rejects `{}` breaks every unconfigured
repository.

**Changing a config schema is a migration you have to think about.** Existing
rows were stored under the old schema. Adding an optional field with a default is
safe; renaming or narrowing a field will throw on read — and the controller logs
that and skips your profile rather than failing the whole webhook delivery.

**Do not reach for the network in `buildTask`.** It runs on the provisioning path.
Enrichment that needs a forge call belongs in webhook intake, where
`resolvePullRequest` already fills in missing commit coordinates.

**A profile that needs no settings should say so** with `z.object({})`, not invent
some. `general` is deliberately empty.

## Actuation

Your profile does not post results. The agent does, from inside the sandbox, using
`git` and `gh` with the token it was given. There is no reporting tool to call and
no publishing step behind you — whatever the agent posts is the outcome.

If you want structured output, ask for it in the skill and have the agent write it
where the reader will look. Do not add a controller-side parser; see
[../AGENTS.md](../AGENTS.md) on what to consult about first.

## Test it

Add cases to `packages/profiles/profiles.test.ts`. The shared `describe("every
profile")` block already covers the contract — registration, empty config,
schema publication, task attribution — so you only need tests for your own
triggering policy and prompt.

```bash
pnpm vitest run packages/profiles/profiles.test.ts
```
