"""Shared constants for the in-sandbox runtime.

Centralised so the supervisor, bridge, and credential helper agree on ports,
paths, and timeouts without restating literals (house style: define a default
value exactly once). Durations are in *seconds* per Python convention.
"""

from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------
# Filesystem layout
# ---------------------------------------------------------------------------

# The agent package is installed to /app in the image (see Dockerfile.sandbox),
# so `bundles/` is importable and the baked bundle assets live under here.
APP_DIR = Path("/app")
BUNDLES_DIR = APP_DIR / "bundles"
PI_RUNNER = APP_DIR / "runtime" / "pi-runner.mjs"

# Where the repo is cloned and Pi runs.
WORKSPACE_DIR = Path("/workspace")

# Repo hook executed after clone, if present (analogous to the reference
# `.openinspect/setup.sh`). Kept relative so it resolves inside the repo.
SETUP_SCRIPT_REL_PATH = ".coreview/setup.sh"

# ---------------------------------------------------------------------------
# Supervisor timeouts / backoff (seconds)
# ---------------------------------------------------------------------------

CLONE_DEPTH_COMMITS = 100
SETUP_SCRIPT_TIMEOUT_SECONDS = 300
