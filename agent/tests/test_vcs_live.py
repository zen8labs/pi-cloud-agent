"""Live VCS test (opt-in): mint a clone token and actually clone the repo.

Covers the credential path the sandbox's git credential helper brokers, isolated
from E2B / OpenCode — the piece `test_harness_live.py` does NOT exercise.

Skips unless a GitHub credential and a `TEST_REPO` are configured. `.env` is
loaded by conftest, so `make test-live` picks these up automatically.

Run:  TEST_REPO=oad-hq/random-skills make test-live
  (or: pytest -q -m live tests/test_vcs_live.py)
"""

from __future__ import annotations

import os
import subprocess
import tempfile

import pytest

_REPO = os.environ.get("TEST_REPO", "")

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not (_REPO and (os.environ.get("GITHUB_TOKEN") or os.environ.get("GITHUB_APP_ID"))),
        reason="live VCS test — set TEST_REPO + (GITHUB_TOKEN or GITHUB_APP_ID/PRIVATE_KEY)",
    ),
]


async def test_mint_token_and_clone():
    """Mint a token via the provider, then shallow-clone — exactly what the
    sandbox credential helper does on the controller's behalf."""
    from core.vcs import get_vcs_provider

    vcs = get_vcs_provider("github")
    token = await vcs.mint_clone_token(_REPO)
    assert token, "no token minted"

    url = f"https://x-access-token:{token}@github.com/{_REPO}.git"
    with tempfile.TemporaryDirectory() as d:
        p = subprocess.run(
            ["git", "clone", "--depth", "1", url, f"{d}/repo"],
            capture_output=True,
            text=True,
        )
        assert p.returncode == 0, (p.stderr or p.stdout).replace(token, "***")
