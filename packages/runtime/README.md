# @pi-cloud-agent/runtime

> **This is the untrusted zone.** Everything here runs inside the sandbox, alongside code cloned from a repository nobody has reviewed.

One process handles one turn: reuse or clone the checkout, open the durable Pi checkpoint, execute the turn, save the new checkpoint, and report outward. The process exits after the turn. Session continuity comes from the sandbox provider's checkpoint, not a resident agent process.

**Depends on:** `@pi-cloud-agent/protocol` and the agent harness. **Nothing else, ever.** No database, VCS client, sandbox provider, or credential broker. `pnpm boundaries` enforces this trust boundary.

It reaches exactly one thing: `CONTROL_PLANE_URL`, outbound only.

## Files

| File | Role |
|---|---|
| `run.ts` | entry point and one terminal report |
| `config.ts` | parses sandbox environment into typed values |
| `workspace.ts` | credential helper, clone, checkout, and git diff |
| `agent.ts` | one Pi turn and native telemetry |
| `oauth-credential.ts` | persists Pi OAuth rotation before cleanup |
| `session-state.ts` | authenticated JSONL checkpoint download/upload |
| `reporter.ts` | telemetry, OAuth, and terminal status callback |
| `build.ts` | bundles `dist/run.js` |
| `Dockerfile.sandbox` | bundled default image |

## Invariants

- Exactly one terminal status is reported per process.
- Telemetry is best-effort; callback failures never corrupt a run.
- All outbound content passes through the redactor.
- Credentials are never written to the parked checkout or provider checkpoint.
- The runtime never executes an app-managed repository setup script. Repository dependencies and toolchains belong in the configured base image.
- The controller composes plugin skills and the user request into `TASK_PROMPT`; no plugin package is shipped in the image.
- MCP is opt-in via `MCP_CONFIG` and is loaded only for that run.

## Image contract

The default image includes Node/npm/pnpm, Python/pip/venv/uv, git, gh, git-lfs, jq, ripgrep, archive utilities, and a native compiler toolchain. Go, Rust, Java, browsers, and cloud CLIs should be supplied by a repository's custom image instead of installed by an arbitrary script.

A custom image or E2B template selected in Settings must provide:

- `/app/run.js` (the bundled runtime entry point)
- `/app/package.json` and its runtime dependencies, including the `tsx` loader
- `/workspace` writable by the `node` user
- Node.js, `git`, and `gh` on `PATH`, plus an unprivileged `node` user
- a non-interactive shell and outbound access to the control plane, forge, and model gateway

Settings > Environments runs these checks in a disposable sandbox before saving the image reference. Leave the mapping blank to use the bundled image.

On a warm session resume, the provider checkpoint already contains the checkout, uncommitted edits, and installed dependencies, so `prepareCheckout` reuses it without cloning. If the checkpoint is inactive or missing, the runtime removes the derived `/workspace/<repo>` checkout path, cold-starts from the repository image, and clones again while restoring only the Pi JSONL checkpoint. This prevents a stale checkout accidentally baked into a custom image from being treated as session state.

## Working on it

```bash
pnpm --filter @pi-cloud-agent/runtime build
pnpm sandbox:template
pnpm test:live
```

See [../../docs/resumability.md](../../docs/resumability.md) for the combined run/session lifecycle, [../../docs/operations.md](../../docs/operations.md) for diagnostics, and [../../docs/secrets.md](../../docs/secrets.md) for the threat model.
