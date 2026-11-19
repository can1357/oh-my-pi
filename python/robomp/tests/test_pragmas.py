from __future__ import annotations

from robomp.pragmas import (
    parse_pragmas,
    pragma_value,
    resolve_model_alias,
    resolve_thinking_level,
)


def test_parse_single_inline_command() -> None:
    body = "/model gpt\nfix the off-by-one in foo()"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "fix the off-by-one in foo()"
    assert pragmas == (("model", "gpt"),)


def test_parse_multiple_commands_on_one_line() -> None:
    body = "/model gpt /thinking low\nrun"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "run"
    assert pragmas == (("model", "gpt"), ("thinking", "low"))


def test_parse_stacked_commands() -> None:
    body = "/model gpt\n/thinking low\nrun"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "run"
    assert pragmas == (("model", "gpt"), ("thinking", "low"))


def test_parse_equals_form() -> None:
    body = "/model=gpt /thinking=low\nrun"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "run"
    assert pragmas == (("model", "gpt"), ("thinking", "low"))


def test_parse_indented_command_line() -> None:
    body = "   /model gpt\nrun"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "run"
    assert pragmas == (("model", "gpt"),)


def test_mixed_line_is_not_consumed() -> None:
    # Trailing prose after a command is part of the line — keep the line.
    body = "/model gpt fix the bug"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "/model gpt fix the bug"
    assert pragmas == ()


def test_path_references_are_not_consumed() -> None:
    body = "/src/foo.py:42 is the offender\n/model gpt\nfix it"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "/src/foo.py:42 is the offender\nfix it"
    assert pragmas == (("model", "gpt"),)


def test_command_without_value_is_not_consumed() -> None:
    body = "/model\nrun"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "/model\nrun"
    assert pragmas == ()


def test_dangling_command_aborts_whole_line() -> None:
    # `/model gpt /thinking` — second command has no value, so the WHOLE line
    # is left untouched (atomic per-line consumption).
    body = "/model gpt /thinking\nrun"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "/model gpt /thinking\nrun"
    assert pragmas == ()


def test_preserves_interior_blank_lines_after_strip() -> None:
    body = "/model gpt\n\nbody one\n\nbody two"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "body one\n\nbody two"
    assert pragmas == (("model", "gpt"),)


def test_empty_body() -> None:
    cleaned, pragmas = parse_pragmas("")
    assert cleaned == ""
    assert pragmas == ()


def test_key_case_normalized_value_preserved() -> None:
    body = "/MODEL GPT-5.5\nrun"
    cleaned, pragmas = parse_pragmas(body)
    assert cleaned == "run"
    assert pragmas == (("model", "GPT-5.5"),)


def test_pragma_value_last_wins() -> None:
    assert pragma_value((("model", "a"), ("model", "b")), "model") == "b"
    assert pragma_value((("model", "a"),), "MODEL") == "a"
    assert pragma_value((), "model") is None


def test_resolve_model_alias_precedence() -> None:
    pool = ("anthropic/claude-sonnet-4-6", "openai/gpt-5.5", "openai/gpt-5.5-mini")
    # Short-name-after-slash beats substring.
    assert resolve_model_alias("gpt-5.5", pool) == "openai/gpt-5.5"
    # Substring is fallback.
    assert resolve_model_alias("gpt", pool) == "openai/gpt-5.5"
    assert resolve_model_alias("claude", pool) == "anthropic/claude-sonnet-4-6"


def test_resolve_model_alias_full_id() -> None:
    pool = ("openai/gpt-5.5", "anthropic/claude-sonnet-4-6")
    assert resolve_model_alias("openai/gpt-5.5", pool) == "openai/gpt-5.5"


def test_resolve_model_alias_no_match() -> None:
    pool = ("anthropic/claude-sonnet-4-6",)
    assert resolve_model_alias("gpt", pool) is None
    assert resolve_model_alias("", pool) is None


def test_resolve_thinking_level_aliases() -> None:
    # Spec from the user: xhi|xhigh|hi|high|med|medium|lo|low|none|off|no.
    assert resolve_thinking_level("off") == "off"
    assert resolve_thinking_level("none") == "off"
    assert resolve_thinking_level("no") == "off"
    assert resolve_thinking_level("lo") == "low"
    assert resolve_thinking_level("low") == "low"
    assert resolve_thinking_level("med") == "medium"
    assert resolve_thinking_level("medium") == "medium"
    assert resolve_thinking_level("hi") == "high"
    assert resolve_thinking_level("high") == "high"
    assert resolve_thinking_level("xhi") == "xhigh"
    assert resolve_thinking_level("xhigh") == "xhigh"


def test_resolve_thinking_level_case_insensitive() -> None:
    assert resolve_thinking_level("HIGH") == "high"
    assert resolve_thinking_level("  Hi  ") == "high"
    assert resolve_thinking_level("XHi") == "xhigh"


def test_resolve_thinking_level_rejects_unknown() -> None:
    assert resolve_thinking_level("ultra") is None
    assert resolve_thinking_level("") is None
    assert resolve_thinking_level("minimal") is None
