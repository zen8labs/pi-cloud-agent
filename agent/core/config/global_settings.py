"""DB-backed global settings (key-value).

The /settings API writes these; the orchestrator reads them at run time so
changes take effect without a controller restart.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.state.models import GlobalSetting


async def get_global_setting(db: AsyncSession, key: str) -> str | None:
    row = (
        await db.execute(select(GlobalSetting).where(GlobalSetting.key == key))
    ).scalar_one_or_none()
    return row.value if row is not None else None


async def set_global_setting(db: AsyncSession, key: str, value: str) -> None:
    row = (
        await db.execute(select(GlobalSetting).where(GlobalSetting.key == key))
    ).scalar_one_or_none()
    if row is None:
        db.add(GlobalSetting(key=key, value=value))
    else:
        row.value = value
    await db.commit()
