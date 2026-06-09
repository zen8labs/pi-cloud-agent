"""Shared constants for the in-sandbox runtime.

Centralised so the supervisor, bridge, and credential helper agree on ports,
paths, and timeouts without restating literals (house style: define a default
value exactly once). Durations are in *seconds* per Python convention.
"""

from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------
# OpenCode server
# ---------------------------------------------------------------------------

# OpenCode's HTTP/SSE server listens here; the bridge drives it over localhost.
# Matches the reference runtime's fixed port so the install/health-check logic
# is portable.
OPENCODE_PORT = 4096
OPENCODE_HOSTNAME = "0.0.0.0"

# ---------------------------------------------------------------------------
# Filesystem layout
# ---------------------------------------------------------------------------

# The agent package is installed to /app in the image (see Dockerfile.sandbox),
# so `bundles/` is importable and the baked bundle assets live under here.
APP_DIR = Path("/app")
BUNDLES_DIR = APP_DIR / "bundles"

# Pre-staged @opencode-ai/plugin deps baked into the image (Dockerfile.sandbox).
# Copied into the workspace's `.opencode/` at boot so OpenCode's Npm.install()
# finds a lockfile in sync and skips the slow arborist reify() that would
# otherwise block the first prompt (ported from the reference image build +
# `_install_tools`). MUST match the pinned OpenCode/plugin version.
OPENCODE_DEPS_DIR = APP_DIR / "opencode-deps"

# Where the PR repo is cloned. The agent works inside this directory and
# OpenCode is started with it as cwd.
WORKSPACE_DIR = Path("/workspace")

# Persisted OpenCode session id so a bridge restart re-attaches rather than
# spawning a fresh review session.
OPENCODE_SESSION_ID_FILE = Path("/tmp/opencode-session-id")

# Repo hook executed after clone, if present (analogous to the reference
# `.openinspect/setup.sh`). Kept relative so it resolves inside the repo.
SETUP_SCRIPT_REL_PATH = ".coreview/setup.sh"

# ---------------------------------------------------------------------------
# Supervisor timeouts / backoff (seconds)
# ---------------------------------------------------------------------------

CLONE_DEPTH_COMMITS = 100
OPENCODE_HEALTH_TIMEOUT_SECONDS = 30.0
SETUP_SCRIPT_TIMEOUT_SECONDS = 300
MAX_RESTARTS = 5
BACKOFF_BASE_SECONDS = 2.0
BACKOFF_MAX_SECONDS = 60.0

# Default model if AGENT_MODEL is unset.
# Uses a custom provider name so the supervisor injects @ai-sdk/openai-compatible.
DEFAULT_AGENT_MODEL = "aigateway/MiniMax/MiniMax-M2.7"
