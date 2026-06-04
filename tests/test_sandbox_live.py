"""Live E2B sandbox tests (opt-in).

Skips unless `E2B_API_KEY` is set. Proves a sandbox can actually start and run a
command. Uses the default E2B base template so it works without our custom image.
"""

from __future__ import annotations

import os

import pytest

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.environ.get("E2B_API_KEY"),
        reason="live E2B test — set E2B_API_KEY to run",
    ),
]


async def test_sandbox_starts_and_runs_command():
    from e2b import AsyncSandbox

    sandbox = await AsyncSandbox.create(template="base", api_key=os.environ["E2B_API_KEY"])
    try:
        result = await sandbox.commands.run("echo coreview-ok")
        assert "coreview-ok" in result.stdout
    finally:
        await sandbox.kill()
