# docs

Task-scoped documents. Read the one that matches what you are about to do.

## Extending the core

None of these require touching the controller.

| Document | For |
|---|---|
| [adding-a-sandbox-provider.md](adding-a-sandbox-provider.md) | a new compute backend: Docker, Modal, Daytona |
| [adding-a-vcs-provider.md](adding-a-vcs-provider.md) | a new VCS adapter and OAuth connection |

## Working on the core

| Document | For |
|---|---|
| [resumability.md](resumability.md) | run state, the queue, the reconciler. Read before touching any of them |
| [secrets.md](secrets.md) | credentials, tokens, and anything that gets logged |
| [model-connections.md](model-connections.md) | per-user model endpoints, Pi OAuth, and the vault migration seam |
| [testing.md](testing.md) | what deserves a test, and the three test projects |
| [operations.md](operations.md) | running it, debugging a run by symptom, live validation |

## Elsewhere

- [../ARCHITECTURE.md](../ARCHITECTURE.md): the two trust zones, the run lifecycle, and where each of the seven building blocks lives
- [../VISION.md](../VISION.md): what this is for, and what it will refuse to become
- [../AGENTS.md](../AGENTS.md): the index coding agents read
- each package has its own README: what it owns, its invariants, and a map of its files
