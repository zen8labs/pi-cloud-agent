# @pi-cloud-agent/web

The operator dashboard: watch runs live, start new ones, and connect VCS identities.

Next.js App Router, React, Tailwind 4, Base UI, and local-source [AI Elements](https://elements.ai-sdk.dev/) conversation primitives. Reaches the controller over HTTP at `NEXT_PUBLIC_API_BASE` and holds no server-side state of its own. Pi remains the agent harness; AI Elements only owns presentation and interaction semantics.

**Depends on:** `@pi-cloud-agent/protocol`, for types only. It has no database access and no credentials.

## Files

| Path | Role |
|---|---|
| `app/page.tsx` | redirects the root route to the chat-first workspace |
| `app/chat/page.tsx` | start a run; profiles come from the controller, not from here |
| `app/settings/page.tsx` | connect and disconnect GitHub and Azure DevOps identities |
| `app/plugins/page.tsx` | browse, install, configure marketplace plugins |
| `app/sessions/[id]/page.tsx` | ordered turns: merged activity, live latest run, real follow-up |
| `components/ActivityFeed.tsx` | folds the flat event log into a readable conversation |
| `components/ToolArgsView.tsx` | write/edit diffs, bash shell panel with output, else JSON |
| `components/ChangeStatsCard.tsx` | end-of-turn file change summary (+/− per path) |
| `components/ChatComposer.tsx` | product wrapper around the AI Elements prompt primitives |
| `components/StatusBadge.tsx` | the six run statuses, styled from CSS custom properties |
| `components/ai-elements/` | source-owned conversation, message, and prompt primitives |
| `components/SideNav.tsx` | primary navigation plus polling session history |
| `components/ui/` | focused source-owned Base UI building blocks used by AI Elements |
| `public/assets/z8l-logo.png` | the zen8labs application mark |
| `lib/api.ts` | the controller's API, typed from the protocol package |
| `lib/useRun.ts` | the resumable `EventSource` subscription |
| `lib/useSession.ts` | polls durable session metadata and combines every turn's event history |
| `lib/format.ts` | time and status labels |
| `lib/file-changes.ts` | pure write/edit +/− accounting shared by feed and aside |
| `lib/session-meta.ts` | change totals and live branch from the event stream |
| `lib/session-titles.ts` | local prompt-derived labels for sidebar history |

## Invariants

- **No locally declared response shapes.** Everything comes from `@pi-cloud-agent/protocol`, so a field the server renames stops compiling here instead of turning into `undefined` on screen. This is the whole reason a protocol package exists. Do not restate a type to save an import.
- **Dedupe stream events by `seq`.** Frames carry the event log's sequence number; `EventSource` can overlap during a reconnect and React strict mode double-invokes effects. `seq` makes dedupe exact rather than heuristic.
- **A bare SSE `error` event means "reconnecting", not "failed".** Only a frame *with* data is a real server-side error. Treating both the same makes the UI flap on every network hiccup.
- **The composer is not the harness.** A follow-up creates a new run under the same durable session. Pi history and the repository workspace are restored below the API boundary; the browser never reconstructs or replays conversation text.

## Working on it

```bash
pnpm web                                     # :3000
pnpm --filter @pi-cloud-agent/web build
```

Needs a controller running on `:8080`. Because the protocol package ships TypeScript rather than build output, it is listed in `transpilePackages` in `next.config.mjs`.

Biome does not parse Tailwind 4's `@theme` at-rule, so `**/*.css` is excluded from linting; `app/globals.css` is checked by nothing but review.
