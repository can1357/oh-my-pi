from pathlib import Path

from harness.cli.evaluate_verifier import DEFAULT_RUNNER_PATH, _load_runner_module


EXTENSION_RUNNER_PATH = (
    Path(__file__).resolve().parents[4]
    / "packages/verifier-extension/skills/llm-as-verifier/scripts/lav_runner.py"
)


def _mock_config(content_a: str, content_b: str) -> dict:
    return {
        "mode": "compare",
        "task": "choose",
        "context": "",
        "criteria": [{"id": "overall", "name": "Overall correctness", "description": "Overall correctness"}],
        "candidates": [
            {"id": "a", "summary": "candidate a", "content": content_a},
            {"id": "b", "summary": "candidate b", "content": content_b},
        ],
        "n_verifications": 1,
        "granularity": 20,
        "model": "mock",
        "mock": True,
    }


def _pair_observation(runner, config: dict) -> tuple[float, float, str, object]:
    result = runner.run_compare(None, config)
    pair = result["pairwise"][0]
    return pair["score_a"], pair["score_b"], pair["winner"], result["winner"]


def test_fugu_and_extension_runner_scoring_parity():
    assert EXTENSION_RUNNER_PATH.is_file()
    fugu_runner = _load_runner_module(DEFAULT_RUNNER_PATH)
    extension_runner = _load_runner_module(EXTENSION_RUNNER_PATH)

    assert fugu_runner.DEFAULT_GROUND_TRUTH_NOTE == extension_runner.DEFAULT_GROUND_TRUTH_NOTE
    assert fugu_runner.SCORER_IMPLEMENTATION_ID == extension_runner.SCORER_IMPLEMENTATION_ID
    assert fugu_runner.verifier_protocol_digest() == extension_runner.verifier_protocol_digest()

    for text in ("<score_A>A</score_A>", "<score_A>T</score_A>", "garbage text"):
        assert fugu_runner.extract_score(text, None, None, "<score_A>") == extension_runner.extract_score(
            text, None, None, "<score_A>"
        )

    assert _pair_observation(fugu_runner, _mock_config("tests passed", "errors remain")) == _pair_observation(
        extension_runner, _mock_config("tests passed", "errors remain")
    )
    assert _pair_observation(fugu_runner, _mock_config("same content", "same content")) == _pair_observation(
        extension_runner, _mock_config("same content", "same content")
    )
