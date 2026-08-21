from pathlib import Path

from harness.fusion.verifier_calibration import (
    DEFAULT_PROMPT_DIGEST,
    apply_platt,
    calibrate,
    compute_verifier_config_digest,
    judge_config_key,
    load_entry,
    load_registry,
    save_entry,
)


def test_judge_config_key_is_deterministic_and_config_sensitive():
    key = judge_config_key("mock", 1)
    assert judge_config_key("mock", 1) == key
    assert judge_config_key("mock", 2) != key
    assert judge_config_key("cx/gpt-5.5", 1) != key
    assert judge_config_key("mock", 1, granularity=10) != key
    assert judge_config_key("mock", 1, prompt_digest="other_digest") != key
    assert compute_verifier_config_digest("mock", 1) == key


def test_apply_platt_identity_params_is_plain_sigmoid():
    assert apply_platt(0.0, 1.0, 0.0) == 0.5
    assert apply_platt(100.0, 1.0, 0.0) == 1.0
    assert apply_platt(-100.0, 1.0, 0.0) == 0.0


def test_apply_platt_zero_slope_collapses_to_constant():
    assert apply_platt(0.9, 0.0, 0.0) == 0.5
    assert apply_platt(0.1, 0.0, 0.0) == 0.5


def test_load_registry_missing_file_returns_empty_dict(tmp_path: Path):
    assert load_registry(tmp_path / "nope.json") == {}


def test_load_registry_malformed_json_returns_empty_dict(tmp_path: Path):
    path = tmp_path / "bad.json"
    path.write_text("not json", encoding="utf-8")
    assert load_registry(path) == {}


def test_save_and_load_entry_round_trips(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    save_entry(key, {"platt_a": 2.0, "platt_b": -1.0}, path)

    entry = load_entry(key, path)
    assert entry == {"platt_a": 2.0, "platt_b": -1.0}


def test_save_entry_merges_without_clobbering_other_keys(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key_a = judge_config_key("mock", 1)
    key_b = judge_config_key("mock", 3)
    save_entry(key_a, {"platt_a": 1.0, "platt_b": 0.0}, path)
    save_entry(key_b, {"platt_a": 2.0, "platt_b": 0.0}, path)

    registry = load_registry(path)
    assert set(registry.keys()) == {key_a, key_b}
    assert registry[key_a]["platt_a"] == 1.0
    assert registry[key_b]["platt_a"] == 2.0


def test_calibrate_returns_none_when_no_entry_fitted(tmp_path: Path):
    path = tmp_path / "calibration.json"
    assert calibrate(0.9, "mock", 1, path=path) is None


def test_calibrate_applies_fitted_entry_for_exact_config_only(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    save_entry(key, {"config_digest": key, "platt_a": 1.0, "platt_b": 0.0}, path)

    assert calibrate(0.0, "mock", 1, path=path) == 0.5
    # A different n_verifications was never fitted -- must not silently
    # reuse a fit made for a different verifier configuration.
    assert calibrate(0.0, "mock", 3, path=path) is None
    assert calibrate(0.0, "cx/gpt-5.5", 1, path=path) is None
    # A modified prompt digest produces a different key and returns None
    assert calibrate(0.0, "mock", 1, prompt_digest="different_prompt", path=path) is None


def test_calibrate_rejects_stored_entry_with_mismatched_config_digest(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    # Store an entry under key, but with a mismatched internal config_digest (e.g. stale from old prompt)
    save_entry(key, {"config_digest": "stale_or_mismatched_digest", "platt_a": 1.0, "platt_b": 0.0}, path)
    assert calibrate(0.0, "mock", 1, path=path) is None

def test_calibrate_rejects_zero_slope(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    save_entry(key, {"config_digest": key, "platt_a": 0.0, "platt_b": 0.0}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None


def test_calibrate_rejects_negative_slope(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    save_entry(key, {"config_digest": key, "platt_a": -2.0, "platt_b": 0.5}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None


def test_calibrate_rejects_non_finite_coefficients(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    save_entry(key, {"config_digest": key, "platt_a": float("nan"), "platt_b": 0.0}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None

    save_entry(key, {"config_digest": key, "platt_a": 1.0, "platt_b": float("inf")}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None


def test_calibrate_rejects_missing_coefficients(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    save_entry(key, {"config_digest": key, "platt_b": 0.0}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None

    save_entry(key, {"config_digest": key, "platt_a": 1.0}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None


def test_calibrate_rejects_non_numeric_coefficients(tmp_path: Path):
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    save_entry(key, {"config_digest": key, "platt_a": "1.0", "platt_b": 0.0}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None

    # Booleans are technically ints in Python but must never be treated as
    # numeric coefficients here.
    save_entry(key, {"config_digest": key, "platt_a": True, "platt_b": 0.0}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None


def test_calibrate_rejects_overflowing_integer_coefficients(tmp_path: Path):
    """A JSON registry can hold an arbitrarily large integer; float() on it
    raises OverflowError, which must read as "calibration unavailable",
    never a crash."""
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)
    save_entry(key, {"config_digest": key, "platt_a": 10**400, "platt_b": 0.0}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None

    save_entry(key, {"config_digest": key, "platt_a": 1.0, "platt_b": 10**400}, path)
    assert calibrate(0.9, "mock", 1, path=path) is None


def test_calibrate_rejects_non_dict_registry_entry(tmp_path: Path):
    """A hand-edited or foreign-tool-written registry could put a
    non-dict JSON value under a key -- load_registry() places no type
    constraint on it, so the apply boundary must not crash trying to
    call .get() on a list/string/number."""
    path = tmp_path / "calibration.json"
    key = judge_config_key("mock", 1)

    path.write_text(f'{{"{key}": [1.0, 0.0]}}', encoding="utf-8")
    assert calibrate(0.9, "mock", 1, path=path) is None

    path.write_text(f'{{"{key}": "not-a-dict"}}', encoding="utf-8")
    assert calibrate(0.9, "mock", 1, path=path) is None

    path.write_text(f'{{"{key}": 42}}', encoding="utf-8")
    assert calibrate(0.9, "mock", 1, path=path) is None
