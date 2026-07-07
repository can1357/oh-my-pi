from __future__ import annotations

from harness.agents.openai_client import ChatResult
from harness.fugu import coordinator as coordinator_module
from harness.fugu.coordinator import Coordinator, default_plan
from harness.fugu.pool import Worker
from harness.core.task_contract import TaskContract


def _coding_task(title: str = "Implement fix") -> TaskContract:
    return TaskContract(
        task_id="task",
        task_type="coding",
        title=title,
        user_request=title,
        acceptance_criteria=["works"],
        workspace={"mode": "workspace_write", "allowed_paths": ["."]},
        budget={},
        output={"expected_type": "patch"},
    )


def test_default_plan_routes_coding_patch_to_builder_debugger_agents() -> None:
    pool = [
        Worker("coder", ("coding",), "budget", "balanced"),
        Worker("debugger", ("debug", "reasoning"), "budget", "balanced"),
        Worker("synth", ("synthesis",), "premium", "balanced"),
    ]

    plan = default_plan("fix the parser bug", _coding_task(), "fast", pool)

    assert plan.mode == "orchestrate"
    assert plan.topology == "build_debug"
    assert [(node.role, node.model) for node in plan.nodes] == [
        ("builder", "coder"),
        ("debugger", "debugger"),
    ]
    assert plan.aggregator == "synth"


def test_default_plan_routes_specialist_risk_to_specialist_agent() -> None:
    pool = [
        Worker("coder", ("coding",), "budget", "balanced"),
        Worker("debugger", ("debug", "reasoning"), "budget", "balanced"),
        Worker("security", ("debug", "reasoning"), "premium", "balanced"),
        Worker("synth", ("synthesis",), "premium", "balanced"),
    ]

    plan = default_plan(
        "fix the auth permission bypass",
        _coding_task("Fix security bug"),
        "fast",
        pool,
    )

    assert plan.topology == "specialist"
    assert [(node.role, node.model) for node in plan.nodes] == [
        ("builder", "coder"),
        ("debugger", "debugger"),
        ("specialist", "security"),
    ]
    assert plan.aggregator == "synth"


def test_default_plan_routes_coding_to_coding_worker() -> None:
    pool = [
        Worker("math", ("math",), "free", "fast"),
        Worker("coder", ("coding",), "budget", "balanced"),
    ]

    plan = default_plan("write a binary search in Rust", None, "fast", pool)

    assert plan.mode == "route"
    assert plan.topology == "single"
    assert plan.nodes[0].model == "coder"
    assert plan.aggregator is None


def test_default_plan_quality_uses_tree_when_workers_available() -> None:
    pool = [
        Worker("a", ("cheap",), "free", "fast"),
        Worker("b", ("cheap",), "budget", "balanced"),
        Worker("c", ("cheap",), "premium", "slow"),
    ]

    plan = default_plan("summarize this", None, "quality", pool)

    assert plan.mode == "orchestrate"
    assert plan.topology == "tree"
    assert [node.model for node in plan.nodes] == ["a", "b", "c"]
    assert plan.aggregator == "a"


def test_coordinator_falls_back_on_invalid_model_json(monkeypatch) -> None:
    pool = [Worker("coder", ("coding",), "free", "fast")]

    def fake_chat_json(*args, **kwargs):
        return ChatResult(text="not-json", input_tokens=1, output_tokens=1)

    monkeypatch.setattr(coordinator_module, "chat_json", fake_chat_json)

    plan = Coordinator(model="coordinator", pool=pool).plan(
        "write python", latency="fast"
    )

    assert plan.nodes[0].model == "coder"
    assert plan.rationale.startswith("fallback:")


def test_coordinator_accepts_valid_model_plan(monkeypatch) -> None:
    pool = [Worker("coder", ("coding",), "free", "fast")]

    def fake_chat_json(*args, **kwargs):
        return ChatResult(
            text='{"mode":"route","topology":"single","nodes":[{"model":"coder","role":"worker","instruction":"do it"}],"aggregator":null,"rounds":1,"rationale":"model chose route"}',
            input_tokens=1,
            output_tokens=1,
        )

    monkeypatch.setattr(coordinator_module, "chat_json", fake_chat_json)

    plan = Coordinator(model="coordinator", pool=pool).plan(
        "write python", latency="fast"
    )

    assert plan.rationale == "model chose route"
    assert plan.nodes[0].model == "coder"


def test_default_plan_prefers_kimi_and_minimax_code_for_coding() -> None:
    pool = [
        Worker(
            "9router/cline-kimi-k2.7-code",
            ("coding",),
            "budget",
            "balanced",
            provider="cline-pass",
            family="kimi",
        ),
        Worker(
            "9router/cline-minimax-m3",
            ("coding", "planning", "synthesis"),
            "budget",
            "balanced",
            provider="cline-pass",
            family="minimax",
        ),
        Worker(
            "minimax/MiniMax-M3",
            ("coding", "long-context"),
            "budget",
            "balanced",
            provider="minimax",
            family="minimax",
        ),
        Worker(
            "cx/gpt-5.5",
            ("coding",),
            "premium",
            "balanced",
            provider="cx",
            family="gpt",
        ),
    ]

    plan = default_plan("write python", None, "fast", pool)

    assert plan.nodes[0].model == "9router/cline-kimi-k2.7-code"



def test_default_plan_model_only_kimi_failure_uses_minimax_code() -> None:
    from harness.fugu.health import WorkerHealth
    from harness.fugu.errors import ClassifiedError

    health = WorkerHealth()
    qwen = Worker(
        id="9router/cline-kimi-k2.7-code",
        tags=("coding",),
        cost_tier="budget",
        latency_tier="balanced",
        provider="cline-pass",
        family="kimi",
    )
    minimax_code = Worker(
        id="9router/cline-minimax-m3",
        tags=("coding", "planning", "synthesis"),
        cost_tier="budget",
        latency_tier="balanced",
        provider="cline-pass",
        family="minimax",
    )
    minimax = Worker(
        id="minimax/MiniMax-M3",
        tags=("coding", "long-context"),
        cost_tier="budget",
        latency_tier="balanced",
        provider="minimax",
        family="minimax",
    )
    pool = [qwen, minimax_code, minimax]

    health.mark_failure(qwen, ClassifiedError("context", False, 60, "context too long"))

    plan = default_plan("write python", None, "fast", pool, health)
    assert plan.nodes[0].model == "9router/cline-minimax-m3"



def test_default_plan_skips_unhealthy_qwen_and_uses_minimax_for_coding() -> None:
    from harness.fugu.health import WorkerHealth
    from harness.fugu.errors import ClassifiedError

    health = WorkerHealth()
    qwen = Worker(
        id="9router/cline-kimi-k2.7-code",
        tags=("coding",),
        cost_tier="budget",
        latency_tier="balanced",
        provider="cline-pass",
        family="kimi",
    )
    minimax_code = Worker(
        id="9router/cline-minimax-m3",
        tags=("coding", "planning", "synthesis"),
        cost_tier="budget",
        latency_tier="balanced",
        provider="cline-pass",
        family="minimax",
    )
    minimax = Worker(
        id="minimax/MiniMax-M3",
        tags=("coding", "long-context"),
        cost_tier="budget",
        latency_tier="balanced",
        provider="minimax",
        family="minimax",
    )
    gpt = Worker(
        id="cx/gpt-5.5",
        tags=("coding",),
        cost_tier="premium",
        latency_tier="balanced",
        provider="cx",
        family="gpt",
    )
    pool = [qwen, minimax_code, minimax, gpt]

    health.mark_failure(qwen, ClassifiedError("auth", False, 900, "401 unauthorized"))

    plan = default_plan("write python", None, "fast", pool, health)
    assert plan.nodes[0].model == "minimax/MiniMax-M3"


def test_default_plan_cheap_general_prefers_gemini_then_openrouter() -> None:
    from harness.fugu.health import WorkerHealth
    from harness.fugu.errors import ClassifiedError

    health = WorkerHealth()
    gemini = Worker(
        id="ag/gemini-3.5-flash-low",
        tags=("cheap", "fast", "factual"),
        cost_tier="free",
        latency_tier="fast",
        provider="ag",
        family="gemini",
    )
    openrouter = Worker(
        id="openrouter-free-fallback",
        tags=("free-fallback", "cheap", "fast"),
        cost_tier="free",
        latency_tier="fast",
        provider="openrouter-free-fallback",
        family="openrouter",
    )
    pool = [gemini, openrouter]

    # Pre-condition: both healthy, cheap/general chooses gemini first
    plan = default_plan("tell me a joke", None, "fast", pool, health)
    assert plan.nodes[0].model == "ag/gemini-3.5-flash-low"

    # Mark gemini rate-limited
    health.mark_failure(
        gemini, ClassifiedError("rate_limit", False, 60, "429 rate limit exceeded")
    )

    # Post-condition: selects openrouter fallback
    plan = default_plan("tell me a joke", None, "fast", pool, health)
    assert plan.nodes[0].model == "openrouter-free-fallback"
