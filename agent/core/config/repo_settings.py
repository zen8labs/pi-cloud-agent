"""Per-repo dashboard settings (currently the PR-review branch override).

Mirrors `flags.py`'s Postgres-backed-override pattern. The `/settings` page
writes these; the webhook layer reads the branch when building a review run's
trigger so each repo can pin which branch the PR agent clones.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.state.models import RepoSetting


async def get_pr_review_branch(db: AsyncSession, provider: str, full_name: str) -> str:
    """The repo's pinned PR-review branch, or "" to use its real default."""
    row = await _row(db, provider, full_name)
    return row.pr_review_branch if row is not None else ""


async def get_all_pr_review_branches(db: AsyncSession) -> dict[str, str]:
    """Map of `full_name → pinned branch` for every repo with an override set."""
    rows = (await db.execute(select(RepoSetting))).scalars().all()
    return {r.full_name: r.pr_review_branch for r in rows if r.pr_review_branch}


async def set_pr_review_branch(
    db: AsyncSession, provider: str, full_name: str, branch: str
) -> None:
    """Upsert the repo's PR-review branch. Empty `branch` clears the override."""
    row = await _row(db, provider, full_name)
    if row is None:
        db.add(RepoSetting(provider=provider, full_name=full_name, pr_review_branch=branch))
    else:
        row.pr_review_branch = branch
    await db.commit()


async def _row(db: AsyncSession, provider: str, full_name: str) -> RepoSetting | None:
    return (
        await db.execute(
            select(RepoSetting).where(
                RepoSetting.provider == provider, RepoSetting.full_name == full_name
            )
        )
    ).scalar_one_or_none()
