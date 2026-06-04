"""Settings and model-routing tests (no network)."""

from __future__ import annotations

import os

import pytest

from core.config.settings import Settings
from core.types import ReviewMode


def test_model_spec_parses_fallbacks(monkeypatch):
    monkeypatch.setenv("AGENT_MODEL", "aigateway/MiniMax/MiniMax-M2.7")
    monkeypatch.setenv("AGENT_FALLBACK_MODELS", " openai/backup , openai/tertiary ")
    monkeypatch.setenv("AGENT_TEMPERATURE", "0.5")
    spec = Settings().model_spec()
    assert spec.model == "aigateway/MiniMax/MiniMax-M2.7"
    assert spec.fallbacks == ["openai/backup", "openai/tertiary"]
    assert spec.temperature == pytest.approx(0.5)


def test_egress_allowlist_splits_csv(monkeypatch):
    monkeypatch.setenv("SANDBOX_EGRESS_ALLOWLIST", "github.com, api.github.com ,,")
    assert Settings().egress_allowlist() == ["github.com", "api.github.com"]


def test_default_review_mode(monkeypatch):
    monkeypatch.setenv("DEFAULT_REVIEW_MODE", "legacy")
    assert Settings().default_review_mode is ReviewMode.legacy
