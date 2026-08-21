from harness.cli.evaluate_verifier import DEFAULT_RUNNER_PATH, _load_runner_module


lav_runner = _load_runner_module(DEFAULT_RUNNER_PATH)


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


def test_empty_and_missing_note_share_default_digest():
    assert lav_runner.effective_ground_truth_note("") == lav_runner.DEFAULT_GROUND_TRUTH_NOTE
    assert lav_runner.verifier_protocol_digest(ground_truth_note="") == lav_runner.verifier_protocol_digest()


def test_select_overall_winner_all_tie_is_none():
    tied = [
        {"id": "a", "wins": 1.0, "mean_pair_score": 0.5},
        {"id": "b", "wins": 1.0, "mean_pair_score": 0.5},
    ]
    assert lav_runner.select_overall_winner(tied) is None

    decisive = [{**tied[0], "wins": 2.0}, tied[1]]
    assert lav_runner.select_overall_winner(decisive) == decisive[0]


def test_run_compare_identical_mock_candidates_abstain():
    result = lav_runner.run_compare(None, _mock_config("same content", "same content"))

    assert result["pairwise"][0]["winner"] == "tie"
    assert result["winner"] is None


def test_run_compare_malformed_scores_abstain(monkeypatch):
    monkeypatch.setattr(lav_runner, "extract_score", lambda *_args: (0.5, "fallback"))

    result = lav_runner.run_compare(None, _mock_config("tests passed", "errors remain"))

    assert result["winner"] is None


def test_create_judge_client_routes_gemini_and_openai(monkeypatch):
    openai_client = object()
    gemini_client = object()
    monkeypatch.setattr(lav_runner, "create_openai_client", lambda **_kwargs: openai_client)
    monkeypatch.setattr(lav_runner, "create_gemini_client", lambda: gemini_client)

    assert lav_runner.create_judge_client("gemini-2.5-flash") is gemini_client
    assert lav_runner.create_judge_client("gpt-4o") is openai_client
    assert lav_runner.create_judge_client("9router/gemini-3-5-flash-medium-round-robin") is openai_client
    assert lav_runner.create_judge_client("kimi/kimi-k2.6") is openai_client
    assert lav_runner.create_judge_client("mock", mock=True) is None
