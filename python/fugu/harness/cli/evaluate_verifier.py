"""Verifier reliability eval — measure the Python runner's mock behaviour
against a fixture suite.

The plan scopes the mock-backend path: the runner's mock heuristics pick a
winner and surface judge-manipulation flags, both of which are compared
against ``expected_winner`` and ``expected_failure_flags`` in each fixture
row. A two-row fixture can therefore exercise the "clean winner" and
"judge-manipulation flag" paths in <1s.

Real (non-mock) backends are out of scope here; the CLI accepts a backend
parameter so future wiring can plug in, but only ``mock`` is currently
implemented. The runner module is invoked as a library — never as a
subprocess — so the path setup must make the script's directory importable.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import typer

from harness.security.prompt_injection import scan_for_judge_manipulation


# Where the lav_runner script lives. It is part of the .agents skill bundle
# rather than the harness package, so the CLI has to splice it onto sys.path
# before importing. The constant is module-level so tests can override the
# path to a fixture script. Anchored to the repo root (this file is
# harness/cli/evaluate_verifier.py -> parents[2]) so the default resolves
# correctly no matter the process working directory.
_REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNNER_PATH = _REPO_ROOT / ".agents/skills/llm-as-verifier/scripts/lav_runner.py"


def _load_runner_module(runner_path: Path) -> Any:
    """Import the lav_runner module by file path, without registering it
    under a fixed sys.modules key. A fresh import per call keeps the path
    setup testable and avoids stale state across invocations."""
    runner_path = Path(runner_path).resolve()
    spec = importlib.util.spec_from_file_location("lav_runner_for_eval", runner_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise RuntimeError(f"could not load runner module from {runner_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _normalize_candidate(candidate: dict) -> dict:
    """Translate an eval-fixture candidate into the runner's expected shape.

    The fixture uses ``id/summary/content/evidence``; the runner wants
    ``id/summary/content/evidence`` too, so this is mostly a passthrough
    with light defaults to keep the runner's stricter schema happy.
    """
    return {
        "id": candidate.get("id") or candidate.get("label", "candidate"),
        "summary": candidate.get("summary", ""),
        "content": candidate.get("content", ""),
        "evidence": candidate.get("evidence", []),
    }


def _build_runner_config(
    row: dict,
    candidates: list[dict],
    n_verifications: int,
    model: str = "mock",
    mock: bool = True,
    criteria: list[dict] | None = None,
) -> dict:
    """Translate a fixture row into a ``run_compare`` config."""
    if criteria is None:
        contract = row.get("task_contract", {})
        acceptance = contract.get("acceptance_criteria") or ["Overall correctness"]
        criteria = [
            {"id": f"c{i}", "name": text[:60] or f"criterion-{i}", "description": text}
            for i, text in enumerate(acceptance)
        ]
    contract = row.get("task_contract", {})
    task_text = contract.get("user_request") or contract.get("title") or row.get("eval_task_id", "verifier-eval")
    return {
        "mode": "compare",
        "task": task_text,
        "context": "",
        "criteria": criteria,
        "candidates": candidates,
        "n_verifications": n_verifications,
        "granularity": 20,
        "model": model,
        "mock": mock,
    }


def _row_position_bias(result: dict) -> tuple[bool, float]:
    """Derive a position-bias signal from a compare result without extra calls.

    Each criterion reports ``swap_consistency`` — whether the original (A/B) and
    swapped (B/A) orderings agreed on the higher-scoring candidate BEFORE the
    swap-and-aggregate step canceled the order. A row is "position-biased" if any
    criterion's swap_consistency dropped below 1.0. Returns (biased, min_consistency).
    The deterministic mock is always order-invariant (1.0), so this stays 0.0 for mock.
    """
    consistencies = [
        crit.get("swap_consistency", 1.0)
        for pair in result.get("pairwise", [])
        for crit in pair.get("criteria", [])
    ]
    if not consistencies:
        return False, 1.0
    lowest = min(consistencies)
    return lowest < 1.0, lowest


def _row_flags(candidates: list[dict]) -> list[str]:
    """Scan every candidate's content/summary for judge-manipulation
    patterns. The runner does not currently surface these, so the CLI does
    the scan itself — keeps the wiring honest about where the data comes
    from and avoids coupling to runner internals."""
    flags: set[str] = set()
    for candidate in candidates:
        text = (candidate.get("content", "") or "") + "\n" + (candidate.get("summary", "") or "")
        flags.update(scan_for_judge_manipulation(text))
    return sorted(flags)


def _winner_from_compare_result(result: dict, candidates: list[dict]) -> str | None:
    """Pull the chosen winner out of the runner's compare output. The
    runner returns either ``"tie"`` (string) or a ranking with the winning
    candidate id as ``ranking[0]["id"]``."""
    if not result:
        return None
    if result.get("winner") in (None, "tie"):
        return "tie"
    winner = result.get("winner")
    if isinstance(winner, dict):
        return winner.get("id")
    return None


def _evaluate_row(
    row: dict,
    runner_module: Any,
    n_verifications: int,
    model: str = "mock",
    mock: bool = True,
    client: Any = None,
) -> dict:
    """Run one fixture row through the verifier and compare to expectations.

    Defaults to the deterministic mock backend (``client=None``). Pass a real
    ``model``, ``mock=False``, and a live ``client`` to grade a real verifier."""
    raw_candidates = row.get("candidates", [])
    candidates = [_normalize_candidate(c) for c in raw_candidates]
    expected_winner = row.get("expected_winner", "tie")
    expected_flags = set(row.get("expected_failure_flags", []))

    config = _build_runner_config(row, candidates, n_verifications, model=model, mock=mock)
    result = runner_module.run_compare(client, config)
    actual_winner = _winner_from_compare_result(result, candidates)
    actual_flags = _row_flags(candidates)
    position_biased, min_swap_consistency = _row_position_bias(result)

    correct_winner = actual_winner == expected_winner
    if expected_flags:
        matched = expected_flags & set(actual_flags)
        row_flag_recall = len(matched) / len(expected_flags)
    else:
        row_flag_recall = 1.0

    return {
        "task_id": row.get("eval_task_id") or row.get("task_contract", {}).get("task_id"),
        "category": row.get("category"),
        "expected_winner": expected_winner,
        "actual_winner": actual_winner,
        "winner_correct": correct_winner,
        "position_biased": position_biased,
        "min_swap_consistency": round(min_swap_consistency, 4),
        "expected_failure_flags": sorted(expected_flags),
        "actual_failure_flags": actual_flags,
        "row_flag_recall": row_flag_recall,
    }


def _build_report(rows: list[dict], model: str = "mock") -> dict:
    """Aggregate the per-row results into the report JSON shape.

    ``position_bias_rate`` is the fraction of rows whose original/swapped orderings
    disagreed before swap-and-aggregate (derived from per-criterion swap_consistency).
    The deterministic mock is order-invariant, so it reports 0.0; real models expose
    their residual order sensitivity here.
    """
    total = len(rows)
    correct = sum(1 for r in rows if r["winner_correct"])
    accuracy = (correct / total) if total else 0.0

    decisive_rows = [r for r in rows if r["expected_winner"] != "tie"]
    decisive_correct = sum(1 for r in decisive_rows if r["winner_correct"])
    decisive_accuracy = (decisive_correct / len(decisive_rows)) if decisive_rows else 0.0

    tie_count = sum(1 for r in rows if r["actual_winner"] == "tie")
    tie_rate = (tie_count / total) if total else 0.0

    position_biased = sum(1 for r in rows if r.get("position_biased"))
    position_bias_rate = (position_biased / total) if total else 0.0

    expected_flag_total = sum(len(r["expected_failure_flags"]) for r in rows)
    matched_flag_total = int(round(sum(r["row_flag_recall"] * len(r["expected_failure_flags"]) for r in rows)))
    flag_recall = (matched_flag_total / expected_flag_total) if expected_flag_total else 1.0

    by_cat: dict[str, dict[str, int]] = {}
    for r in rows:
        slot = by_cat.setdefault(r.get("category") or "uncategorized", {"total": 0, "correct": 0})
        slot["total"] += 1
        slot["correct"] += 1 if r["winner_correct"] else 0
    category_accuracy = {c: round(v["correct"] / v["total"], 4) for c, v in sorted(by_cat.items())}

    return {
        "model": model,
        "total": total,
        "n": total,
        "accuracy": accuracy,
        "decisive_accuracy": decisive_accuracy,
        "tie_rate": tie_rate,
        "position_bias_rate": position_bias_rate,
        "position_bias_rate_available": True,
        "flag_recall": flag_recall,
        "category_accuracy": category_accuracy,
        "rows": rows,
    }


def evaluate_verifier(
    suite: Path = typer.Option(..., "--suite", exists=True),
    backend: str = typer.Option("mock", "--backend"),
    model: str = typer.Option(
        "mock",
        "--model",
        help="Verifier model id. 'mock' (default) uses the deterministic backend; a "
        "real id (e.g. cx/gpt-5.5, kimi/kimi-k2.6, minimax/MiniMax-M3) grades a live "
        "model via 9router (needs 9ROUTER_API_KEY / NINEROUTER_API_KEY).",
    ),
    output: Path | None = typer.Option(None, "--output"),
    runner_path: Path = typer.Option(DEFAULT_RUNNER_PATH, "--runner-path"),
    n_verifications: int = typer.Option(1, "--n-verifications"),
    limit: int = typer.Option(0, "--limit", help="Cap the number of rows graded (0 = all)."),
) -> None:
    """Run the verifier-reliability eval and emit the report JSON.

    Defaults to the deterministic mock backend. Pass ``--model <real-id>`` to grade a
    live verifier model through 9router and get accuracy / decisive_accuracy / tie_rate
    / position_bias_rate / flag_recall / per-category accuracy for that model.
    """
    runner = _load_runner_module(runner_path)
    use_mock = model == "mock"
    if use_mock and backend != "mock":
        raise typer.BadParameter(
            f"unsupported backend: {backend!r}; only 'mock' is implemented "
            f"(or pass --model <real-id> to grade a live model)"
        )
    client = runner.create_judge_client(model, mock=use_mock)

    rows: list[dict] = []
    for line in suite.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if limit and len(rows) >= limit:
            break
        row = json.loads(stripped)
        rows.append(_evaluate_row(row, runner, n_verifications, model=model, mock=use_mock, client=client))

    report = _build_report(rows, model=model)
    rendered = json.dumps(report, indent=2)
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    typer.echo(rendered)
