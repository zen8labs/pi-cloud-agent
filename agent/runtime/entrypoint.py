#!/usr/bin/env python3
"""Launch one sandbox supervisor."""

from __future__ import annotations

import asyncio

from .log_config import configure_logging
from .supervisor import SandboxSupervisor


def main() -> None:
    configure_logging()
    asyncio.run(SandboxSupervisor().run())


if __name__ == "__main__":
    main()
