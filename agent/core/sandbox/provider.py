"""Sandbox provider interface.

Pluggable abstraction over sandbox backends (E2B today; Modal/Fly/Docker later).
Ported in spirit from ref/background-agents control-plane `sandbox/provider.ts`,
trimmed to what a headless, webhook-triggered review run needs. The capability
flags + transient/permanent error classification (for a circuit breaker) are
kept because they earn their keep operationally.

E2B maps onto their *Daytona* shape — persistent `pause`/`resume` of the same
sandbox by id — not the Modal snapshot/restore shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from core.types import CorrelationContext, RepoRef


@dataclass(slots=True)
class SandboxProviderCapabilities:
    supports_snapshots: bool = False
    supports_restore: bool = False
    supports_warm: bool = False
    supports_persistent_resume: bool = False
    supports_explicit_stop: bool = False


@dataclass(slots=True)
class CreateSandboxConfig:
    """Inputs for creating a fresh sandbox for a run."""

    run_id: str
    session_id: str
    repo: RepoRef
    control_plane_url: str  # where the in-sandbox bridge dials back
    sandbox_auth_token: str  # per-run bearer the bridge/tools use on callbacks
    template: str
    timeout_seconds: int
    egress_allowlist: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)  # non-secret config for the runtime
    # Secrets the in-sandbox agent genuinely needs (LLM provider keys). Git creds
    # are NOT here — those are brokered on demand via the credential helper.
    # Kept separate from `env` so providers/logging can treat them carefully.
    secret_env: dict[str, str] = field(default_factory=dict)
    correlation: CorrelationContext | None = None


@dataclass(slots=True)
class SandboxHandle:
    """A live sandbox the controller can address."""

    sandbox_id: str  # logical id (our run/session-scoped id)
    provider_object_id: str  # provider's native id (E2B sandbox id)
    status: str
    bridge_url: str | None = None  # forwarded port URL, if the controller polls it
    tunnel_urls: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class CreateSandboxResult:
    handle: SandboxHandle


@dataclass(slots=True)
class ResumeConfig:
    provider_object_id: str
    session_id: str
    sandbox_id: str
    timeout_seconds: int
    correlation: CorrelationContext | None = None


@dataclass(slots=True)
class ResumeResult:
    success: bool
    handle: SandboxHandle | None = None
    error: str | None = None
    should_spawn_fresh: bool = False


@dataclass(slots=True)
class StopConfig:
    provider_object_id: str
    session_id: str
    reason: str
    correlation: CorrelationContext | None = None


@dataclass(slots=True)
class StopResult:
    success: bool
    error: str | None = None


SandboxErrorType = str  # "transient" | "permanent"


class SandboxProviderError(Exception):
    """Provider error carrying a transient/permanent classification.

    Only *permanent* errors should trip a circuit breaker; transient ones
    (network blips, 5xx) are retried.
    """

    def __init__(self, message: str, error_type: SandboxErrorType, cause: Exception | None = None):
        super().__init__(message)
        self.error_type = error_type
        self.cause = cause

    @staticmethod
    def is_transient_status(status: int) -> bool:
        return status in (502, 503, 504)

    @classmethod
    def from_exc(
        cls, message: str, exc: Exception | None = None, status: int | None = None
    ) -> SandboxProviderError:
        if status is not None:
            etype = "transient" if cls.is_transient_status(status) else "permanent"
            return cls(message, etype, exc)
        text = str(exc or "").lower()
        transient = any(
            s in text
            for s in ("timeout", "econnreset", "econnrefused", "etimedout", "network", "fetch failed")
        )
        return cls(message, "transient" if transient else "permanent", exc)


@runtime_checkable
class SandboxProvider(Protocol):
    """Contract for sandbox lifecycle operations."""

    name: str
    capabilities: SandboxProviderCapabilities

    async def create_sandbox(self, config: CreateSandboxConfig) -> CreateSandboxResult: ...

    async def resume_sandbox(self, config: ResumeConfig) -> ResumeResult: ...

    async def stop_sandbox(self, config: StopConfig) -> StopResult: ...
