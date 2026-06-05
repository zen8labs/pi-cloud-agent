"""Test configuration + tiering.

Two tiers:
  * **unit / integration (default):** no external services. The API tier runs on
    a throwaway SQLite DB so endpoints are exercised without Postgres.
  * **live (opt-in):** real calls to the MiniMax gateway, E2B, and OpenCode.
    Each live test self-skips unless the relevant credential env is set.

We set DB + worker env before loading ``agent/.env`` so unit tests keep SQLite and
test webhook secrets, and before the app is imported so no background worker spins up.
``agent/.env`` is loaded next (without overriding those keys) so ``make test-live``
can use real API keys without exporting them in the shell.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

_AGENT_ROOT = Path(__file__).resolve().parent.parent

os.environ.setdefault("AGENT_RUN_WORKER", "0")
os.environ.setdefault("GITHUB_WEBHOOK_SECRET", "testsecret")
os.environ.setdefault("GITLAB_WEBHOOK_SECRET", "gitlab-secret")
os.environ.setdefault("BITBUCKET_WEBHOOK_SECRET", "bb-secret")
os.environ.setdefault("DEFAULT_REVIEW_MODE", "agentic")

# A real (temp file) SQLite DB so multiple async connections share state.
_db = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_db.name}")


def _load_agent_dotenv() -> None:
    """Load ``agent/.env`` for live tests; never override test fixture env vars."""
    env_path = _AGENT_ROOT / ".env"
    if not env_path.is_file():
        return
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(env_path, override=False)


_load_agent_dotenv()
