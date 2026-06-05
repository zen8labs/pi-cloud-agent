from core.sandbox.provider import (
    CreateSandboxConfig,
    CreateSandboxResult,
    ResumeConfig,
    ResumeResult,
    SandboxHandle,
    SandboxProvider,
    SandboxProviderCapabilities,
    SandboxProviderError,
    StopConfig,
    StopResult,
)

__all__ = [
    "SandboxProvider",
    "SandboxProviderCapabilities",
    "SandboxProviderError",
    "SandboxHandle",
    "CreateSandboxConfig",
    "CreateSandboxResult",
    "ResumeConfig",
    "ResumeResult",
    "StopConfig",
    "StopResult",
]


def get_sandbox_provider() -> SandboxProvider:
    """Factory: returns the configured sandbox provider (E2B today)."""
    from core.sandbox.e2b_provider import E2BSandboxProvider

    return E2BSandboxProvider()
