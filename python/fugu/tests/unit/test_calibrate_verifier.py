"""End-to-end tests for `fmh verifier calibrate` and its effect on
`run_compare`'s calibrated_score_a/b fields.

Skipped when the optional `verifier` extra (kingkillery/llm-as-a-verifier)
is not installed -- fitting a calibration needs it; applying an already-
fitted one (tested in `test_verifier_calibration.py`) never does.
"""

import json
from pathlib import Path

import pytest

pytest.importorskip("scripts.verifier_core", reason="requires the optional 'verifier' extra")

from typer.testing import CliRunner

from harness.cli.evaluate_verifier import _load_runner_module, DEFAULT_RUNNER_PATH
from harness.cli.main import app
from harness.fusion.verifier_calibration import calibrate, judge_config_key, load_entry, save_entry


def _labeled_suite(tmp_path: Path, rows: list[dict]) -> Path:
    suite = tmp_path / "labeled.jsonl"
    suite.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
    return suite


def _task_row(task_id: str, winner: str) -> dict:
    good = "tests passed successfully, output matched the expected result"
    bad = "errors remain, the traceback shows a failure"
    return {
        "eval_task_id": task_id,
        "category": "synthetic",
        "task_contract": {"task_id": task_id, "title": task_id, "user_request": "choose"},
        "candidates": [
            {"id": "A", "summary": "candidate A", "content": good if winner == "A" else bad},
            {"id": "B", "summary": "candidate B", "content": good if winner == "B" else bad},
        ],
        "expected_winner": winner,
        "expected_failure_flags": [],
    }


def _synthetic_rows(n: int) -> list[dict]:
    # Alternate A/B winners so the pool isn't degenerate for a task-level split.
    return [_task_row(f"synthetic_{i}", "A" if i % 2 == 0 else "B") for i in range(n)]


def test_calibrate_verifier_fits_and_saves_a_scoped_entry(tmp_path: Path):
    suite = _labeled_suite(tmp_path, _synthetic_rows(20))
    output = tmp_path / "calibration.json"

    result = CliRunner().invoke(
        app,
        [
            "verifier",
            "calibrate",
            "--labeled",
            str(suite),
            "--model",
            "mock",
            "--n-verifications",
            "1",
            "--output",
            str(output),
        ],
    )

    assert result.exit_code == 0, result.output
    runner = _load_runner_module(DEFAULT_RUNNER_PATH)
    key = judge_config_key("mock", 1, prompt_digest=runner.verifier_protocol_digest(ground_truth_note=""))
    entry = load_entry(key, output)
    assert entry is not None
    assert "platt_a" in entry and "platt_b" in entry
    assert entry["model"] == "mock"
    assert entry["n_verifications"] == 1
    # Task-disjoint: no task appears in both counts simultaneously being the
    # full pool -- train + held-out must equal the pooled task count.
    assert entry["train_tasks"] + entry["held_out_tasks"] == 20


def test_calibrate_verifier_excludes_tie_rows(tmp_path: Path):
    rows = _synthetic_rows(16)
    rows.append(
        {
            "eval_task_id": "tie_row",
            "task_contract": {"task_id": "tie_row", "title": "tie", "user_request": "choose"},
            "candidates": [
                {"id": "A", "summary": "a", "content": "equally good answer one"},
                {"id": "B", "summary": "b", "content": "equally good answer two"},
            ],
            "expected_winner": "tie",
            "expected_failure_flags": [],
        }
    )
    suite = _labeled_suite(tmp_path, rows)
    output = tmp_path / "calibration.json"

    result = CliRunner().invoke(
        app,
        ["verifier", "calibrate", "--labeled", str(suite), "--model", "mock", "--output", str(output)],
    )

    assert result.exit_code == 0, result.output
    assert '"skipped_tie_rows": 1' in result.output
    assert '"pooled_tasks": 16' in result.output

def test_calibrate_verifier_rejects_nonpositive_slope_and_writes_nothing(tmp_path: Path):
    """When the raw score is anti-correlated with the actual outcome on the
    train fold, gradient descent fits a<=0. Applying such a fit downstream
    would silently invert what the calibrated score means, so the CLI must
    refuse to write it -- fail non-zero, create no output file, and leave
    an already-existing output file completely untouched."""
    good = "tests passed successfully, output matched the expected result"
    bad = "errors remain, the traceback shows a failure"

    def inverted_row(task_id: str, winner: str) -> dict:
        # winner is deliberately the content the mock heuristic scores LOW
        # (and vice versa), so the raw score is anti-correlated with the
        # true outcome across the whole suite.
        return {
            "eval_task_id": task_id,
            "category": "synthetic",
            "task_contract": {"task_id": task_id, "title": task_id, "user_request": "choose"},
            "candidates": [
                {"id": "A", "summary": "A", "content": bad if winner == "A" else good},
                {"id": "B", "summary": "B", "content": bad if winner == "B" else good},
            ],
            "expected_winner": winner,
            "expected_failure_flags": [],
        }

    rows = [inverted_row(f"inv_{i}", "A" if i % 2 == 0 else "B") for i in range(20)]
    suite = _labeled_suite(tmp_path, rows)
    output = tmp_path / "calibration.json"

    # An existing, unrelated calibration must survive a rejected fit
    # untouched -- the CLI must never truncate/overwrite before validating.
    sentinel = '{"pre-existing": {"platt_a": 5.0, "platt_b": 0.0}}'
    output.write_text(sentinel, encoding="utf-8")

    result = CliRunner().invoke(
        app,
        ["verifier", "calibrate", "--labeled", str(suite), "--model", "mock", "--output", str(output)],
    )

    assert result.exit_code == 1
    assert "not positive" in result.output
    assert "refusing to save" in result.output
    assert output.read_text(encoding="utf-8") == sentinel

def test_run_compare_calibrated_fields_flow_from_a_real_fit(tmp_path: Path):
    """Fit -> lookup -> calibrated-fields, end to end, entirely against a
    throwaway `tmp_path` registry via `config["calibration_path"]` -- never
    touches the checked-in default registry, so parallel test runs and a
    killed process can't leak state into it. `config` is round-tripped
    through JSON before being passed to `run_compare`, so
    `calibration_path` genuinely arrives as a plain string (as real CLI
    JSON input would supply it), not a `Path` object that only happens to
    work in-process."""
    suite = _labeled_suite(tmp_path, _synthetic_rows(20))
    output = tmp_path / "calibration.json"

    fit = CliRunner().invoke(
        app,
        ["verifier", "calibrate", "--labeled", str(suite), "--model", "mock", "--output", str(output)],
    )
    assert fit.exit_code == 0, fit.output
    runner = _load_runner_module(DEFAULT_RUNNER_PATH)
    key = judge_config_key("mock", 1, prompt_digest=runner.verifier_protocol_digest(ground_truth_note=""))
    assert load_entry(key, output) is not None
    config = {
        "mode": "compare",
        "task": "test",
        "context": "",
        "ground_truth_note": "",
        "criteria": [{"id": "c0", "name": "correctness", "description": "is it correct"}],
        "candidates": [
            {"id": "A", "summary": "good", "content": "tests passed successfully"},
            {"id": "B", "summary": "bad", "content": "errors remain"},
        ],
        "n_verifications": 1,
        "granularity": 20,
        "model": "mock",
        "mock": True,
        "calibration_path": str(output),
    }
    config = json.loads(json.dumps(config))
    assert isinstance(config["calibration_path"], str)

    result = runner.run_compare(None, config)
    pair = result["pairwise"][0]

    assert pair["calibrated_score_a"] is not None
    assert pair["calibrated_score_b"] is not None
    assert pair["calibrated_margin"] is not None
    assert 0.0 <= pair["calibrated_score_a"] <= 1.0
    assert 0.0 <= pair["calibrated_score_b"] <= 1.0
    # Calibration is monotonic: it must never flip which candidate the raw
    # score already preferred.
    assert (pair["calibrated_score_a"] > pair["calibrated_score_b"]) == (
        pair["score_a"] > pair["score_b"]
    )
    assert pair["winner"] == "A"


def test_run_compare_calibration_path_is_isolated_per_config(tmp_path: Path):
    """A registry fitted only under `tmp_path/a.json` must not leak into a
    lookup that points at a different (unfitted) `tmp_path/b.json`."""
    suite = _labeled_suite(tmp_path, _synthetic_rows(20))
    fitted = tmp_path / "a.json"
    unfitted = tmp_path / "b.json"

    fit = CliRunner().invoke(
        app,
        ["verifier", "calibrate", "--labeled", str(suite), "--model", "mock", "--output", str(fitted)],
    )
    assert fit.exit_code == 0, fit.output
    assert not unfitted.exists()

    runner = _load_runner_module(DEFAULT_RUNNER_PATH)
    config = {
        "mode": "compare",
        "task": "test",
        "context": "",
        "ground_truth_note": "",
        "criteria": [{"id": "c0", "name": "correctness", "description": "is it correct"}],
        "candidates": [
            {"id": "A", "summary": "good", "content": "tests passed successfully"},
            {"id": "B", "summary": "bad", "content": "errors remain"},
        ],
        "n_verifications": 1,
        "granularity": 20,
        "model": "mock",
        "mock": True,
        "calibration_path": unfitted,
    }
    result = runner.run_compare(None, config)
    pair = result["pairwise"][0]
    assert pair["calibrated_score_a"] is None
    assert pair["calibrated_score_b"] is None
    assert pair["calibrated_margin"] is None


def test_normalize_input_preserves_and_strips_calibration_path():
    runner = _load_runner_module(DEFAULT_RUNNER_PATH)
    payload = {
        "mode": "compare",
        "task": "t",
        "candidates": [{"id": "a", "content": "1"}, {"id": "b", "content": "2"}],
        "criteria": [{"name": "c", "description": "d"}],
        "calibration_path": "  /path/to/custom_calibration.json  ",
    }
    normalized = runner.normalize_input(payload)
    assert normalized["calibration_path"] == "/path/to/custom_calibration.json"

    payload_none = {**payload, "calibration_path": None}
    assert runner.normalize_input(payload_none)["calibration_path"] is None


def test_calibrate_handles_huge_integer_overflow_without_raising(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    huge_int = 10**400
    save_entry(key, {"config_digest": key, "platt_a": huge_int, "platt_b": 0}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None
