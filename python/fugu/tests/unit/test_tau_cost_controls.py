"""Cost / lane-count knobs in the agentic harness: select_lanes + per-lane provider routing."""

import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.join("evals", "agentic"))


@pytest.fixture(scope="module")
def tf():
    try:
        return importlib.import_module("tau_fusion")
    except Exception as exc:  # tau_bench / openai not installed in this env
        pytest.skip(f"tau_fusion unavailable: {exc}")


def test_select_lanes_caps_to_first_n(tf):
    lanes = ["a", "b", "c", "d"]
    assert tf.select_lanes(lanes, 2) == ["a", "b"]
    assert tf.select_lanes(lanes, 1) == ["a"]


def test_select_lanes_zero_or_oversize_means_all(tf):
    lanes = ["a", "b", "c"]
    assert tf.select_lanes(lanes, 0) == lanes      # 0 = all
    assert tf.select_lanes(lanes, 9) == lanes      # > len = all
    assert tf.select_lanes(lanes, 3) == lanes
    assert tf.select_lanes(lanes, 0) is not lanes  # returns a copy, not the original list


def test_provider_routing_uses_9router_openai_provider(tf):
    assert tf._provider_for("cline-qwen3.7-plus") == "openai"
    assert tf._provider_for("cline-deepseek-v4-pro") == "openai"
    assert tf._provider_for("kimi/kimi-k2.6") == "openai"
    assert tf._provider_for("cc/claude-sonnet-4-6") == "openai"
    assert tf._provider_for("ag/gemini-3.1-pro-low") == "openai"
