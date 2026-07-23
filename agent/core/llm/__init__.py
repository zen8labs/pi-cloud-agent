"""Model metadata used by the controller and dashboard."""

from core.llm.registry import ModelEntry, all_models, available_models, get_model

__all__ = ["ModelEntry", "all_models", "available_models", "get_model"]
