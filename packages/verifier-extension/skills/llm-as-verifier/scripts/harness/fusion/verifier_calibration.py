"""Platt-scaling calibration for the swap-and-aggregate verifier's raw
pairwise scores.

`run_compare`'s `pair_mean_a`/`pair_mean_b` is the judge's raw 0-1
confidence, averaged across reps/orderings/criteria -- not a calibrated
probability. An LLM judge saying "0.85" does not reliably mean "85% chance
A is actually better"; judges tend to be systematically over- or
under-confident, and today nothing checks that skew against real outcomes.

This module is the *apply* side only, and is deliberately self-contained
(no external dependency): applying an already-fitted calibration must
never require the optional `verifier` extra (kingkillery/llm-as-a-verifier)
to be installed -- only *fitting* a new calibration does (see
`harness/cli/calibrate_verifier.py`).

A calibration fit is only valid for the exact verifier configuration it was
fitted against (model, repetition count, scoring granularity, prompt/protocol
digest); the registry is keyed and verified by `compute_verifier_config_digest(...)`
so a fit for one config/prompt is never silently applied to a different or modified
one, and a config with no fit or mismatched prompt digest reports "unavailable"
(None) rather than guessing.

The registry is deliberately NOT stored inside this package's own
directory: an installed (non-editable) `fugu` typically lands in
`site-packages`, which is often read-only and gets wiped/replaced on every
upgrade -- unsuitable for a mutable runtime artifact. `resolve_path`
instead resolves, in order, an explicit `path` argument, the
`FUGU_VERIFIER_CALIBRATION_PATH` env var, or a user-writable default under
the home directory (`~/.fugu/verifier_calibration.json`). Every lookup
re-resolves rather than binding a module-level constant at import time, so an
env var set after import (as tests commonly do) still takes effect.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any

ENV_OVERRIDE = "FUGU_VERIFIER_CALIBRATION_PATH"

DEFAULT_PROMPT_PROTOCOL = (
    "scale:20-point-A-to-T\n"
    "evidence_observations:3\n"
    "ground_truth_rule:prefer_concrete_evidence"
)

DEFAULT_PROMPT_DIGEST = hashlib.sha256(DEFAULT_PROMPT_PROTOCOL.encode("utf-8")).hexdigest()[:16]


def resolve_path(path: Path | str | None = None) -> Path:
    """Resolve the calibration registry location, in priority order:
    1. An explicit `path` argument, if given.
    2. The `FUGU_VERIFIER_CALIBRATION_PATH` env var, if set.
    3. `~/.fugu/verifier_calibration.json` -- a user-writable location that
       survives package upgrades/reinstalls, whether fugu is installed
       editable or as a regular (non-editable) package.
    """
    if path is not None:
        return Path(path)
    override = os.environ.get(ENV_OVERRIDE)
    if override:
        return Path(override)
    return Path.home() / ".fugu" / "verifier_calibration.json"


def compute_verifier_config_digest(
    model: str,
    n_verifications: int,
    granularity: int = 20,
    prompt_digest: str = DEFAULT_PROMPT_DIGEST,
) -> str:
    """Deterministic key identifying the verifier configuration a Platt fit
    is valid for. Recomputed from the model id, repetition count, scoring
    granularity, and prompt/protocol digest -- a fit for one configuration or
    prompt must never be silently reused for a different one; re-fitting under
    a new key is the only way to pick up a model, protocol, or prompt change."""
    canonical = json.dumps(
        {
            "granularity": granularity,
            "model": model,
            "n_verifications": n_verifications,
            "prompt_digest": prompt_digest,
        },
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def judge_config_key(
    model: str,
    n_verifications: int,
    granularity: int = 20,
    prompt_digest: str = DEFAULT_PROMPT_DIGEST,
) -> str:
    return compute_verifier_config_digest(model, n_verifications, granularity, prompt_digest)


def load_registry(path: Path | str | None = None) -> dict[str, Any]:
    """Read the full calibration registry. Missing file or unparseable
    content both resolve to an empty registry (never a crash) so the
    verifier keeps working uncalibrated when no fit has been saved yet."""
    resolved = resolve_path(path)
    if not resolved.exists():
        return {}
    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def load_entry(key: str, path: Path | str | None = None) -> dict[str, Any] | None:
    return load_registry(path).get(key)


def save_entry(key: str, entry: dict[str, Any], path: Path | str | None = None) -> None:
    """Read-modify-write: merges into the existing registry so fitting one
    configuration's calibration never clobbers another's."""
    resolved = resolve_path(path)
    registry = load_registry(resolved)
    registry[key] = entry
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8")


def apply_platt(raw_score: float, a: float, b: float) -> float:
    """calibrated_p = sigmoid(a * raw_score + b)."""
    z = float(a) * float(raw_score) + float(b)
    if z > 30:
        return 1.0
    if z < -30:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


def _valid_platt_entry(entry: Any, expected_digest: str | None = None) -> bool:
    """A registry entry is only trustworthy to apply if it is a dict whose
    config_digest matches the expected digest (if provided), platt_a is a
    finite, strictly positive number and platt_b is a finite number.
    Safely handles huge integer overflows, non-numeric values, and booleans.
    """
    if not isinstance(entry, dict):
        return False
    if expected_digest is not None and entry.get("config_digest") != expected_digest:
        return False
    a = entry.get("platt_a")
    b = entry.get("platt_b")
    if not isinstance(a, (int, float)) or isinstance(a, bool):
        return False
    if not isinstance(b, (int, float)) or isinstance(b, bool):
        return False
    try:
        float_a = float(a)
        float_b = float(b)
        if not math.isfinite(float_a) or not math.isfinite(float_b):
            return False
        return float_a > 0
    except (OverflowError, ValueError, TypeError):
        return False


def calibrate(
    raw_score: float,
    model: str,
    n_verifications: int,
    granularity: int = 20,
    prompt_digest: str = DEFAULT_PROMPT_DIGEST,
    path: Path | str | None = None,
) -> float | None:
    """Look up a fitted calibration for this exact verifier configuration
    and prompt digest, and apply it to `raw_score`. Returns None -- never a
    guessed or uncalibrated stand-in, and never a crash -- both when no
    calibration has been fitted for this configuration yet, and when the
    stored entry fails `_valid_platt_entry` (digest mismatch, non-positive,
    non-finite, missing, non-numeric, or overflow coefficients); callers must
    treat either case as "calibration unavailable" and simply omit the
    calibrated field, not fall back to treating the raw score as if it were
    calibrated."""
    try:
        digest = compute_verifier_config_digest(model, n_verifications, granularity, prompt_digest)
        entry = load_entry(digest, path)
        if entry is None or not _valid_platt_entry(entry, expected_digest=digest):
            return None
        return apply_platt(raw_score, entry["platt_a"], entry["platt_b"])
    except (OverflowError, ValueError, TypeError, KeyError):
        return None
