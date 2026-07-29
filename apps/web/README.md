# @pi-cloud-agent/web

The operator dashboard: watch runs live, start new ones, configure profiles.

Next.js App Router, React, Tailwind 4. Reaches the controller over HTTP at `NEXT_PUBLIC_API_BASE` and holds no server-side state of its own.

**Depends on:** `@pi-cloud-agent/protocol` — for types only. It has no database access and no credentials.

## Files

| Path | Role |
|---|---|
| `app/page.tsx` | the sessions list, filterable by status |
| `app/chat/page.tsx` | start a run; profiles come from the controller, not from here |
| `app/sessions/[id]/page.tsx` | one run: live feed, details, follow-up |
| `app/settings/page.tsx` | per-repo settings, rendered from each profile's JSON Schema |
| `components/ActivityFeed.tsx` | folds the flat event log into a readable conversation |
| `components/StatusBadge.tsx` | the six run statuses, styled from CSS custom properties |
| `lib/api.ts` | the controller's API, typed from the protocol package |
| `lib/useRun.ts` | the resumable `EventSource` subscription |
| `lib/format.ts` | time and status labels |

## Invariants

- **No locally declared response shapes.** Everything comes from `@pi-cloud-agent/protocol`, so a field the server renames stops compiling here instead of turning into `undefined` on screen. This is the whole reason a protocol package exists — do not restate a type to save an import.
- **The settings page renders schemas, not forms.** It reads `configJsonSchema` from `GET /config`. A new profile's settings appear with no change to this app; if you find yourself writing a field specific to one profile, that is a bug.
- **Dedupe stream events by `seq`.** Frames carry the event log's sequence number; `EventSource` can overlap during a reconnect and React strict mode double-invokes effects. `seq` makes dedupe exact rather than heuristic.
- **A bare SSE `error` event means "reconnecting", not "failed".** Only a frame *with* data is a real server-side error. Treating both the same makes the UI flap on every network hiccup.
- **A follow-up starts a new run.** One run is one sandbox and one session, so there is nothing to resume; the previous exchange is replayed in the prompt. Pretending otherwise would mean keeping a machine alive between messages.

## Working on it

```bash
pnpm web                                     # :3000
pnpm --filter @pi-cloud-agent/web build
```

Needs a controller running on `:8080`. Because the protocol package ships TypeScript rather than build output, it is listed in `transpilePackages` in `next.config.mjs`.

Biome does not parse Tailwind 4's `@theme` at-rule, so `**/*.css` is excluded from linting — `app/globals.css` is checked by nothing but review.
