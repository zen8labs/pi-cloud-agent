# @pi-cloud-agent/runtime

> **This is the untrusted zone.** Everything here runs inside the sandbox, alongside code cloned from a repository nobody has reviewed.

One process handles one turn: reuse or clone the checkout, open the durable Pi checkpoint, execute the turn, save the new checkpoint, and report outward. The process exits after the turn. Session continuity comes from the sandbox provider's checkpoint, not a resident agent process.

**Depends on:** `@pi-cloud-agent/protocol` and the agent harness. **Nothing else, ever.** No database, VCS client, sandbox provider, or credential broker. `pnpm boundaries` enforces this trust boundary.

It reaches exactly one thing: `CONTROL_PLANE_URL`, outbound only.

## Files

| File | Role |
|---|---|
| File | Role |
|---|---|
| `run.ts` | entry point and one terminal report |
| `config.ts` | parses sandbox environment into typed values |
| `workspace.ts` | credential helper, clone, checkout, and git diff |
| `agent.ts` | one Pi turn and native telemetry |
| `oauth-credential.ts` | persists Pi OAuth rotation before cleanup |
| `session-state.ts` | authenticated JSONL checkpoint download/upload |
| `reporter.ts` | telemetry, OAuth, structured GitHub publication, and terminal status |
| `github-review.ts` | schema-shaped Pi tool that requests one trusted controller-side PR review |
| `github-comment.ts` | schema-shaped Pi tool that requests one trusted controller-side reply |
| `build.ts` | bundles `dist/run.js` |
| `Dockerfile.sandbox` | default project environment, without the agent runtime |
| `Dockerfile.runtime` | app-managed Linux runtime archives for amd64 and arm64 |

## Invariants

- Exactly one terminal status is reported per process.
- Telemetry is best-effort; callback failures never corrupt a run.
- All outbound content passes through the redactor.
- Credentials are never written to the parked checkout or provider checkpoint.
- The runtime never executes an app-managed repository setup script. Repository dependencies and toolchains belong in the configured base image.
- The controller composes plugin skills and the user request into `TASK_PROMPT`; no plugin package is shipped in the image.
- GitHub review actuation is explicit. Review runs receive one `submit_github_review` tool; the controller never infers a review from streamed prose.
- GitHub task replies are explicit. Mention-triggered runs receive one `reply_github_comment` tool targeting the original comment through the controller.
- MCP is opt-in via `MCP_CONFIG` and is loaded only for that run.

## Image contract

The default image includes Node/npm/pnpm, Python/pip/venv/uv, git, gh, git-lfs, jq, ripgrep, archive utilities, and a native compiler toolchain. Go, Rust, Java, browsers, and cloud CLIs should be supplied by a repository's custom image instead of installed by an arbitrary script.

A custom image supplies the project's environment, not the agent. Supported images are Debian 12/13 and Ubuntu 22.04/24.04 with `/bin/sh`, tar/gzip, apt repositories, and outbound access. Alpine, distroless images, and other distributions are not supported yet. Supply your own language toolchains and dependencies; there is no required parent image, Node version, runtime path, or user account.

Build the app payload with `pnpm sandbox:runtime`. The provider selects the archive matching the guest's amd64/arm64 architecture and transfers it through its SDK. Inside the isolated VM, a credential-free bootstrap installs missing git/gh/bash prerequisites, creates the unprivileged `pi-agent` account and workspace, and installs our bundled Node and agent dependencies under the reserved `/opt/pi-cloud-agent` directory. Each launch refreshes only that app-owned directory, including warm resumes; project files stay in the provider checkpoint. The runtime respects the project's Python environment instead of forcing a bundled virtualenv.

The controller deployment must carry `runtime-linux-amd64.tar.gz` and `runtime-linux-arm64.tar.gz` in `packages/runtime/dist`, or set `SANDBOX_RUNTIME_DIR` to their directory. The deployment's runtime version is independent of the session's base image reference. No runtime or package installation executes on the controller against a user image.

Settings > Environments optionally tests this same installation and loads the agent library in a disposable sandbox. It does not run a model task or verify callback connectivity. Saving does not require testing. Leave the mapping blank to use the default project environment.

On a warm session resume, the provider checkpoint already contains the checkout, uncommitted edits, and installed dependencies, so `prepareCheckout` reuses it without cloning. If the checkpoint is inactive or missing, the runtime removes the derived `/workspace/<repo>` checkout path, cold-starts from the repository image, and clones again while restoring only the Pi JSONL checkpoint. This prevents a stale checkout accidentally baked into a custom image from being treated as session state.

## Working on it

```bash
pnpm --filter @pi-cloud-agent/runtime build
pnpm sandbox:template
pnpm test:live
```

See [../../docs/resumability.md](../../docs/resumability.md) for the combined run/session lifecycle, [../../docs/operations.md](../../docs/operations.md) for diagnostics, and [../../docs/secrets.md](../../docs/secrets.md) for the threat model.
