"""Worker-side pragma resolution: model + thinking overrides."""

from __future__ import annotations

import pytest

from robomp.config import Settings, reset_settings_cache
from robomp.worker import DirectiveInfo, _resolve_pragma_overrides


@pytest.fixture
def settings_with_pool(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> Settings:
    monkeypatch.setenv(
        "ROBOMP_MODEL",
        "anthropic/claude-sonnet-4-6,openai/gpt-5.5,openai/gpt-5.5-mini",
    )
    reset_settings_cache()
    return Settings()  # type: ignore[call-arg]


def test_no_directive_means_no_override(settings_with_pool: Settings) -> None:
    assert _resolve_pragma_overrides(None, settings_with_pool) == (None, None)


def test_directive_without_pragmas_means_no_override(settings_with_pool: Settings) -> None:
    directive = DirectiveInfo(body="run it", author="can1357")
    assert _resolve_pragma_overrides(directive, settings_with_pool) == (None, None)


def test_model_pragma_resolves_to_pool_entry(settings_with_pool: Settings) -> None:
    directive = DirectiveInfo(body="run", author="can1357", pragmas=(("model", "gpt"),))
    model_override, thinking_override = _resolve_pragma_overrides(directive, settings_with_pool)
    assert model_override == "openai/gpt-5.5"
    assert thinking_override is None


def test_model_alias_exact_short_name(settings_with_pool: Settings) -> None:
    directive = DirectiveInfo(body="run", author="can1357", pragmas=(("model", "gpt-5.5-mini"),))
    model_override, _ = _resolve_pragma_overrides(directive, settings_with_pool)
    assert model_override == "openai/gpt-5.5-mini"


def test_unmatched_model_alias_falls_back_to_random_pick(settings_with_pool: Settings) -> None:
    directive = DirectiveInfo(body="run", author="can1357", pragmas=(("model", "qwen"),))
    model_override, _ = _resolve_pragma_overrides(directive, settings_with_pool)
    assert model_override is None


def test_thinking_pragma_normalized(settings_with_pool: Settings) -> None:
    directive = DirectiveInfo(body="run", author="can1357", pragmas=(("thinking", "LOW"),))
    model_override, thinking_override = _resolve_pragma_overrides(directive, settings_with_pool)
    assert model_override is None
    assert thinking_override == "low"


def test_unknown_thinking_level_dropped(settings_with_pool: Settings) -> None:
    directive = DirectiveInfo(body="run", author="can1357", pragmas=(("thinking", "ultra"),))
    _, thinking_override = _resolve_pragma_overrides(directive, settings_with_pool)
    assert thinking_override is None


def test_both_pragmas_resolved_together(settings_with_pool: Settings) -> None:
    directive = DirectiveInfo(
        body="run",
        author="can1357",
        pragmas=(("model", "claude"), ("thinking", "medium")),
    )
    model_override, thinking_override = _resolve_pragma_overrides(directive, settings_with_pool)
    assert model_override == "anthropic/claude-sonnet-4-6"
    assert thinking_override == "medium"


def test_last_value_wins_for_duplicate_keys(settings_with_pool: Settings) -> None:
    directive = DirectiveInfo(
        body="run",
        author="can1357",
        pragmas=(("model", "claude"), ("model", "gpt")),
    )
    model_override, _ = _resolve_pragma_overrides(directive, settings_with_pool)
    assert model_override == "openai/gpt-5.5"
