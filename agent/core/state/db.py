"""Async SQLAlchemy engine + session factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from core.config import get_settings
from core.state.models import Base

_engine = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def _get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _engine, _sessionmaker
    if _sessionmaker is None:
        _engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _sessionmaker


async def init_db() -> None:
    """Create tables if they don't exist (dev convenience; prod uses Alembic).

    Also applies lightweight column migrations for tables that already exist.
    Each statement is idempotent (IF NOT EXISTS / DO NOTHING) so re-running on
    a fresh DB is safe.
    """
    global _engine
    _get_sessionmaker()
    assert _engine is not None
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Column additions for pre-existing tables (no Alembic yet). This is a
        # Postgres-only convenience: `ADD COLUMN IF NOT EXISTS` is Postgres
        # syntax, and on a fresh DB `create_all` already added the column, so
        # other dialects (e.g. SQLite in tests) neither need nor support it.
        if conn.dialect.name == "postgresql":
            await conn.execute(
                text(
                    """
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'runs' AND column_name = 'bundle'
                        ) AND NOT EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'runs' AND column_name = 'profile'
                        ) THEN
                            ALTER TABLE runs RENAME COLUMN bundle TO profile;
                        END IF;
                    END $$;
                    """
                )
            )
            await conn.execute(
                text("ALTER TABLE runs ADD COLUMN IF NOT EXISTS model VARCHAR(255)")
            )
            for col in (
                "trigger_on_opened",
                "trigger_on_synchronize",
                "trigger_on_comment",
            ):
                await conn.execute(
                    text(
                        f"ALTER TABLE repo_settings ADD COLUMN IF NOT EXISTS "
                        f"{col} BOOLEAN NOT NULL DEFAULT TRUE"
                    )
                )


@asynccontextmanager
async def get_session() -> AsyncIterator[AsyncSession]:
    sm = _get_sessionmaker()
    async with sm() as session:
        yield session
