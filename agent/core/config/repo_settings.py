"""Per-repo dashboard settings (currently the PR-review branch override).

Mirrors `flags.py`'s Postgres-backed-override pattern. The `/settings` page
writes these; the webhook layer reads the branch when building a review run's
trigger so each repo can pin which branch the PR agent clones.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.state.models import RepoSetting
from core.vcs.types import WebhookKind

# Which RepoSetting column gates each trigger webhook kind. Absent kinds (e.g.
# `ignored`) are never gated here — they're already dropped upstream.
_TRIGGER_COLUMN: dict[WebhookKind, str] = {
    WebhookKind.pr_opened: "trigger_on_opened",
    WebhookKind.pr_updated: "trigger_on_synchronize",
    WebhookKind.pr_comment: "trigger_on_comment",
}


def _triggers(row: RepoSetting | None) -> dict[str, bool]:
    """The repo's trigger toggles (all default on when no row exists)."""
    if row is None:
        return {"opened": True, "synchronize": True, "comment": True}
    return {
        "opened": row.trigger_on_opened,
        "synchronize": row.trigger_on_synchronize,
        "comment": row.trigger_on_comment,
    }


async def is_trigger_enabled(
    db: AsyncSession, provider: str, full_name: str, kind: WebhookKind
) -> bool:
    """Whether `kind` should auto-start a review for this repo (default True)."""
    column = _TRIGGER_COLUMN.get(kind)
    if column is None:
        return True
    row = await _row(db, provider, full_name)
    return getattr(row, column) if row is not None else True


async def get_all_triggers(db: AsyncSession) -> dict[str, dict[str, bool]]:
    """Map of `full_name → trigger toggles` for every repo with a row."""
    rows = (await db.execute(select(RepoSetting))).scalars().all()
    return {r.full_name: _triggers(r) for r in rows}


async def set_triggers(
    db: AsyncSession,
    provider: str,
    full_name: str,
    *,
    opened: bool,
    synchronize: bool,
    comment: bool,
) -> None:
    """Upsert the repo's trigger toggles."""
    row = await _row(db, provider, full_name)
    if row is None:
        row = RepoSetting(provider=provider, full_name=full_name)
        db.add(row)
    row.trigger_on_opened = opened
    row.trigger_on_synchronize = synchronize
    row.trigger_on_comment = comment
    await db.commit()


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
