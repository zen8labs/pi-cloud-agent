"""Model registry: loads catalog.toml and reports which models are available.

A model is available when every env var in its ``required_env`` list is set and
non-empty. The registry is the single source of truth for model metadata —
it is used by the /config API endpoint to populate the UI's model selector and
by the orchestrator to resolve per-run provider keys.

The catalog file lives next to this module (catalog.toml). To add a new model,
append a [[models]] entry there and set the required env vars — no code changes.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

_CATALOG = Path(__file__).parent / "catalog.toml"


@dataclass(frozen=True)
class ModelEntry:
    id: str
    label: str
    required_env: tuple[str, ...] = field(default_factory=tuple)

    def is_available(self) -> bool:
        return all(os.environ.get(v, "").strip() for v in self.required_env)


@lru_cache(maxsize=1)
def _load_catalog() -> tuple[ModelEntry, ...]:
    with open(_CATALOG, "rb") as f:
        data = tomllib.load(f)
    return tuple(
        ModelEntry(
            id=m["id"],
            label=m["label"],
            required_env=tuple(m.get("required_env", [])),
        )
        for m in data.get("models", [])
    )


def all_models() -> tuple[ModelEntry, ...]:
    """Every model in the catalog regardless of env-var availability."""
    return _load_catalog()


def available_models() -> list[ModelEntry]:
    """Models whose required env vars are all set (shown in the UI selector)."""
    return [m for m in _load_catalog() if m.is_available()]


def get_model(model_id: str) -> ModelEntry | None:
    return next((m for m in _load_catalog() if m.id == model_id), None)
