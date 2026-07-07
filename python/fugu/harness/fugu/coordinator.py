from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from harness.agents.ninerouter_backend import NineRouterBackend
from harness.agents.openai_client import chat_json
from harness.core.errors import BackendError
from harness.core.task_contract import TaskContract
from harness.fugu.pool import Worker, load_pool, worker_ids, workers_for
from harness.fugu.topology import ScaffoldNode, ScaffoldPlan
from harness.fugu.health import WorkerHealth, GLOBAL_WORKER_HEALTH

Latency = Literal["fast", "balanced", "quality"]

_DEFAULT_COORDINATOR_MODEL = "9router/cline-deepseek-v4-flash"
_PROMPT_PATH = Path(__file__).resolve().parents[2] / "prompts" / "fugu_coordinator.md"


class Coordinator:
    def __init__(
        self,
        model: str | None = None,
        pool: list[Worker] | None = None,
        health: WorkerHealth | None = None,
    ) -> None:
        self.model = model or os.environ.get(
            "FUGU_COORDINATOR_MODEL", _DEFAULT_COORDINATOR_MODEL
        )
        self.pool = pool or load_pool()
        self.health = health or GLOBAL_WORKER_HEALTH

    def plan(
        self,
        query: str,
        task: TaskContract | None = None,
        latency: Latency = "balanced",
    ) -> ScaffoldPlan:
        try:
            plan = self._model_plan(query, task, latency)
            plan = _replace_unhealthy_nodes(plan, self.pool, self.health, query, task)
            return plan.validate_pool(worker_ids(self.pool))
        except (
            BackendError,
            OSError,
            ValueError,
            ValidationError,
            json.JSONDecodeError,
        ):
            return default_plan(query, task, latency, self.pool, self.health)

    def _model_plan(
        self, query: str, task: TaskContract | None, latency: Latency
    ) -> ScaffoldPlan:
        result = chat_json(
            NineRouterBackend.config,
            _PROMPT_PATH.read_text(encoding="utf-8"),
            self._user_prompt(query, task, latency),
            self.model,
        )
        payload = json.loads(result.text)
        return ScaffoldPlan.model_validate(payload)

    def _user_prompt(
        self, query: str, task: TaskContract | None, latency: Latency
    ) -> str:
        task_type = task.task_type if task is not None else "custom"
        acceptance = task.acceptance_criteria if task is not None else []
        pool_lines = [
            f"- {worker.id}; tags={','.join(worker.tags)}; cost={worker.cost_tier}; latency={worker.latency_tier}"
            for worker in self.pool
        ]
        return "\n".join(
            [
                f"Latency: {latency}",
                f"Task type: {task_type}",
                f"Query: {query}",
                "Acceptance criteria:",
                *[f"- {item}" for item in acceptance],
                "Worker pool:",
                *pool_lines,
            ]
        )


def _first_worker(
    tags: list[str],
    pool: list[Worker],
    health: WorkerHealth | None,
    used: set[str] | None = None,
) -> Worker | None:
    blocked = used or set()
    for worker in workers_for(tags, pool, health=health):
        if worker.id not in blocked:
            return worker
    if health is None:
        return None
    for worker in workers_for(tags, pool):
        if worker.id not in blocked:
            return worker
    return None


def _agent_plan(
    query: str,
    task: TaskContract | None,
    pool: list[Worker],
    health: WorkerHealth | None,
) -> ScaffoldPlan | None:
    if task is None:
        return None

    text = f"{query} {task.title} {task.user_request} {' '.join(task.acceptance_criteria)}".lower()
    writes_code = (
        task.task_type == "coding"
        or task.output.expected_type in {"patch", "pull_request"}
        or task.workspace.mode in {"workspace_write", "sandboxed_container"}
    )
    if not writes_code:
        return None

    needs_specialist = any(
        word in text
        for word in (
            "security",
            "auth",
            "permission",
            "frontend",
            "ui",
            "accessibility",
            "performance",
            "benchmark",
            "science",
            "math",
            "proof",
        )
    )

    used: set[str] = set()
    builder = _first_worker(["coding"], pool, health, used)
    if builder is None:
        return None
    used.add(builder.id)
    debugger = _first_worker(["debug", "reasoning", "coding"], pool, health, used)
    if debugger is None:
        return None
    used.add(debugger.id)

    specialist_tags = ["reasoning"]
    if "security" in text or "auth" in text or "permission" in text:
        specialist_tags = ["debug", "reasoning"]
    elif "frontend" in text or "ui" in text or "accessibility" in text:
        specialist_tags = ["factual", "reasoning"]
    elif "performance" in text or "benchmark" in text:
        specialist_tags = ["reasoning", "math"]
    elif "science" in text or "math" in text or "proof" in text:
        specialist_tags = ["science", "math", "reasoning"]

    specialist = (
        _first_worker(specialist_tags, pool, health, used) if needs_specialist else None
    )
    aggregator = _first_worker(["synthesis"], pool, health, set())
    if aggregator is None:
        aggregator = _first_worker(["reasoning"], pool, health, set())
    if aggregator is None:
        aggregator = builder

    if specialist is not None:
        return ScaffoldPlan(
            mode="orchestrate",
            topology="specialist",
            nodes=[
                ScaffoldNode(
                    model=builder.id,
                    role="builder",
                    instruction="Implement the requested change end-to-end with the smallest correct patch.",
                ),
                ScaffoldNode(
                    model=debugger.id,
                    role="debugger",
                    instruction="Run the failure path mentally and repair defects in the builder output.",
                ),
                ScaffoldNode(
                    model=specialist.id,
                    role="specialist",
                    instruction="Review the result through the task-specific specialist lens and surface fixes.",
                ),
            ],
            aggregator=aggregator.id,
            rounds=1,
            rationale="fallback: agent router selected builder/debugger/specialist",
        )

    return ScaffoldPlan(
        mode="orchestrate",
        topology="build_debug",
        nodes=[
            ScaffoldNode(
                model=builder.id,
                role="builder",
                instruction="Implement the requested change end-to-end with the smallest correct patch.",
            ),
            ScaffoldNode(
                model=debugger.id,
                role="debugger",
                instruction="Run the failure path mentally and repair defects in the builder output.",
            ),
        ],
        aggregator=aggregator.id,
        rounds=1,
        rationale="fallback: agent router selected builder/debugger",
    )


def default_plan(
    query: str,
    task: TaskContract | None,
    latency: Latency,
    pool: list[Worker],
    health: WorkerHealth | None = None,
) -> ScaffoldPlan:
    tags = _infer_tags(query, task)
    is_long_context = "long-context" in tags or any(
        word in query.lower() for word in ("long", "context")
    )

    ranked: list[Worker] = []
    if is_long_context:
        preferred_ids = [
            "minimax/MiniMax-M3",
            "ag/gemini-3.5-flash-medium",
            "cx/gpt-5.5",
        ]
        for pid in preferred_ids:
            w = next((x for x in pool if x.id == pid), None)
            if w and (health is None or health.is_healthy(w)):
                ranked.append(w)
    elif "coding" in tags:
        preferred_ids = [
            "9router/cline-kimi-k2.7-code",
            "9router/cline-minimax-m3",
            "minimax/MiniMax-M3",
            "cx/gpt-5.5",
            "9router/cline-deepseek-v4-flash",
            "GPT-OSS",
            "ag/gemini-3.5-flash-medium",
        ]
        for pid in preferred_ids:
            w = next((x for x in pool if x.id == pid), None)
            if w and (health is None or health.is_healthy(w)):
                ranked.append(w)
    elif "cheap" in tags or "fast" in tags:
        preferred_ids = [
            "ag/gemini-3.5-flash-low",
            "openrouter-free-fallback",
            "Nvidia_Super",
            "GPT-OSS",
            "nvidia/nemotron-3-ultra-550b-a55b",
            "minimax/MiniMax-M3",
            "cx/gpt-5.5",
        ]
        for pid in preferred_ids:
            w = next((x for x in pool if x.id == pid), None)
            if w and (health is None or health.is_healthy(w)):
                ranked.append(w)

    if not ranked:
        ranked = workers_for(tags, pool, health=health)
        if not ranked and health is not None:
            ranked = workers_for(tags, pool)

    if not ranked:
        raise ValueError("Fugu pool is empty")

    healthy_ranked = [w for w in ranked if health is None or health.is_healthy(w)]

    routed_agents = _agent_plan(query, task, healthy_ranked or ranked, health)
    if routed_agents is not None:
        return routed_agents

    if latency == "quality" and len(healthy_ranked) >= 3:
        nodes = [
            ScaffoldNode(
                model=worker.id,
                role=f"worker_{index + 1}",
                instruction="Solve independently with evidence.",
            )
            for index, worker in enumerate(healthy_ranked[:3])
        ]
        return ScaffoldPlan(
            mode="orchestrate",
            topology="tree",
            nodes=nodes,
            aggregator=healthy_ranked[0].id,
            rounds=1,
            rationale="fallback: quality latency uses independent tree synthesis",
        )

    worker = healthy_ranked[0] if healthy_ranked else ranked[0]
    return ScaffoldPlan(
        mode="route",
        topology="single",
        nodes=[
            ScaffoldNode(
                model=worker.id,
                role="worker",
                instruction="Answer directly with concise evidence.",
            )
        ],
        aggregator=None,
        rounds=1,
        rationale="fallback: deterministic keyword route",
    )


def _replace_unhealthy_nodes(
    plan: ScaffoldPlan,
    pool: list[Worker],
    health: WorkerHealth,
    query: str = "",
    task: TaskContract | None = None,
) -> ScaffoldPlan:
    inferred_task_tags = _infer_tags(query, task)
    used_models = {node.model for node in plan.nodes}
    rationale = plan.rationale

    def process_node(node: ScaffoldNode) -> ScaffoldNode:
        nonlocal rationale
        processed_children = [process_node(child) for child in node.children]

        worker = next((w for w in pool if w.id == node.model), None)
        if worker is not None and not health.is_healthy(worker):
            role_lower = node.role.lower()
            role_tags = [role_lower]
            if "planner" in role_lower:
                role_tags.append("planning")
            elif "critic" in role_lower:
                role_tags.append("reasoning")
            elif "builder" in role_lower:
                role_tags.append("coding")
            elif "debugger" in role_lower:
                role_tags.append("debug")

            search_tags = role_tags + inferred_task_tags
            replacements = workers_for(search_tags, pool, health=health)

            replacement = None
            for w in replacements:
                if w.id not in used_models:
                    replacement = w
                    break

            if replacement is not None:
                used_models.discard(node.model)
                used_models.add(replacement.id)
                return ScaffoldNode(
                    model=replacement.id,
                    role=node.role,
                    instruction=node.instruction,
                    children=processed_children,
                )
            else:
                if (
                    "; unhealthy worker retained because no replacement exists"
                    not in rationale
                ):
                    rationale += (
                        "; unhealthy worker retained because no replacement exists"
                    )

        return ScaffoldNode(
            model=node.model,
            role=node.role,
            instruction=node.instruction,
            children=processed_children,
        )

    new_nodes = [process_node(node) for node in plan.nodes]

    aggregator = plan.aggregator
    if aggregator is not None:
        agg_worker = next((w for w in pool if w.id == aggregator), None)
        if agg_worker is not None and not health.is_healthy(agg_worker):
            replacements = workers_for(["synthesis"], pool, health=health)
            if not replacements:
                replacements = workers_for([], pool, health=health)

            if replacements:
                aggregator = replacements[0].id
            else:
                if (
                    "; unhealthy worker retained because no replacement exists"
                    not in rationale
                ):
                    rationale += (
                        "; unhealthy worker retained because no replacement exists"
                    )

    return ScaffoldPlan(
        mode=plan.mode,
        topology=plan.topology,
        nodes=new_nodes,
        aggregator=aggregator,
        rounds=plan.rounds,
        rationale=rationale,
    )


def _infer_tags(query: str, task: TaskContract | None) -> list[str]:
    text = f"{query} {task.task_type if task is not None else ''}".lower()
    tags: list[str] = []
    if any(
        word in text
        for word in ("code", "coding", "rust", "python", "typescript", "debug", "bug")
    ):
        tags.append("coding")
    if any(word in text for word in ("prove", "math", "theorem", "reason")):
        tags.append("reasoning")
        tags.append("math")
    if any(word in text for word in ("science", "paper", "research", "fact")):
        tags.append("science")
        tags.append("factual")
    if any(word in text for word in ("cheap", "free", "fast")):
        tags.append("cheap")
        tags.append("fast")
    if not tags:
        tags.append("cheap")
    return tags
