from __future__ import annotations

from pathlib import Path

from harness.fugu.pool import load_pool, workers_for


def test_load_pool_rejects_duplicate_worker_ids(tmp_path: Path) -> None:
    config = tmp_path / "pool.yaml"
    config.write_text(
        """
workers:
  - id: a
    tags: [coding]
    cost_tier: free
    latency_tier: fast
  - id: a
    tags: [math]
    cost_tier: budget
    latency_tier: balanced
""".strip(),
        encoding="utf-8",
    )

    try:
        load_pool(config)
    except ValueError as exc:
        assert "duplicate worker ids" in str(exc)
    else:
        raise AssertionError("duplicate ids should fail closed")


def test_workers_for_ranks_tag_match_then_cost_then_latency(tmp_path: Path) -> None:
    config = tmp_path / "pool.yaml"
    config.write_text(
        """
workers:
  - id: premium-match
    tags: [coding, debug]
    cost_tier: premium
    latency_tier: slow
  - id: free-match
    tags: [coding]
    cost_tier: free
    latency_tier: fast
  - id: cheap-nonmatch
    tags: [math]
    cost_tier: free
    latency_tier: fast
""".strip(),
        encoding="utf-8",
    )

    ranked = workers_for(["coding", "debug"], load_pool(config))

    assert [worker.id for worker in ranked] == [
        "premium-match",
        "free-match",
        "cheap-nonmatch",
    ]


def test_default_pool_contains_user_requested_9router_models() -> None:
    ids = {worker.id for worker in load_pool()}

    assert "9router/cline-deepseek-v4-flash" in ids
    assert "minimax/MiniMax-M3" in ids
    assert "openrouter-free-fallback" in ids


def test_workers_for_skips_unhealthy_worker() -> None:
    from harness.fugu.health import WorkerHealth
    from harness.fugu.errors import ClassifiedError
    from harness.fugu.pool import Worker

    health = WorkerHealth()
    qwen = Worker(
        id="9router/cline-deepseek-v4-flash",
        tags=("coding",),
        cost_tier="free",
        latency_tier="fast",
        provider="cline-pass",
        family="deepseek",
        reliability_tier="variable",
        context_tier="normal",
    )
    minimax = Worker(
        id="minimax/MiniMax-M3",
        tags=("coding",),
        cost_tier="budget",
        latency_tier="balanced",
        provider="minimax",
        family="minimax",
        reliability_tier="stable",
        context_tier="long",
    )
    pool = [qwen, minimax]

    # Pre-condition: both healthy, qwen ranks first because free/fast
    assert workers_for(["coding"], pool, health=health) == [qwen, minimax]

    # Mark qwen failed (auth)
    health.mark_failure(qwen, ClassifiedError("auth", False, 900, "401 unauthorized"))

    # Post-condition: qwen skipped, only minimax returned
    assert workers_for(["coding"], pool, health=health) == [minimax]


def test_workers_for_prefers_long_context_on_context_retry() -> None:
    from harness.fugu.pool import Worker

    gpt_fast = Worker(
        id="cx/gpt-5.5",
        tags=("coding",),
        cost_tier="free",
        latency_tier="fast",
        provider="cx",
        family="gpt",
        reliability_tier="stable",
        context_tier="normal",
    )
    minimax = Worker(
        id="minimax/MiniMax-M3",
        tags=("coding",),
        cost_tier="budget",
        latency_tier="balanced",
        provider="minimax",
        family="minimax",
        reliability_tier="stable",
        context_tier="long",
    )
    pool = [gpt_fast, minimax]

    # Normally gpt_fast is free/fast, so it ranks before minimax
    assert workers_for(["coding"], pool) == [gpt_fast, minimax]

    # With required_context_tier="long", minimax should rank before gpt_fast
    assert workers_for(["coding"], pool, required_context_tier="long") == [
        minimax,
        gpt_fast,
    ]
