# CoReview Web

A Next.js dashboard to monitor and drive the cloud agent. No authentication —
it's a debug/operator console.

## Pages

- **Sessions** (`/`) — every run (background PR reviews + manual agent runs) with
  live status. Auto-refreshes.
- **Session detail** (`/sessions/[id]`) — a Ramp/Devin-style activity timeline:
  provisioning logs (clone, setup), agent messages, tool calls (read/edit/run),
  and findings, streamed live. A metadata sidebar shows status, repo, PR link,
  findings, and the raw SSE endpoint. Active runs can be cancelled.
- **New session** (`/chat`) — pick a repo, choose **Agent task** (free-form,
  general_agent bundle) or **PR review**, type a prompt, and press Enter to start
  a run in a fresh sandbox.

## Running

The dashboard talks to the FastAPI controller (default `http://localhost:8080`).

```bash
cd web
npm install
cp .env.example .env.local   # edit NEXT_PUBLIC_API_BASE if the controller isn't on :8080
npm run dev                  # http://localhost:3000
```

On the controller side, set:

- `WEB_REPOS` — comma-separated `owner/name` repos shown in the chat selector.
- `WEB_CORS_ORIGINS` — allowed browser origins (default `*` for local dev).

## How it talks to the controller

| UI action | Controller endpoint |
|---|---|
| Sessions list | `GET /runs` (poll) |
| Session metadata + findings | `GET /runs/{id}` |
| Live activity feed | `GET /runs/{id}/stream` (resumable SSE) |
| Cancel | `POST /runs/{id}/cancel` |
| Start a session | `POST /runs` |
| Repo selector | `GET /repos` |
| Model/bundles | `GET /config` |

## Streaming

The live feed is a real streaming pipeline, not polling. The session page opens a
native `EventSource` to `GET /runs/{id}/stream`; the controller tags every frame
with `id: <seq>` from the append-only `run_events` log. Because the log is the
durable source of truth and each frame is sequence-tagged:

- **Replayable** — a fresh page load streams full history from seq 0, then tails.
- **Resumable** — if the connection drops, `EventSource` auto-reconnects and the
  browser sends `Last-Event-ID`; the server resumes from the exact next event, so
  there are no gaps or duplicates. (`?after_seq=` does the same for non-browser
  clients that already replayed history over REST.)

Token, tool-call, log, finding, and status frames all flow over this one
connection. You can watch the raw stream with `curl -N $API_BASE/runs/<id>/stream`
(also linked from the session sidebar).
