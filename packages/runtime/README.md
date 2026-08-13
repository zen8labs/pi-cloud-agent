# @pi-cloud-agent/runtime

> **This is the untrusted zone.** Everything here runs inside the sandbox, alongside code cloned from a repository nobody has reviewed.

One process per run: create or reuse the repository checkout, optionally run the app-managed setup script on a fresh clone, open the durable Pi checkpoint, execute one turn, save the checkpoint, and report outward. The process always exits. Standalone compute is destroyed; a session filesystem may be suspended for a later process.

**Depends on:** `@pi-cloud-agent/protocol` and the agent harness. **Nothing else, ever.** No database client, no VCS client, no sandbox provider, no credential broker. `pnpm boundaries` fails CI if a dependency is added, and pnpm's isolated `node_modules` makes an undeclared import unresolvable in the first place.

It reaches exactly one thing: `CONTROL_PLANE_URL`, outbound only.

## Files

| File | Role |
|---|---|
| `run.ts` | the entry point: four steps, exactly one terminal report |
| `config.ts` | reads `SANDBOX_ENV` into a typed object; `secretValues()` for redaction |
| `workspace.ts` | git credential helper, clone and checkout |
| `setup.ts` | app-managed setup script for a fresh checkout |
| `agent.ts` | one agent turn, relaying Pi's native events as telemetry |
| `oauth-credential.ts` | persists Pi OAuth rotation before deleting run-local auth state |
| `session-state.ts` | authenticated download/open/upload of the Pi JSONL checkpoint |
| `reporter.ts` | the only outbound path: telemetry, OAuth rotation, and terminal status |
| `build.ts` | bundles to `dist/run.js` and pins the harness version for the image |
| `Dockerfile.sandbox` | the sandbox image: Node/Python toolchains, coding CLIs, the bundle |

## Invariants

- **Exactly one terminal status per process.** It is the only thing that completes a run. If it cannot be delivered, exit non-zero and let the controller's reconciler notice the silence. Never exit 0 having said nothing.
- **Telemetry is best-effort and must never fail a run.** Losing a token event costs a line in the feed. `reporter.ts` swallows those failures on purpose.
- **Everything outbound passes through the redactor.** This is the only side that knows every secret in play, so it is the side that scrubs. Do not add a second send path. Credentials must be named `*_TOKEN`, `*_API_KEY`, `*_SECRET`, or `*_PASSWORD` so `secretValues()` catches them without being told.
- **Never write a credential to parked workspace state.** The git credential helper prints from the environment on demand, precisely so no token lands in `.git/config` where the agent could later read or commit it. Pi OAuth may use a run-scoped temporary auth file. If Pi rotates it, the runtime sends the replacement to the authenticated controller callback before removing the file and before the session workspace can be suspended.
- **Repository setup is explicit.** A per-repository setup script saved in the dashboard's Settings > Environments runs once after a fresh clone. The current setting is resolved when the run is provisioned; an empty setting skips custom setup and uses only the bundled image. A non-zero exit or five-minute timeout fails the run instead of handing the agent a known-broken checkout. The script does not receive model, callback, or plugin credentials; forge credentials remain available for private Git dependencies.
- **No workflow code here.** The controller composes enabled plugin skills and the user request into one finished `TASK_PROMPT`, so the image ships no plugin package.
- **MCP is opt-in via env.** When `MCP_CONFIG` is set, the runtime dynamically loads `pi-mcp-adapter` with that isolated snapshot. It never discovers `.mcp.json` from the cloned repository, and a run without MCP never imports the adapter. After `createAgentSession`, the runtime calls `bindExtensions` so Pi emits `session_start` — without that, the adapter registers tools but never initializes. The sandbox command uses `node --import tsx` so the adapter's TypeScript entry can load; the image pins the adapter's peers (`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`) at the top level because npm nests Pi's copies where the adapter cannot resolve them, and remaps `pi-ai`'s main entry to `/compat` so the adapter's `complete` import matches Pi 0.82.
- **This is the one package with a build step.** Crossing into a container image is where "just run the TypeScript" stops being simpler.

## Sandbox tools and repository setup

The default image is a practical JavaScript/Python coding environment. It includes Node, npm, pnpm, Python, pip, venv, uv, `git`, `gh`, `git-lfs`, `jq`, `ripgrep`, archive utilities, and a native compiler toolchain. Heavier ecosystems such as Go, Rust, Java, browser binaries, and cloud CLIs belong in operator-selected custom images rather than every run.

The normal path is Settings > Environments: choose a connected repository, enter its setup commands, and use **Test setup** before saving. The test clones a fresh checkout into a disposable sandbox and runs the unsaved script with the same image and credential boundary as a real run. The current setting is resolved when a run is provisioned, then runs with `bash --noprofile --norc -e -u -o pipefail` as the unprivileged `node` user and is bounded to five minutes. Keep it non-interactive, idempotent, and version-pinned; for example:

```bash
#!/usr/bin/env bash
set -euo pipefail

pnpm install --frozen-lockfile
# or: python -m pip install -r requirements.txt
# or: uv sync --frozen
```

For a Node/TypeScript smoke test, use the bundled Node runtime and install the
compiler into the checkout rather than globally:

```bash
npm install --no-save --no-audit --no-fund typescript@5.8.3
node -e 'console.log(`node ${process.version}`)'
./node_modules/.bin/tsc --version
```

The image provides Node/npm/pnpm plus Python/pip/venv/uv. Python commands use a writable default virtual environment at `/home/node/.venv`, already first on `PATH`, so `python -m pip install ...` does not modify Debian's system interpreter. An empty setting uses only the bundled image tools. A resumed session keeps its filesystem and does not reinstall dependencies. Install project dependencies into the checkout or the unprivileged `node` user's home; runtime setup has no `sudo` access.

Go, Rust, Java, browser runtimes, and cloud CLIs are not in the default image. A setup script can install dependencies for a runtime that is already present, but it cannot reliably bootstrap a missing language toolchain as the unprivileged user. Add image profiles or operator-selected custom images before supporting those ecosystems broadly.

## Working on it

```bash
pnpm --filter @pi-cloud-agent/runtime build     # bundle only
pnpm sandbox:template                           # bundle + rebuild the image
```

Changes here need a template rebuild before they take effect. A controller restart is not enough. Then validate against a real sandbox, because nothing offline covers the image, the harness, and the callback path together:

```bash
pnpm test:live
```

See [../../docs/operations.md](../../docs/operations.md) for what a healthy run looks like and [../../docs/secrets.md](../../docs/secrets.md) for the threat model this package sits inside.
