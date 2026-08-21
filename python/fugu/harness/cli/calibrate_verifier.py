"""Fit Platt calibration for the swap-and-aggregate verifier's raw pairwise
scores, using kingkillery/llm-as-a-verifier's task-disjoint train/held-out
split and ECE / ranking-accuracy reporting (the optional `verifier` extra
in pyproject.toml).

Why: `run_compare`'s `pair_mean_a`/`pair_mean_b` is the judge's raw 0-1
confidence, not a calibrated probability -- an LLM judge saying "0.85"
does not reliably mean "85% chance A is actually better", and that skew is
invisible today because nothing checks the raw score against real
outcomes. This command closes that gap using the labeled eval suites,
whose gold winners were independently blind-re-labeled (see
`evals/verifier/labeled/README.md`).

Every row is run through the REAL `run_compare` path (via
`_build_runner_config`/`_load_runner_module`, the same helpers
`evaluate-verifier` uses), never a hand-rolled reimplementation, so the
fitted calibration matches exactly what production traffic sees.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import typer

from harness.cli.evaluate_verifier import (
    DEFAULT_RUNNER_PATH,
    _build_runner_config,
    _load_runner_module,
    _normalize_candidate,
)
from harness.fusion.verifier_calibration import (
    CANONICAL_CALIBRATION_CRITERIA,
    compute_criteria_digest,
    judge_config_key,
    resolve_path,
    save_entry,
)

CRITERION_ID = "overall"


def _require_verifier_core():
    """Import kingkillery/llm-as-a-verifier's calibration primitives. Only
    the FIT path needs this optional dependency -- `verifier_calibration.py`
    (the apply side, loaded by `lav_runner.py` on every comparison) is
    self-contained and never requires it."""
    try:
        from scripts.verifier_core import calibrate_and_evaluate, compute_input_digest
    except ImportError as exc:
        raise typer.BadParameter(
            "calibrate-verifier needs the optional 'verifier' extra "
            "(kingkillery/llm-as-a-verifier). Install it editable from a local "
            "checkout first, e.g.:\n"
            "  pip install -e /path/to/llm-as-a-verifier\n"
            "  pip install -e python/fugu[verifier]"
        ) from exc
    return calibrate_and_evaluate, compute_input_digest


def _load_rows(paths: list[Path]) -> list[dict]:
    rows: list[dict] = []
    for suite in paths:
        for line in suite.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped:
                rows.append(json.loads(stripped))
    return rows


def calibrate_verifier(
    labeled: list[Path] = typer.Option(
        ...,
        "--labeled",
        exists=True,
        help="One or more labeled JSONL suites (task-disjoint by eval_task_id); "
        "pass each evals/verifier/labeled/tasks*.jsonl file to pool into the fit. "
        "The train/held-out split is decided internally, at the task level, by "
        "calibrate_and_evaluate -- never hand-split here.",
    ),
    model: str = typer.Option(
        "mock",
        "--model",
        help="Verifier model id. 'mock' (default) uses the deterministic backend; a "
        "real id grades a live model via 9router (needs 9ROUTER_API_KEY / NINEROUTER_API_KEY). "
        "The fitted calibration is only ever applied to comparisons run under this "
        "exact model + --n-verifications, never a different one.",
    ),
    n_verifications: int = typer.Option(5, "--n-verifications"),
    runner_path: Path = typer.Option(DEFAULT_RUNNER_PATH, "--runner-path"),
    output: Path | None = typer.Option(None, "--output", help="Defaults to resolve_path()'s lookup chain."),
) -> None:
    """Score every labeled row through the real run_compare path, fit Platt
    scaling on a task-level train fold, and report held-out ECE / ranking
    accuracy before vs after -- then persist (a, b) keyed to this exact
    (model, n_verifications, granularity) configuration.

    Rows whose expected_winner is "tie" are excluded: Platt calibration
    needs a binary (raw_score, actual_outcome) pair per candidate, and a
    tie row has no well-defined winner to supply that label.
    """
    calibrate_and_evaluate, compute_input_digest = _require_verifier_core()

    runner = _load_runner_module(runner_path)
    if not hasattr(runner, "verifier_protocol_digest") or not callable(runner.verifier_protocol_digest):
        raise typer.BadParameter(
            f"The loaded verifier runner at {runner_path} does not expose a callable "
            "'verifier_protocol_digest()' function. Cannot determine prompt protocol digest; "
            "refusing to fit calibration against an untracked prompt."
        )
    use_mock = model == "mock"
    client = runner.create_judge_client(model, mock=use_mock)

    rows = _load_rows(labeled)

    tasks: dict[str, list[dict]] = {}
    scores: dict[str, dict] = {}
    skipped_ties = 0
    skipped_malformed = 0
    batch_prompt_digest: str | None = None
    batch_criteria_digest: str | None = None

    for row in rows:
        expected_winner = row.get("expected_winner", "tie")
        if expected_winner not in ("A", "B"):
            skipped_ties += 1
            continue

        raw_candidates = row.get("candidates", [])
        candidates = [_normalize_candidate(c) for c in raw_candidates]
        if len(candidates) != 2:
            skipped_malformed += 1
            continue

        task_name = row.get("eval_task_id") or row.get("task_contract", {}).get("task_id")
        if not task_name:
            skipped_malformed += 1
            continue

        config = _build_runner_config(
            row,
            candidates,
            n_verifications,
            model=model,
            mock=use_mock,
            criteria=CANONICAL_CALIBRATION_CRITERIA,
        )
        result = runner.run_compare(client, config)
        pairwise = result.get("pairwise") or []
        if not pairwise:
            skipped_malformed += 1
            continue
        pair = pairwise[0]

        trace_a, trace_b = candidates[0]["content"], candidates[1]["content"]
        tasks[task_name] = [
            {"problem": task_name, "trace": trace_a, "trial_name": "A", "reward": 1 if expected_winner == "A" else 0},
            {"problem": task_name, "trace": trace_b, "trial_name": "B", "reward": 1 if expected_winner == "B" else 0},
        ]
        row_gt_note = runner.effective_ground_truth_note(config.get("ground_truth_note"))
        row_granularity = config.get("granularity", 20)
        row_prompt_digest = runner.verifier_protocol_digest(
            ground_truth_note=row_gt_note, granularity=row_granularity
        )
        row_criteria_digest = compute_criteria_digest(config["criteria"])
        if not isinstance(row_prompt_digest, str) or len(row_prompt_digest) != 16:
            raise typer.BadParameter(
                f"Runner verifier_protocol_digest() returned an invalid digest: {row_prompt_digest!r}"
            )
        if batch_prompt_digest is None:
            batch_prompt_digest = row_prompt_digest
        elif row_prompt_digest != batch_prompt_digest:
            raise typer.BadParameter(
                "calibrate-verifier cannot fit a single calibration across rows with "
                "differing ground_truth_notes or protocol digests."
            )
        if batch_criteria_digest is None:
            batch_criteria_digest = row_criteria_digest
        elif row_criteria_digest != batch_criteria_digest:
            raise typer.BadParameter(
                "calibrate-verifier cannot fit a single calibration across rows with differing criteria."
            )
        prompt_digest = batch_prompt_digest
        criteria_digest = batch_criteria_digest
        judge_key = judge_config_key(
            model,
            n_verifications,
            prompt_digest=prompt_digest,
            criteria_digest=criteria_digest,
            scorer_id=runner.SCORER_IMPLEMENTATION_ID,
        )
        scores[f"{CRITERION_ID}|{task_name}|0,1|0"] = {
            "score_i": pair["score_a"],
            "score_j": pair["score_b"],
            # n_reps=1 => `_pair_order_for_rep(0, 1)` is always "ij"; a
            # single fused observation (`run_compare`'s already-aggregated
            # pair_mean) stands in for one rep, since the fit target is the
            # production score itself, not its internal per-call judgments.
            "order": "ij",
            "judge_config_hash": judge_key,
            "input_digest": compute_input_digest(task_name, trace_a, trace_b),
            "model_version": model,
        }

    swing_tasks = list(tasks.keys())
    if batch_prompt_digest is None or batch_criteria_digest is None:
        raise typer.BadParameter("No valid labeled rows were processed to determine calibration digests.")
    prompt_digest = batch_prompt_digest
    criteria_digest = batch_criteria_digest
    judge_key = judge_config_key(
        model,
        n_verifications,
        prompt_digest=prompt_digest,
        criteria_digest=criteria_digest,
        scorer_id=runner.SCORER_IMPLEMENTATION_ID,
    )
    report = calibrate_and_evaluate(tasks, swing_tasks, scores, [CRITERION_ID], judge_key, n_reps=1)

    rendered = json.dumps(
        {
            "total_rows": len(rows),
            "skipped_tie_rows": skipped_ties,
            "skipped_malformed_rows": skipped_malformed,
            "pooled_tasks": len(tasks),
            **report,
        },
        indent=2,
    )
    typer.echo(rendered)

    if not report.get("available"):
        typer.echo(
            "Calibration unavailable (too few task-disjoint labeled rows with complete "
            "judgments on both the train and held-out fold); nothing saved.",
            err=True,
        )
        raise typer.Exit(code=1)

    if report["platt_a"] <= 0:
        # sigmoid(a*s+b) only preserves the raw score's ordering when a>0;
        # a<=0 means the fit found no positive relationship between the raw
        # score and the actual outcome on this train fold (or an inverse
        # one) -- applying it downstream would silently invert what the
        # "calibrated" score means without ever telling the caller. Per
        # `ranking_accuracy`'s own contract (a<=0 is documented there as
        # "a red flag worth surfacing, not hiding"), refuse to save it
        # rather than let it degrade or invert `run_compare`'s tournament
        # outcome as an unlabeled side effect.
        typer.echo(
            f"Fitted Platt slope a={report['platt_a']!r} is not positive, so "
            "calibration would not preserve the raw score's ordering; refusing "
            "to save. This usually means the raw score carries little or no "
            "signal on this train fold -- inspect held_out_bins_before/after "
            "above rather than trusting a monotonic-order guarantee.",
            err=True,
        )
        raise typer.Exit(code=1)

    entry = {
        "config_digest": judge_key,
        "prompt_digest": prompt_digest,
        "criteria_digest": criteria_digest,
        "scorer_id": runner.SCORER_IMPLEMENTATION_ID,
        "platt_a": report["platt_a"],
        "platt_b": report["platt_b"],
        "fitted_at": datetime.now(timezone.utc).isoformat(),
        "model": model,
        "n_verifications": n_verifications,
        "train_tasks": report["train_tasks"],
        "held_out_tasks": report["held_out_tasks"],
        "train_tasks_used": report["train_tasks_used"],
        "held_out_tasks_used": report["held_out_tasks_used"],
        "ece_before": report["ece_before"],
        "ece_after": report["ece_after"],
        "ranking_accuracy_before": report["ranking_accuracy_before"],
        "ranking_accuracy_after": report["ranking_accuracy_after"],
        "source_suites": [str(p) for p in labeled],
    }
    resolved_output = resolve_path(output)
    save_entry(judge_key, entry, resolved_output)
    typer.echo(f"Saved calibration for key={judge_key} to {resolved_output}")
