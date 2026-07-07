from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from harness.core.task_contract import TaskContract


class CandidatePlan(BaseModel):
    candidate_id: str
    backend: str
    model: str
    role: str
    prompt_variant: str
    budget_usd: float


class RouterDecision(BaseModel):
    profile: str
    candidates: list[CandidatePlan]
    rationale: str


# Budget profile rotates these OpenAI/Anthropic-compatible budget backends across
# candidates so a single run gets diverse cheap providers without per-call config.
BUDGET_POOL = ["kimi", "minimax"]

# Dynamic profile intentionally mixes model families and routing behavior. Each
# backend resolves its own default model at execution time.
DYNAMIC_POOL = ["qwen", "minimax", "kimi", "9router", "openai_api"]

# Explore profile: each candidate lane runs a DISTINCT model (one option per lane)
# through the single 9router backend, so a run fans out across model families in
# parallel and the single synthesizer (FMH_SYNTHESIZER_MODEL) fuses them. These
# default IDs are verified live on the local 9router /v1/models list.
EXPLORE_DEFAULT_MODELS = [
    "kimi/kimi-k2.6",
    "minimax/MiniMax-M3",
    "ag/gemini-3.5-flash-low",
    "cline-qwen3.7-plus",
    "cx/gpt-5.5",
]

# Cap explore fan-out so a long model list can't spawn unbounded parallel lanes.
EXPLORE_MAX_LANES = 8


def _env_explore_models() -> list[str]:
    """Parse FMH_EXPLORE_MODELS (comma-separated 9router model IDs)."""
    raw = os.environ.get("FMH_EXPLORE_MODELS", "")
    return [m.strip() for m in raw.split(",") if m.strip()]


class StaticRouter:
    def __init__(
        self,
        profile: Literal[
            "cheap", "standard", "deep", "coding", "research", "benchmark", "budget", "dynamic", "explore"
        ] = "standard",
        explore_models: list[str] | None = None,
    ) -> None:
        self.profile = profile
        # Explicit per-lane model list for the explore profile. Precedence:
        # constructor arg > FMH_EXPLORE_MODELS env > EXPLORE_DEFAULT_MODELS.
        self.explore_models = [m for m in (explore_models or []) if m and m.strip()]

    def _resolved_explore_models(self) -> list[str]:
        models = self.explore_models or _env_explore_models() or EXPLORE_DEFAULT_MODELS
        return models[:EXPLORE_MAX_LANES]

    def route(self, task: TaskContract, backend: str = "mock") -> RouterDecision:
        explore_models = self._resolved_explore_models() if self.profile == "explore" else []

        if self.profile == "explore":
            # One lane per model — the lane count is the size of the explore list,
            # not task.fusion.candidate_count.
            count = len(explore_models)
        else:
            count = min(
                task.fusion.candidate_count,
                1 if self.profile == "cheap" else 5 if self.profile in {"deep", "dynamic"} else task.fusion.candidate_count,
            )
        # Explore lanes always run on 9router, a zero-cost pass-through (9router meters
        # real spend/quota internally), and the fan-out is bounded by EXPLORE_MAX_LANES.
        # So the projected-USD guard — meant to catch runaway paid fan-out — doesn't
        # apply; applying it would wrongly block a free backend on a tight task budget.
        if self.profile != "explore" and count * task.budget.max_candidate_usd > task.budget.max_total_usd:
            raise ValueError("router budget exceeds max_total_usd")
        roles = task.fusion.required_roles or ["generalist"]

        # Budget profile ignores the single --backend and rotates the budget pool;
        # each backend resolves its own default model (kimi-for-coding / MiniMax-M3).
        def backend_for(idx: int) -> str:
            if self.profile == "explore":
                return "9router"
            if self.profile == "budget":
                return BUDGET_POOL[idx % len(BUDGET_POOL)]
            if self.profile == "dynamic":
                return DYNAMIC_POOL[idx % len(DYNAMIC_POOL)]
            return backend

        def model_for(idx: int) -> str:
            if self.profile == "explore":
                return explore_models[idx]
            if self.profile in {"budget", "dynamic"}:
                return "default"
            return "mock" if backend == "mock" else "default"

        candidates = [
            CandidatePlan(
                candidate_id=f"{task.task_id}_cand_{idx + 1}",
                backend=backend_for(idx),
                model=model_for(idx),
                role=roles[idx % len(roles)],
                prompt_variant=["careful_patch", "tests_first", "independent_review", "risk_first", "minimal_diff"][idx % 5],
                budget_usd=task.budget.max_candidate_usd,
            )
            for idx in range(count)
        ]
        if self.profile == "explore":
            rationale = f"Explore route: one model per lane over 9router across {count} candidates ({explore_models})."
        elif self.profile == "budget":
            rationale = f"Budget route rotating {BUDGET_POOL} across {count} candidates."
        elif self.profile == "dynamic":
            rationale = f"Dynamic route rotating {DYNAMIC_POOL[:count]} across {count} candidates."
        else:
            rationale = f"Static {self.profile} route with {count} {backend} candidates."
        return RouterDecision(profile=self.profile, candidates=candidates, rationale=rationale)


def write_router_decision(run_dir: Path, decision: RouterDecision) -> None:
    (run_dir / "router_decision.json").write_text(decision.model_dump_json(indent=2), encoding="utf-8")
