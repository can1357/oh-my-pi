"""``fmh rqgm`` -- run the Red Queen Godel Machine co-evolutionary search.

The RQGM algorithm lives in the standalone ``red-queen-godel-machine`` package
(an optional dependency). This command exposes it through FMH:

* default: ``--provider fmh --backend 9router --model omp`` for a real local 9router run.
* ``--provider mock`` -- deterministic/offline test mode (no model, no creds).
* ``--provider llm``  -- the package's generic OpenAI-compatible provider
  (requires ``--dataset`` and ``--anchor`` JSONL files).
"""

from __future__ import annotations

import json
from pathlib import Path

import typer

app = typer.Typer(no_args_is_help=True)

_INSTALL_HINT = (
    "rqgm (red-queen-godel-machine) is not installed.\n"
    "  pip install -e ../../../red-queen-godel-machine\n"
    "then enable the extra:\n"
    "  pip install -e '.[rqgm]'"
)


def _load_jsonl(path: str) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


@app.command("search")
def search(
    provider: str = typer.Option("fmh", "--provider", help="fmh | llm | mock"),
    budget: int = typer.Option(64, "--budget"),
    epsilon: float = typer.Option(0.05, "--epsilon"),
    alpha: float = typer.Option(0.6, "--alpha"),
    checkpoint_base: int = typer.Option(2, "--checkpoint-base"),
    backend: str = typer.Option("9router", "--backend", help="FMH backend for --provider fmh"),
    task_suite: str = typer.Option("rqgm", "--task-suite", help="eval suite for --provider fmh"),
    anchor_suite: str = typer.Option(
        "verifier/labeled", "--anchor-suite", help="labeled anchor suite for --provider fmh"
    ),
    seed: int = typer.Option(0, "--seed"),
    out: str = typer.Option("runs/rqgm", "--out", help="directory to persist run artifacts"),
    as_json: bool = typer.Option(False, "--json", help="emit JSON summary"),
    model: str = typer.Option("omp", "--model", help="model id for --provider fmh or llm"),
    base_url: str | None = typer.Option(None, "--base-url", help="OpenAI-compatible base url"),
    dataset: str | None = typer.Option(None, "--dataset", help="coder tasks JSONL for --provider llm"),
    anchor: str | None = typer.Option(None, "--anchor", help="labeled anchor JSONL for --provider llm"),
) -> None:
    try:
        from rqgm.runner import build_providers, persist_result, result_to_dict
        from rqgm.search import RQGMConfig, RQGMSearch
    except ImportError:
        typer.echo(_INSTALL_HINT, err=True)
        raise typer.Exit(1) from None

    config = RQGMConfig(
        budget=budget,
        epsilon=epsilon,
        alpha=alpha,
        checkpoint_base=checkpoint_base,
        seed=seed,
    )

    if provider == "fmh":
        from harness.rqgm_provider import FmhEvaluatorSlotProvider, FmhWorkspaceProvider

        workspace = FmhWorkspaceProvider(backend=backend, task_suite=task_suite, model=model)
        slots = {
            0: FmhEvaluatorSlotProvider(slot=0, backend=backend, anchor_suite=anchor_suite, model=model)
        }
    elif provider == "llm":
        if not dataset or not anchor:
            typer.echo("--provider llm requires --dataset and --anchor", err=True)
            raise typer.Exit(2)
        from rqgm.llm_providers import AnchorItem, OpenAIChatModel, Sample

        chat = OpenAIChatModel(model=model, base_url=base_url)
        tasks = [
            Sample(str(row.get("task_id", f"q{i}")), str(row.get("prompt_input", row.get("input", ""))), row.get("answer"))
            for i, row in enumerate(_load_jsonl(dataset))
        ]
        anchors = [
            AnchorItem(str(row.get("artifact", "")), "Accept" if str(row.get("label", "")).lower().startswith("a") else "Reject")
            for row in _load_jsonl(anchor)
        ]
        workspace, slots = build_providers("llm", config, model=chat, tasks=tasks, anchor=anchors)
    else:
        workspace, slots = build_providers("mock", config)

    search_obj = RQGMSearch(workspace, slots, config)
    result = search_obj.run()
    run_id = persist_result(result, search_obj.archive, out) if out else None

    if as_json:
        typer.echo(json.dumps(result_to_dict(result, run_id), indent=2))
        return

    if run_id:
        typer.echo(f"run_id           {run_id}")
    typer.echo(f"provider         {provider}" + (f" ({backend})" if provider == "fmh" else ""))
    typer.echo(f"best_node        {result.best_node_id}")
    typer.echo(f"best_belief      {result.best_belief:.4f}")
    typer.echo(f"balanced_util    {result.balanced_utility:.4f}")
    typer.echo(f"archive_size     {result.archive_size}")
    typer.echo(f"evaluations      {result.num_evaluations}")
    typer.echo(f"expansions       {result.num_expansions}")
    typer.echo(f"epochs           {result.epochs}")
    typer.echo(f"replacements     {len(result.replacements)}")
    for rep in result.replacements:
        typer.echo(
            f"  slot {rep.slot}: {rep.from_id} -> {rep.to_id} "
            f"(BB={rep.anchor_best_belief:.4f}, erased={rep.erased}, @{rep.at_eval})"
        )
    typer.echo(f"records_retained {result.records_retained}")


@app.command("benchmark")
def benchmark(
    budget: int = typer.Option(4, "--budget"),
    backend: str = typer.Option("9router", "--backend"),
    model: str = typer.Option("omp", "--model"),
    task_suite: str = typer.Option("rqgm", "--task-suite"),
    anchor_suite: str = typer.Option("verifier/labeled", "--anchor-suite"),
    max_tasks: int = typer.Option(1, "--max-tasks"),
    max_anchors: int = typer.Option(2, "--max-anchors"),
    seed: int = typer.Option(0, "--seed"),
    as_json: bool = typer.Option(False, "--json"),
) -> None:
    """Compare the seed workspace against an RQGM run on the same benchmark."""
    try:
        from rqgm.archive import Archive, ArchiveNode, UtilityRecord
        from rqgm.runner import result_to_dict
        from rqgm.search import RQGMConfig, RQGMSearch
    except ImportError:
        typer.echo(_INSTALL_HINT, err=True)
        raise typer.Exit(1) from None

    from harness.rqgm_provider import FmhEvaluatorSlotProvider, FmhWorkspaceProvider

    baseline_workspace = FmhWorkspaceProvider(
        backend=backend,
        task_suite=task_suite,
        model=model,
        max_tasks=max_tasks,
    )
    if not baseline_workspace.has_ground_truth():
        typer.echo(
            f"task suite {task_suite!r} has no gold_answer fields; cannot benchmark grounded coder improvement",
            err=True,
        )
        raise typer.Exit(2)
    baseline_slot = FmhEvaluatorSlotProvider(
        slot=0,
        backend=backend,
        anchor_suite=anchor_suite,
        model=model,
        max_anchors=max_anchors,
    )
    archive = Archive()
    seed_node = ArchiveNode("seed", None, workspace=baseline_workspace.seed())
    archive.add_node(seed_node)
    incumbent = baseline_slot.incumbent()
    current_epoch = {0: incumbent.evaluator_id}
    for role in baseline_workspace.roles():
        for task in role.tasks:
            evaluator = incumbent if role.kind == "evaluator_dependent" else None
            outcome = baseline_workspace.evaluate(seed_node, role, task, evaluator)
            slot = role.slot
            archive.add_record(
                UtilityRecord(
                    node_id="seed",
                    role=role.name,
                    task=task,
                    outcome=outcome,
                    dep=(slot,) if evaluator is not None and slot is not None else (),
                    criterion_tags={slot: incumbent.evaluator_id}
                    if evaluator is not None and slot is not None
                    else {},
                    epoch_vector=(1,),
                )
            )
    baseline_score = archive.balanced_utility(
        "seed",
        [role.name for role in baseline_workspace.roles()],
        current_epoch,
    )

    workspace = FmhWorkspaceProvider(
        backend=backend,
        task_suite=task_suite,
        model=model,
        max_tasks=max_tasks,
    )
    slot_provider = FmhEvaluatorSlotProvider(
        slot=0,
        backend=backend,
        anchor_suite=anchor_suite,
        model=model,
        max_anchors=max_anchors,
    )
    result = RQGMSearch(workspace, {0: slot_provider}, RQGMConfig(budget=budget, seed=seed)).run()
    payload = {
        "backend": backend,
        "model": model,
        "budget": budget,
        "baseline_balanced_utility": baseline_score,
        "rqgm_balanced_utility": result.balanced_utility,
        "absolute_delta": result.balanced_utility - baseline_score,
        "relative_delta": (
            (result.balanced_utility - baseline_score) / baseline_score if baseline_score else None
        ),
        "self_improved": result.balanced_utility > baseline_score,
        "result": result_to_dict(result),
    }
    if as_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"backend          {backend}")
    typer.echo(f"model            {model}")
    typer.echo(f"baseline_utility {baseline_score:.4f}")
    typer.echo(f"rqgm_utility     {result.balanced_utility:.4f}")
    typer.echo(f"absolute_delta   {payload['absolute_delta']:.4f}")
    typer.echo(f"self_improved    {payload['self_improved']}")


@app.command("inspect")
def inspect(
    run_id: str = typer.Argument(..., help="run id printed by `rqgm search`"),
    root: str = typer.Option("runs/rqgm", "--root", help="runs root directory"),
) -> None:
    summary = Path(root) / run_id / "summary.json"
    if not summary.exists():
        typer.echo(f"no run found at {summary}", err=True)
        raise typer.Exit(1)
    typer.echo(summary.read_text(encoding="utf-8"))

_REAL_WORLD_BACKENDS = frozenset({"auto", "codex_cli", "claude_code", "subprocess_cli"})


@app.command("evolve")
def evolve(
    budget: int = typer.Option(24, "--budget", help="number of evaluations"),
    suite: str = typer.Option("rqgm_code", "--suite", help="executable search suite under evals/"),
    holdout: str = typer.Option("holdout/rqgm_code", "--holdout", help="frozen executable holdout anchor"),
    backend: str = typer.Option("auto", "--backend", help="agentic backend for real workspace edits: auto | codex_cli | claude_code | subprocess_cli"),
    model: str = typer.Option("omp", "--model", help="strong model id (Stage 3)"),
    canary_backend: str = typer.Option("", "--canary-backend", help="cheap canary backend (default: --backend)"),
    canary_model: str = typer.Option("", "--canary-model", help="cheap canary model (default: --model)"),
    seed: int = typer.Option(0, "--seed"),
    root: str = typer.Option("harness_candidates", "--root", help="candidate workspace root"),
    apply: bool = typer.Option(False, "--apply/--dry-run", help="promote the best candidate's surface into the repo"),
    as_json: bool = typer.Option(False, "--json", help="emit JSON summary"),
) -> None:
    """Run the real-world RQGM loop: propose scaffold edits with a DE operator, score
    them by executable pass-rate under a cascade, sample parents proportionally to
    keep stepping stones, co-evolve an anchored verifier, and (with --apply) promote a
    scaffold that beats the seed on the forbidden held-out executable suite."""
    try:
        from harness.meta.evaluator import EvalInfraError
        from harness.rqgm_evolve import RqgmEvolver
    except ImportError:
        typer.echo(_INSTALL_HINT, err=True)
        raise typer.Exit(1) from None

    if backend not in _REAL_WORLD_BACKENDS:
        typer.echo(
            f"rqgm evolve requires an agentic editing backend, got {backend!r}; "
            f"choose one of {sorted(_REAL_WORLD_BACKENDS)}.",
            err=True,
        )
        raise typer.Exit(2)

    evolver = RqgmEvolver(
        suite=suite,
        holdout=holdout,
        backend=backend,
        model=model,
        canary_backend=canary_backend or None,
        canary_model=canary_model or None,
        budget=budget,
        seed=seed,
        root=root,
    )
    try:
        result = evolver.run()
    except EvalInfraError as exc:
        typer.echo(f"rqgm evolve aborted (infrastructure): {exc}", err=True)
        raise typer.Exit(2) from None
    except (OSError, ValueError, KeyError) as exc:
        typer.echo(f"rqgm evolve failed: {exc}", err=True)
        raise typer.Exit(2) from None

    if apply:
        evolver.apply_best(result)

    payload = result.to_dict()
    if as_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"best_candidate   {payload['best_candidate_id']}")
    typer.echo(f"seed_holdout     {payload['seed_holdout_pass']:.4f}")
    typer.echo(f"best_holdout     {payload['best_holdout_pass']:.4f}")
    typer.echo(f"holdout_delta    {payload['holdout_delta']:+.4f}")
    typer.echo(f"archive_size     {payload['archive_size']}")
    typer.echo(f"records_retained {payload['records_retained']}")
    typer.echo(f"evaluations      {payload['num_evaluations']}")
    typer.echo(f"expansions       {payload['num_expansions']}")
    typer.echo(f"sampled_parents  {payload['sampled_parents']}")
    typer.echo(f"replacements     {len(payload['replacements'])}")
    for rep in payload["replacements"]:
        typer.echo(
            f"  slot {rep['slot']}: {rep['from_id']} -> {rep['to_id']} "
            f"(BB={rep['anchor_best_belief']:.4f}, erased={rep['erased']}, @{rep['at_eval']})"
        )
    typer.echo(f"applied          {payload['applied']}")
