from __future__ import annotations

from pathlib import Path

from harness.core.task_contract import BudgetSpec, TaskContract
from harness.fugu.executor import FuguExecutor
from harness.fugu.topology import ScaffoldNode, ScaffoldPlan


def _task() -> TaskContract:
    return TaskContract(
        task_id="fugu_test",
        task_type="custom",
        title="Answer arithmetic",
        user_request="What is 2+2?",
        acceptance_criteria=["Return a non-empty answer"],
        budget=BudgetSpec(
            max_total_usd=1.0, max_candidate_usd=0.1, max_wall_clock_seconds=30
        ),
    )


def test_fugu_executor_single_mock_writes_scaffold_and_passes(tmp_path: Path) -> None:
    plan = ScaffoldPlan(
        mode="route",
        topology="single",
        nodes=[
            ScaffoldNode(model="mock", role="worker", instruction="answer directly")
        ],
        rationale="test",
    )

    state = FuguExecutor(tmp_path / "runs").execute(plan, _task(), backend="mock")

    assert state.status == "passed"
    assert state.final_artifacts.answer
    run_dir = tmp_path / "runs" / state.run_id
    assert (run_dir / "scaffold_plan.json").exists()
    assert (run_dir / "candidates" / "fugu_test_fugu_1" / "result.json").exists()
    assert (run_dir / "verifier" / "verifier_result.json").exists()


def test_fugu_executor_tree_mock_records_all_candidates(tmp_path: Path) -> None:
    plan = ScaffoldPlan(
        mode="orchestrate",
        topology="tree",
        nodes=[
            ScaffoldNode(model="mock", role="planner", instruction="plan"),
            ScaffoldNode(model="mock", role="critic", instruction="criticize"),
        ],
        aggregator="mock",
        rationale="test",
    )

    state = FuguExecutor(tmp_path / "runs").execute(plan, _task(), backend="mock")

    assert state.status == "passed"
    assert state.candidate_ids == ["fugu_test_fugu_1", "fugu_test_fugu_2"]


def test_executor_auth_failure_falls_back_to_minimax(
    tmp_path: Path, monkeypatch
) -> None:
    from harness.agents.base import AgentBackend, AgentRunRequest
    from harness.fusion.candidate_schema import CandidateResult, SelfAssessment
    from harness.core.errors import BackendError

    class FakeFuguBackend(AgentBackend):
        name = "mock"

        def run(self, request: AgentRunRequest) -> CandidateResult:
            if request.model == "stub-auth-failure/deepseek-v4-flash":
                raise BackendError("401 Invalid API-key")
            elif request.model == "minimax/MiniMax-M3":
                return CandidateResult(
                    candidate_id=request.candidate_id,
                    run_id=request.run_id,
                    agent_backend="mock",
                    model=request.model,
                    role=request.role,
                    prompt_variant=request.prompt_variant,
                    status="completed",
                    answer="minimax successfully solved this",
                    self_assessment=SelfAssessment(confidence=0.9, known_weaknesses=[]),
                    trace_path=request.trace_path,
                )
            raise BackendError(f"unexpected model: {request.model}")

    from harness.core.lifecycle import BACKENDS

    monkeypatch.setitem(BACKENDS, "mock", FakeFuguBackend())

    from harness.fugu.pool import Worker
    from harness.fugu.health import WorkerHealth

    qwen = Worker(
        id="stub-auth-failure/deepseek-v4-flash",
        tags=("coding",),
        cost_tier="free",
        latency_tier="fast",
        provider="stub",
        family="deepseek",
        reliability_tier="variable",
        context_tier="normal",
    )
    minimax = Worker(
        id="minimax/MiniMax-M3",
        tags=("coding", "long-context"),
        cost_tier="budget",
        latency_tier="balanced",
        provider="minimax",
        family="minimax",
        reliability_tier="stable",
        context_tier="long",
    )
    pool = [qwen, minimax]
    health = WorkerHealth()

    executor = FuguExecutor(tmp_path / "runs", pool=pool, health=health)
    plan = ScaffoldPlan(
        mode="route",
        topology="single",
        nodes=[
            ScaffoldNode(
                model="stub-auth-failure/deepseek-v4-flash",
                role="worker",
                instruction="coding task",
            )
        ],
        rationale="test",
    )

    state = executor.execute(plan, _task(), backend="mock")

    print("ERRORS:", state.errors)
    print("WARNINGS:", state.warnings)
    assert state.status == "passed"
    run_dir = tmp_path / "runs" / state.run_id
    import json

    cand_result = json.loads(
        (run_dir / "candidates/fugu_test_fugu_1/result.json").read_text(
            encoding="utf-8"
        )
    )
    assert cand_result["model"] == "minimax/MiniMax-M3"

    fallbacks = json.loads(
        (run_dir / "candidates/fugu_test_fugu_1/fallbacks.json").read_text(
            encoding="utf-8"
        )
    )
    assert len(fallbacks["attempts"]) == 2
    assert fallbacks["attempts"][0]["model"] == "stub-auth-failure/deepseek-v4-flash"
    assert fallbacks["attempts"][0]["fallback_reason"] == "auth"
    assert fallbacks["attempts"][1]["model"] == "minimax/MiniMax-M3"
    assert fallbacks["attempts"][1]["fallback_reason"] is None
    assert fallbacks["selected_model"] == "minimax/MiniMax-M3"

    metrics = json.loads((run_dir / "metrics.json").read_text(encoding="utf-8"))
    assert metrics["fallbacks_total"] == 1
    assert metrics["fallbacks_by_reason"]["auth"] == 1

    assert any(
        "fell back from stub-auth-failure/deepseek-v4-flash to minimax/MiniMax-M3 after auth"
        in w
        for w in state.warnings
    )


def test_executor_all_compatible_workers_fail_degrades_not_crashes(
    tmp_path: Path, monkeypatch
) -> None:
    from harness.agents.base import AgentBackend, AgentRunRequest
    from harness.fusion.candidate_schema import CandidateResult
    from harness.core.errors import BackendError

    class AllFailBackend(AgentBackend):
        name = "mock"

        def run(self, request: AgentRunRequest) -> CandidateResult:
            raise BackendError("All-fail error")

    from harness.core.lifecycle import BACKENDS

    monkeypatch.setitem(BACKENDS, "mock", AllFailBackend())

    from harness.fugu.pool import Worker

    qwen = Worker(
        id="stub-failure/deepseek-v4-flash",
        tags=("coding",),
        cost_tier="free",
        latency_tier="fast",
        provider="stub",
        family="deepseek",
    )
    minimax = Worker(
        id="minimax/MiniMax-M3",
        tags=("coding",),
        cost_tier="budget",
        latency_tier="balanced",
        provider="minimax",
        family="minimax",
    )
    pool = [qwen, minimax]
    from harness.fugu.health import WorkerHealth

    health = WorkerHealth()

    executor = FuguExecutor(tmp_path / "runs", pool=pool, health=health)
    plan = ScaffoldPlan(
        mode="route",
        topology="single",
        nodes=[
            ScaffoldNode(
                model="stub-failure/deepseek-v4-flash",
                role="worker",
                instruction="coding task",
            )
        ],
        rationale="test",
    )

    state = executor.execute(plan, _task(), backend="mock")

    assert state.status == "failed"

    run_dir = tmp_path / "runs" / state.run_id
    import json

    assert (run_dir / "candidates" / "fugu_test_fugu_1" / "result.json").exists()
    assert (run_dir / "candidates" / "fugu_test_fugu_1" / "fallbacks.json").exists()

    cand_result = json.loads(
        (run_dir / "candidates/fugu_test_fugu_1/result.json").read_text(
            encoding="utf-8"
        )
    )
    assert cand_result["status"] == "failed"
    assert (
        "primary stub-failure/deepseek-v4-flash failed with unknown; fallback minimax/MiniMax-M3 failed with unknown"
        in cand_result["answer"]
    )


def test_context_error_routes_to_long_context(tmp_path: Path, monkeypatch) -> None:
    from harness.agents.base import AgentBackend, AgentRunRequest
    from harness.fusion.candidate_schema import CandidateResult, SelfAssessment
    from harness.core.errors import BackendError

    class ContextFailBackend(AgentBackend):
        name = "mock"

        def run(self, request: AgentRunRequest) -> CandidateResult:
            if request.model == "cx/gpt-5.5":
                raise BackendError("context window exceeds limit")
            elif request.model == "minimax/MiniMax-M3":
                return CandidateResult(
                    candidate_id=request.candidate_id,
                    run_id=request.run_id,
                    agent_backend="mock",
                    model=request.model,
                    role=request.role,
                    prompt_variant=request.prompt_variant,
                    status="completed",
                    answer="minimax successfully solved this",
                    self_assessment=SelfAssessment(confidence=0.9, known_weaknesses=[]),
                    trace_path=request.trace_path,
                )
            raise BackendError(f"unexpected model: {request.model}")

    from harness.core.lifecycle import BACKENDS

    monkeypatch.setitem(BACKENDS, "mock", ContextFailBackend())

    from harness.fugu.pool import Worker

    gpt = Worker(
        id="cx/gpt-5.5",
        tags=("coding",),
        cost_tier="premium",
        latency_tier="balanced",
        provider="cx",
        family="gpt",
        context_tier="normal",
    )
    minimax = Worker(
        id="minimax/MiniMax-M3",
        tags=("coding",),
        cost_tier="budget",
        latency_tier="balanced",
        provider="minimax",
        family="minimax",
        context_tier="long",
    )
    pool = [gpt, minimax]
    from harness.fugu.health import WorkerHealth

    health = WorkerHealth()

    executor = FuguExecutor(tmp_path / "runs", pool=pool, health=health)
    plan = ScaffoldPlan(
        mode="route",
        topology="single",
        nodes=[
            ScaffoldNode(model="cx/gpt-5.5", role="worker", instruction="coding task")
        ],
        rationale="test",
    )

    state = executor.execute(plan, _task(), backend="mock")
    assert state.status == "passed"

    run_dir = tmp_path / "runs" / state.run_id
    import json

    cand_result = json.loads(
        (run_dir / "candidates/fugu_test_fugu_1/result.json").read_text(
            encoding="utf-8"
        )
    )
    assert cand_result["model"] == "minimax/MiniMax-M3"


def test_verifier_family_independence_still_fails_closed(
    tmp_path: Path, monkeypatch
) -> None:
    from harness.fusion import model_verifier

    monkeypatch.setattr(model_verifier, "is_enabled", lambda: True)
    monkeypatch.setattr(
        model_verifier,
        "model_verify",
        lambda *a, **kw: {
            "satisfied": True,
            "satisfied_criteria": [],
            "unsatisfied_criteria": [],
            "rationale": "",
        },
    )
    monkeypatch.setattr(model_verifier.VERIFIER_CONFIG, "model", lambda: "cx/gpt-5.5")

    from harness.fugu.pool import Worker

    gpt = Worker(
        id="cx/gpt-5.5",
        tags=("coding",),
        cost_tier="premium",
        latency_tier="balanced",
        provider="cx",
        family="gpt",
    )
    pool = [gpt]
    from harness.fugu.health import WorkerHealth

    health = WorkerHealth()

    plan = ScaffoldPlan(
        mode="orchestrate",
        topology="tree",
        nodes=[
            ScaffoldNode(model="cx/gpt-5.5", role="worker_1", instruction="do it"),
            ScaffoldNode(model="cx/gpt-5.5", role="worker_2", instruction="do it"),
            ScaffoldNode(model="cx/gpt-5.5", role="worker_3", instruction="do it"),
        ],
        aggregator="cx/gpt-5.5",
        rationale="test",
    )

    executor = FuguExecutor(tmp_path / "runs", pool=pool, health=health)
    state = executor.execute(plan, _task(), backend="mock")

    assert state.status == "failed"
    assert any(
        "independent verifier must use a different model family than synthesizer" in err
        for err in state.errors
    )
