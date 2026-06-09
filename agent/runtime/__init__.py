"""In-sandbox runtime for the CoReview agent.

Runs as PID 1 inside an E2B sandbox. This package is a trimmed port of the
reference Open-Inspect ``sandbox_runtime``, retargeted from a Cloudflare
Durable-Object WebSocket transport to our FastAPI HTTP controller.

Modules:
    constants               -- ports, timeouts, on-disk paths, repo-hook path.
    log_config              -- JSON logging to stderr.
    bridge                  -- OpenCode event subscription + HTTP forwarding.
    entrypoint              -- supervisor: clone, start OpenCode, drive the agent.
"""

from __future__ import annotations

__all__ = ["constants", "log_config", "bridge", "entrypoint"]
