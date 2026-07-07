"""MCP server for pi-llm-as-verifier.

Exposes the core fusion-meta-harness operations as MCP tools so any MCP client
(Claude Desktop, Cursor, Zed, etc.) can call the verifier without touching the CLI.

Start:
    python mcp_server.py                  # stdio transport (default, for Claude Desktop)
    python mcp_server.py --transport sse  # SSE transport (for web/remote clients)

Or via the installed entry point:
    fmh-mcp

Tools exposed:
    verifier_fusion_compare  — swap-and-aggregate pairwise compare
    verifier_fusion_audit    — single-candidate rubric scoring
    evaluate_verifier        — run accuracy/flag-recall report against a fixture suite
    run_task                 — full fusion pipeline from a TaskContract JSON file
    inspect_run              — retrieve stored run result JSON
    frontier                 — list frontier candidates from SQLite index
    rqgm_search              — Red Queen Godel Machine co-evolutionary search
"""

from __future__ import annotations

import functools
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
except ModuleNotFoundError as exc:  # pragma: no cover - install-ergonomics guard
    raise ModuleNotFoundError(
        "The 'mcp' package is required to run the pi-llm-as-verifier MCP server but is "
        "not installed. It ships as an optional extra — install it with:\n"
        "    pip install -e .[mcp]\n"
        "(or `pip install mcp`)."
    ) from exc

mcp = FastMCP("pi-llm-as-verifier")


def _tool_safe(fn):
    """Wrap a tool body so any exception becomes a structured JSON error string.

    Applied UNDER @mcp.tool() (i.e. ``@mcp.tool()`` then ``@_tool_safe``) so FastMCP
    introspects the wrapped callable. functools.wraps copies __wrapped__/__signature__
    and the type-hinted annotations, so FastMCP still builds the correct input schema
    and keeps every parameter (verified against mcp 1.26.0).
    """
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - surface as JSON, never a raw traceback
            return json.dumps({"error": str(exc), "error_type": type(exc).__name__})

    return wrapper

_RUNNER_PATH = Path(__file__).parent / ".agents/skills/llm-as-verifier/scripts/lav_runner.py"
_RUNS_ROOT = Path(__file__).parent / "runs"

_DEFAULT_CRITERIA = [
    {"id": "correctness", "name": "Correctness",
     "description": "The candidate fully satisfies the stated task requirement with observable evidence."},
    {"id": "evidence_quality", "name": "Evidence quality",
     "description": "Key claims are grounded in concrete artifacts such as tests, logs, diffs, or citations."},
    {"id": "reasoning_robustness", "name": "Reasoning robustness",
     "description": "The reasoning is coherent, criterion-specific, and handles likely edge cases."},
]


_runner_cache: Any = None


def _load_runner() -> Any:
    global _runner_cache
    if _runner_cache is not None:
        return _runner_cache
    spec = importlib.util.spec_from_file_location("lav_runner_mcp", _RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"lav_runner not found at {_RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _runner_cache = module
    return module


def _make_client(runner: Any, model: str, mock: bool) -> Any:
    """Create the appropriate backend client for lav_runner."""
    if mock:
        return None
    if runner._is_openai_compatible(model):
        # Forward the model so create_openai_client can default the base URL to the
        # local 9router proxy for 9router-routed IDs (kimi/..., cx/..., etc.).
        return runner.create_openai_client(model=model)
    return runner.create_gemini_client()


def _normalize_evidence(evidence: Any) -> list[dict]:
    """Coerce evidence to list[{"label": str, "content": str}].

    Accepts:
      - list of dicts (already correct)
      - list of strings (promoted to {"label": "evidence", "content": s})
      - None / missing
    """
    if not isinstance(evidence, list):
        return []
    result = []
    for item in evidence:
        if isinstance(item, dict):
            result.append(item)
        elif isinstance(item, str) and item.strip():
            result.append({"label": "evidence", "content": item.strip()})
    return result


def _normalize_candidates(candidates: list[dict]) -> list[dict]:
    return [
        {**c, "evidence": _normalize_evidence(c.get("evidence"))}
        for c in candidates
    ]


def _build_config(
    mode: str,
    task: str,
    candidates: list[dict],
    criteria: list[dict],
    n_verifications: int,
    mock: bool,
    model: str,
) -> dict:
    return {
        "mode": mode,
        "task": task,
        "context": "",
        "ground_truth_note": "",
        "criteria": criteria,
        "candidates": _normalize_candidates(candidates),
        "n_verifications": n_verifications,
        "granularity": 20,
        "model": model,
        "mock": mock,
    }


@mcp.tool()
@_tool_safe
def verifier_fusion_compare(
    task: str,
    candidates: str,
    criteria: str = "",
    n_verifications: int = 5,
    model: str = "mock",
    mock: bool = False,
) -> str:
    """Run swap-and-aggregate pairwise comparison across a set of candidates.

    Args:
        task: Task description for the verifier prompt.
        candidates: JSON array of candidates. Each item: {"id": str, "content": str,
                    "summary": str (optional),
                    "evidence": [{"label": str, "content": str}, ...] (optional)}.
        criteria: JSON array of {"id", "name", "description"} criteria. Omit to use
                  the default 3-criterion rubric (correctness, evidence_quality,
                  reasoning_robustness).
        n_verifications: Verifier samples per criterion per ordering (1-8). Each
                         sample runs both A→B and B→A, so actual API calls are 2×.
        model: Model to use as verifier. Use "mock" (default) for no API calls.
               For real LLMs via 9router (requires 9ROUTER_API_KEY or
               NINEROUTER_API_KEY env var):
                 "kimi/kimi-k2.6"                  — Kimi K2.6 reasoning ✅
                 "minimax/MiniMax-M3"               — MiniMax M3 1M context ✅
                 "minimax/MiniMax-M2.7"             — MiniMax M2.7 ✅
                 "cx/gpt-5.5"                       — Codex GPT-5.5 (Codex Pro)
                 "ag/gemini-3.5-flash-low"          — Antigravity Gemini (low)
                 "cc/claude-sonnet-4-6"             — Claude via OAuth
                 "deepseek-v4-flash"                — DeepSeek V4 fast
                 "gemini-3-5-flash-medium-round-robin" — Gemini medium pool (combo)
               For Gemini direct (requires GEMINI_API_KEY):
                 "gemini-2.5-flash"
        mock: Force mock backend regardless of model value.

    Returns:
        JSON string with winner, ranking, pairwise breakdowns, vote_margin, and
        swap_consistency per criterion.
    """
    cands = json.loads(candidates)
    crits = json.loads(criteria) if criteria.strip() else _DEFAULT_CRITERIA
    effective_mock = mock or model == "mock"
    runner = _load_runner()
    # Coerce plain-string evidence to {label, content} BEFORE normalize_input (which
    # otherwise drops non-dict evidence), then let the runner validate/coerce the rest.
    config = _build_config("compare", task, cands, crits, n_verifications, effective_mock, model)
    config = runner.normalize_input(config)
    client = _make_client(runner, model, effective_mock)
    result = runner.run_compare(client, config)
    return json.dumps(result, indent=2)


@mcp.tool()
@_tool_safe
def verifier_fusion_audit(
    task: str,
    candidate: str,
    criteria: str = "",
    n_verifications: int = 5,
    model: str = "mock",
    mock: bool = False,
) -> str:
    """Score a single candidate against all rubric criteria.

    Args:
        task: Task description for the verifier prompt.
        candidate: JSON object for the single candidate: {"id": str, "content": str,
                   "summary": str (optional), "evidence": list (optional)}.
        criteria: JSON array of {"id", "name", "description"} criteria. Omit to use
                  the default 3-criterion rubric.
        n_verifications: Verifier samples per criterion (1-8).
        model: Model identifier (e.g. "mock", "cx/gpt-5.5"). Real models route via
               9router (set 9ROUTER_API_KEY / NINEROUTER_API_KEY).
        mock: Force mock backend.

    Returns:
        JSON string with overall_score, vote_margin, and per-criterion breakdowns.
    """
    cand = json.loads(candidate)
    crits = json.loads(criteria) if criteria.strip() else _DEFAULT_CRITERIA
    effective_mock = mock or model == "mock"
    runner = _load_runner()
    config = _build_config("audit", task, [cand], crits, n_verifications, effective_mock, model)
    config = runner.normalize_input(config)
    client = _make_client(runner, model, effective_mock)
    result = runner.run_audit(client, config)
    return json.dumps(result, indent=2)


@mcp.tool()
@_tool_safe
def evaluate_verifier(
    suite_path: str,
    n_verifications: int = 1,
    model: str = "mock",
) -> str:
    """Grade a verifier model against a labeled JSONL benchmark suite.

    Args:
        suite_path: Path to a .jsonl benchmark file. Each line is a row with
                    task_contract, candidates, expected_winner, expected_failure_flags.
                    Built-in suites: evals/verifier/labeled/tasks.jsonl (28 labeled
                    pairwise rows across 7 categories — the real model-quality benchmark),
                    evals/verifier/search/tasks.jsonl, evals/verifier/validation/tasks.jsonl.
        n_verifications: Verifier samples per row (default 1 for speed).
        model: Verifier model to grade. "mock" (default) is the deterministic floor;
               a real id (e.g. cx/gpt-5.5, kimi/kimi-k2.6, minimax/MiniMax-M3,
               ag/gemini-3.5-flash-low, cc/claude-sonnet-4-6) grades a live model via
               9router (needs 9ROUTER_API_KEY / NINEROUTER_API_KEY).

    Returns:
        JSON report with model, total, accuracy, decisive_accuracy, tie_rate,
        position_bias_rate, flag_recall, category_accuracy, and per-row outcomes.
    """
    from harness.cli.evaluate_verifier import (
        _load_runner_module,
        _evaluate_row,
        _build_report,
    )
    runner = _load_runner_module(_RUNNER_PATH)
    repo_root = Path(__file__).parent
    path = Path(suite_path)
    if not path.is_absolute():
        path = repo_root / path
    if not path.exists():
        available = sorted(
            str(p.relative_to(repo_root))
            for p in (repo_root / "evals").rglob("tasks.jsonl")
        )
        return json.dumps({
            "error": f"suite not found: {path}",
            "hint": "paths resolve relative to the repo root",
            "available": available,
        })
    use_mock = model == "mock"
    client = None if use_mock else runner.create_openai_client(model=model)
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped:
            rows.append(_evaluate_row(
                json.loads(stripped), runner, n_verifications,
                model=model, mock=use_mock, client=client,
            ))
    return json.dumps(_build_report(rows, model=model), indent=2)


@mcp.tool()
@_tool_safe
def run_task(
    task_path: str,
    backend: str = "mock",
    profile: str = "standard",
    explore_models: str = "",
) -> str:
    """Run a TaskContract JSON through the full fusion pipeline.

    The pipeline runs N candidate lanes in parallel, scores them, then fuses the
    best with a single synthesizer model (set FMH_SYNTHESIZER=openai and
    FMH_SYNTHESIZER_MODEL=<one model>; route it via 9router by setting
    OPENAI_BASE_URL=http://localhost:20128/v1).

    Args:
        task_path: Path to a TaskContract JSON file (absolute or relative to repo root).
        backend: Candidate backend when profile is not "explore"/"budget"/"dynamic".
                 One of: mock, anthropic_api, openai_api, kimi, minimax, 9router,
                 claude_code, codex_cli, local.
        profile: Lane routing profile. "standard" uses one backend for all lanes.
                 "explore" gives each lane a DISTINCT model (one option per lane) over
                 9router — the multi-model fan-out. "budget" rotates kimi/minimax;
                 "dynamic" rotates qwen/minimax/kimi/9router/openai_api.
        explore_models: Comma-separated 9router model IDs, one per lane, used only when
                 profile="explore". E.g.
                 "kimi/kimi-k2.6,minimax/MiniMax-M3,ag/gemini-3.5-flash-low,qwen3.7-plus,cx/gpt-5.5".
                 Empty -> FMH_EXPLORE_MODELS env -> verified default set. Passing a
                 non-empty value implies profile="explore".

    Returns:
        JSON summary with run_id, pass, final_score, winner candidate id, the per-lane
        model routing, errors, and warnings.
    """
    from harness.core.lifecycle import BACKENDS, Supervisor
    from harness.core.task_contract import load_task_contract
    from harness.routing.router import StaticRouter

    if backend not in BACKENDS:
        return json.dumps({
            "error": f"unknown backend: {backend!r}",
            "valid_backends": sorted(BACKENDS.keys()),
        })

    path = Path(task_path)
    if not path.is_absolute():
        path = Path(__file__).parent / path
    if not path.exists():
        return json.dumps({"error": f"task contract not found: {path}"})

    models = [m.strip() for m in explore_models.split(",") if m.strip()] or None
    if models and profile == "standard":
        profile = "explore"

    task = load_task_contract(path, Path(__file__).parent)

    # Surface the planned per-lane routing without re-running it.
    decision = StaticRouter(profile=profile, explore_models=models).route(task, backend=backend)
    lane_routing = [{"candidate_id": c.candidate_id, "backend": c.backend, "model": c.model} for c in decision.candidates]

    supervisor = Supervisor(runs_root=_RUNS_ROOT)
    state = supervisor.run_task(task, backend=backend, profile=profile, explore_models=models)

    # RunState exposes no pass/final_score/winner attributes — those live on disk.
    passed = (state.status == "passed")
    winner = state.selected_candidate_ids[0] if state.selected_candidate_ids else state.synthesis_id

    final_score = None
    score_path = Path(state.workspace_path).parent / "scores" / "final_score.json"
    try:
        if score_path.exists():
            final_score = json.loads(score_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        final_score = None

    return json.dumps({
        "run_id": state.run_id,
        "status": state.status,
        "passed": passed,
        "final_score": final_score,
        "winner": winner,
        "degraded": state.degraded,
        "profile": profile,
        "lane_routing": lane_routing,
        "errors": state.errors,
        "warnings": state.warnings,
    }, indent=2)


@mcp.tool()
@_tool_safe
def inspect_run(run_id: str, file: str = "run_state.json") -> str:
    """Read a stored artifact from a completed run.

    Args:
        run_id: The run ID (directory name under runs/).
        file: Relative path within the run directory to read.
              Common values: run_state.json, scores/final_score.json,
              verifier/model_verdict.json, candidates/<id>/result.json.

    Returns:
        Raw JSON content of the requested file, or an error message.
    """
    # Reject obviously-unsafe run_id up front (separators / parent refs).
    if "/" in run_id or "\\" in run_id or ".." in Path(run_id).parts:
        return json.dumps({"error": "invalid run_id"})

    runs_root = _RUNS_ROOT.resolve()
    base = (_RUNS_ROOT / run_id).resolve()
    target = (base / file).resolve()
    # Confine the resolved target to both the runs root and the specific run dir so a
    # crafted file like "../../mcp_server.py" or an absolute path cannot escape.
    if not (target.is_relative_to(runs_root) and target.is_relative_to(base)):
        return json.dumps({"error": "path escapes run directory"})

    if not target.exists():
        available = sorted(str(p.relative_to(base))
                           for p in base.rglob("*.json")) if base.exists() else []
        return json.dumps({"error": f"{file} not found in run {run_id}", "available": available[:20]})
    try:
        return target.read_text(encoding="utf-8")
    except OSError as exc:
        return json.dumps({"error": str(exc), "error_type": type(exc).__name__})


_FRONTIER_COLS = ["candidate_id", "search_score", "validation_score", "cost", "safety_failures"]


@mcp.tool()
@_tool_safe
def frontier(metric: str = "validation_score", limit: int = 10) -> str:
    """List top candidates from the SQLite frontier index.

    Args:
        metric: Column to sort by, one of: search_score, validation_score, cost,
                safety_failures (default: validation_score). The underlying query
                orders by validation_score then search_score; this re-sorts the
                resulting rows by the requested column (descending).
        limit: Maximum number of rows to return.

    Returns:
        JSON object {"frontier": [ {candidate_id, search_score, validation_score,
        cost, safety_failures}, ... ]}. On an empty index, a "note" is included.
    """
    from harness.experience.sqlite_store import SQLiteIndex

    sort_cols = _FRONTIER_COLS[1:]  # candidate_id is not a numeric sort key
    if metric not in sort_cols:
        return json.dumps({
            "error": f"unknown metric: {metric!r}",
            "valid_metrics": sort_cols,
        })

    _RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    raw = SQLiteIndex(db_path=_RUNS_ROOT / "index.sqlite3").frontier()
    rows = [dict(zip(_FRONTIER_COLS, r)) for r in raw]
    rows.sort(key=lambda r: (r.get(metric) is None, r.get(metric)), reverse=True)
    rows = rows[:limit]
    if not rows:
        return json.dumps({"frontier": [], "note": "no runs indexed yet"}, indent=2)
    return json.dumps({"frontier": rows}, indent=2, default=str)


@mcp.tool()
@_tool_safe
def rqgm_search(
    provider: str = "fmh",
    budget: int = 64,
    backend: str = "9router",
    model: str = "omp",
    task_suite: str = "rqgm",
    anchor_suite: str = "verifier/labeled",
    epsilon: float = 0.05,
    seed: int = 0,
) -> str:
    """Run the Red Queen Godel Machine co-evolutionary search.

    provider: "fmh" by default (real local 9router via model "omp") or
    "mock" for deterministic offline test mode.
    Returns a JSON summary: best node, best-belief, archive size, balanced
    utility, evaluator replacements, and retained record count. Requires the
    optional `red-queen-godel-machine` package.
    """
    try:
        from rqgm.runner import build_providers, result_to_dict
        from rqgm.search import RQGMConfig, RQGMSearch
    except ImportError as exc:
        raise RuntimeError(
            "rqgm not installed; pip install -e ../../../red-queen-godel-machine"
        ) from exc

    config = RQGMConfig(budget=budget, epsilon=epsilon, seed=seed)
    if provider == "fmh":
        from harness.rqgm_provider import FmhEvaluatorSlotProvider, FmhWorkspaceProvider

        workspace = FmhWorkspaceProvider(backend=backend, task_suite=task_suite, model=model)
        slots = {
            0: FmhEvaluatorSlotProvider(slot=0, backend=backend, anchor_suite=anchor_suite, model=model)
        }
    else:
        workspace, slots = build_providers("mock", config)
    result = RQGMSearch(workspace, slots, config).run()
    return json.dumps(result_to_dict(result), indent=2)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="pi-llm-as-verifier MCP server")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    if args.transport == "sse":
        # FastMCP.run() (mcp 1.26.0) accepts no host/port kwargs; the bind address
        # lives on mcp.settings.host / mcp.settings.port. Set them before run().
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        mcp.run(transport="sse")
    else:
        mcp.run(transport="stdio")
