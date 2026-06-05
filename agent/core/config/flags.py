"""Per-repo review-mode resolution (legacy pr-agent vs agentic).

Today this is a simple Postgres-backed override table with an env default, which
is enough for feature-flagged A/B rollout (see ARCHITECTURE.md → "Feature-flagged
rollout"). The dashboard
can later write rows into `repo_flags` to flip individual repos.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config.settings import get_settings
from core.state.models import RepoFlag
from core.types import ReviewMode


async def resolve_review_mode(db: AsyncSession, provider: str, full_name: str) -> ReviewMode:
    row = (
        await db.execute(
            select(RepoFlag).where(
                RepoFlag.provider == provider, RepoFlag.full_name == full_name
            )
        )
    ).scalar_one_or_none()
    if row is not None:
        return ReviewMode(row.review_mode)
    return get_settings().default_review_mode
