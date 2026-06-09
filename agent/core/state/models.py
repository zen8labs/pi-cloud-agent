"""Postgres-backed state. Replaces the reference repo's Cloudflare Durable
Objects: per-run rows + an append-only event log + findings (see ARCHITECTURE.md
→ "State & persistence").
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(String(36), default=_uuid, index=True)
    bundle: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)

    provider: Mapped[str] = mapped_column(String(32))
    repo_full_name: Mapped[str] = mapped_column(String(255), index=True)
    pr_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    head_sha: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Opaque trigger payload + per-run callback bearer token.
    trigger: Mapped[dict] = mapped_column(JSON, default=dict)
    auth_token: Mapped[str] = mapped_column(String(64), default=lambda: uuid.uuid4().hex)
    provider_object_id: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # Per-run model override (e.g. "openai/gpt-5.4-mini"). None → global default.
    model: Mapped[str | None] = mapped_column(String(255), nullable=True)

    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Worker claim coordination (FOR UPDATE SKIP LOCKED) + lease expiry.
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    events: Mapped[list[RunEvent]] = relationship(back_populates="run")
    findings: Mapped[list[Finding]] = relationship(back_populates="run")


class RunEvent(Base):
    __tablename__ = "run_events"

    # BigInteger autoincrement needs an INTEGER variant on SQLite (only exact
    # INTEGER aliases the rowid); Postgres keeps BIGINT/BIGSERIAL.
    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(32))
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    run: Mapped[Run] = relationship(back_populates="events")


class Finding(Base):
    __tablename__ = "findings"

    # BigInteger autoincrement needs an INTEGER variant on SQLite (only exact
    # INTEGER aliases the rowid); Postgres keeps BIGINT/BIGSERIAL.
    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    file: Mapped[str] = mapped_column(String(1024))
    line: Mapped[int | None] = mapped_column(Integer, nullable=True)
    severity: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Whether the critic/grounding pass verified it; only published when true.
    grounded: Mapped[bool] = mapped_column(default=False)
    published: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    run: Mapped[Run] = relationship(back_populates="findings")


class RepoSetting(Base):
    """Per-repo dashboard settings the `/settings` page manages.

    Currently just the branch the PR-review agent clones for a repo (empty =
    use the repo's real default branch). Add columns here for future per-repo
    settings rather than spawning parallel tables.
    """

    __tablename__ = "repo_settings"
    __table_args__ = (UniqueConstraint("provider", "full_name", name="uq_repo_setting"),)

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    provider: Mapped[str] = mapped_column(String(32))
    full_name: Mapped[str] = mapped_column(String(255))
    pr_review_branch: Mapped[str] = mapped_column(String(255), default="")
    # Per-repo webhook trigger toggles (default on). When a toggle is off, the
    # matching webhook event no longer auto-starts a PR review for that repo.
    trigger_on_opened: Mapped[bool] = mapped_column(Boolean, default=True)
    trigger_on_synchronize: Mapped[bool] = mapped_column(Boolean, default=True)
    trigger_on_comment: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class GlobalSetting(Base):
    """Key-value store for global application settings (e.g. default_model).

    Written by the /settings API and read by the orchestrator. Prefer this over
    env-var-only config when the value needs to be changeable from the UI at
    runtime without a controller restart.
    """

    __tablename__ = "global_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class RepoFlag(Base):
    """Per-repo review-mode override for feature-flagged rollout."""

    __tablename__ = "repo_flags"
    __table_args__ = (UniqueConstraint("provider", "full_name", name="uq_repo_flag"),)

    # BigInteger autoincrement needs an INTEGER variant on SQLite (only exact
    # INTEGER aliases the rowid); Postgres keeps BIGINT/BIGSERIAL.
    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    provider: Mapped[str] = mapped_column(String(32))
    full_name: Mapped[str] = mapped_column(String(255))
    review_mode: Mapped[str] = mapped_column(String(16), default="agentic")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
