"""FMH-backed providers for the Red Queen Godel Machine.

These implement the public ``rqgm`` provider protocols
(:class:`rqgm.providers.WorkspaceProvider` /
:class:`rqgm.providers.EvaluatorSlotProvider`) on top of the Fusion Meta-Harness
backend registry (:data:`harness.core.lifecycle.BACKENDS`). The standalone
``rqgm`` package owns the algorithm; this module is the fork's contribution: a
prompt-evolution workspace whose coder/judge calls run through real FMH backends
(``mock`` offline, or ``9router`` / ``claude_code`` / ``anthropic_api`` / etc.
for real model runs), and an evaluator slot grounded by the labeled verifier
suite.

Design note: an RQGM "evaluation" is a single binary outcome for one
(node, role, task). That maps to a single backend ``run`` call (the same
``AgentRunRequest`` / ``CandidateResult`` contract the Supervisor uses), not to a
full Supervisor fusion run -- which would re-run candidate fan-out, synthesis,
and verification for every cell and litter ``runs/``. The backend registry is the
correct seam for per-evaluation outcomes.

``rqgm`` is an optional dependency; importing this module raises ``ImportError``
if the package is not installed (``pip install -e ../../../red-queen-godel-machine``).
"""

from __future__ import annotations

import hashlib
import json
import re
import tempfile
from pathlib import Path
from uuid import uuid4

from rqgm.archive import Archive, ArchiveNode
from rqgm.providers import EvaluatorCandidate, RoleSpec

from harness.agents.base import AgentRunRequest
from harness.core.lifecycle import BACKENDS
from harness.core.task_contract import BudgetSpec, TaskContract
from harness.evals.task_loader import load_jsonl_tasks

_FUGU_ROOT = Path(__file__).resolve().parents[1]

_DEFAULT_REVIEWER_PROMPT = (
    "You are a strict judge. Decide whether the candidate answer satisfies the "
    "task's acceptance criteria. Respond with exactly one word: Accept or Reject."
)
_DEFAULT_CODER_PROMPT = (
    "Complete the task and report a correct, well-supported final answer."
)
_META_PROMPT = (
    "You are a meta-optimizer improving an agent prompt. Rewrite the prompt below "
    "to be more specific and effective at its task while staying concise. Respond "
    "with ONLY the rewritten prompt and nothing else."
)

__all__ = ["FmhWorkspaceProvider", "FmhEvaluatorSlotProvider"]


def _load_reviewer_seed() -> str:
    try:
        text = (_FUGU_ROOT / "prompts" / "rqgm_reviewer.md").read_text(encoding="utf-8")
    except OSError:
        return _DEFAULT_REVIEWER_PROMPT
    return text.strip() or _DEFAULT_REVIEWER_PROMPT


def _parse_accept(text: str) -> bool:
    low = text.strip().lower()
    if "reject" in low:
        return False
    return "accept" in low


def _numbers(text: str) -> list[str]:
    return re.findall(r"-?\d+(?:\.\d+)?", text.replace(",", ""))


def _answer_matches(artifact: str, gold_answer: str) -> bool:
    gold_numbers = _numbers(gold_answer)
    artifact_numbers = _numbers(artifact)
    if gold_numbers:
        return any(gold in artifact_numbers for gold in gold_numbers)
    return " ".join(gold_answer.strip().lower().split()) in " ".join(
        artifact.strip().lower().split()
    )


class _BackendChat:
    """Adapts an FMH agent backend into a ``(system, user) -> str`` call."""

    def __init__(self, backend: str, model: str = "default") -> None:
        self.backend = backend
        self.model = model
        self._tmp = Path(tempfile.mkdtemp(prefix="rqgm_fmh_"))
        self._workspace = self._tmp / "workspace"
        self._workspace.mkdir(parents=True, exist_ok=True)

    def __call__(self, system: str, user: str) -> str:
        if self.backend not in BACKENDS:
            raise RuntimeError(
                f"unknown FMH backend {self.backend!r}; available: {sorted(BACKENDS)}"
            )
        call_id = uuid4().hex[:8]
        contract = TaskContract(
            task_id=f"rqgm_{call_id}",
            task_type="research",
            title="RQGM evaluation",
            user_request=user,
            acceptance_criteria=["Respond directly and correctly."],
            budget=BudgetSpec(),
        )
        request = AgentRunRequest(
            run_id=f"rqgm_{call_id}",
            candidate_id=call_id,
            task_contract=contract,
            workspace_path=str(self._workspace),
            role="rqgm",
            prompt=f"{system}\n\n{user}",
            trace_path=str(self._tmp / f"trace_{call_id}.jsonl"),
            model=self.model,
        )
        result = BACKENDS[self.backend].run(request)
        if result.status != "completed":
            return ""
        return result.answer


def _synthetic_contract(task_id: str) -> TaskContract:
    return TaskContract(
        task_id=task_id,
        task_type="research",
        title=task_id,
        user_request=f"Solve task {task_id}.",
        acceptance_criteria=["Produce a correct answer."],
        budget=BudgetSpec(),
    )


class FmhWorkspaceProvider:
    """Prompt-evolution workspace whose coder/judge calls run on FMH backends."""

    def __init__(
        self,
        backend: str = "9router",
        task_suite: str = "rqgm",
        source_root: str | Path | None = None,
        max_tasks: int = 4,
        model: str = "omp",
    ) -> None:
        self.backend = backend
        self.source_root = Path(source_root) if source_root else _FUGU_ROOT
        self._chat = _BackendChat(backend, model=model)
        self.seed_coder_prompt = _DEFAULT_CODER_PROMPT
        self.seed_reviewer_prompt = _load_reviewer_seed()
        contracts, gold_answers = self._load_contracts(task_suite, max_tasks)
        self._contracts: dict[str, TaskContract] = contracts
        self._gold_answers = gold_answers
        self._task_ids = list(contracts.keys())

    def has_ground_truth(self) -> bool:
        return bool(self._gold_answers)

    def _load_contracts(
        self, task_suite: str, max_tasks: int
    ) -> tuple[dict[str, TaskContract], dict[str, str]]:
        path = self.source_root / "evals" / task_suite / "tasks.jsonl"
        gold_answers: dict[str, str] = {}
        try:
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
            loaded = [
                TaskContract.model_validate(row["task_contract"]).normalized(Path.cwd())
                for row in rows[:max_tasks]
            ]
            gold_answers = {
                str(row["task_contract"]["task_id"]): str(row["gold_answer"])
                for row in rows[:max_tasks]
                if "gold_answer" in row
            }
        except (OSError, KeyError, ValueError, json.JSONDecodeError):
            loaded = []
        contracts = {c.task_id: c for c in loaded}
        if not contracts:
            synthetic = _synthetic_contract("rqgm_default")
            contracts = {synthetic.task_id: synthetic}
        return contracts, gold_answers

    def roles(self) -> list[RoleSpec]:
        return [
            RoleSpec("coder", "evaluator_independent", self._task_ids),
            RoleSpec("reviewer", "evaluator_dependent", self._task_ids, slot=0),
        ]

    def seed(self) -> dict:
        return {
            "coder_prompt": self.seed_coder_prompt,
            "reviewer_prompt": self.seed_reviewer_prompt,
        }

    def expand(self, parent: ArchiveNode) -> dict | None:
        workspace = dict(parent.workspace)
        digest = int.from_bytes(hashlib.sha256(parent.node_id.encode()).digest()[:8], "big")
        target = "reviewer_prompt" if digest % 2 else "coder_prompt"
        current = workspace.get(target, "")
        try:
            revised = self._chat(_META_PROMPT, f"Improve this {target}:\n{current}")
        except Exception:
            return None
        revised = revised.strip()
        if not revised or revised == current:
            return None
        workspace[target] = revised
        return workspace

    def evaluate(
        self,
        node: ArchiveNode,
        role: RoleSpec,
        task: str,
        evaluator: EvaluatorCandidate | None,
    ) -> int:
        contract = self._contracts.get(task)
        user = contract.user_request if contract else f"Solve task {task}."
        coder_prompt = node.workspace.get("coder_prompt", self.seed_coder_prompt)
        try:
            artifact = self._chat(coder_prompt, user)
            if role.name == "coder":
                gold_answer = self._gold_answers.get(task)
                if gold_answer is not None:
                    return int(_answer_matches(artifact, gold_answer))
                return int(bool(artifact.strip()))
            judge_prompt = (
                (evaluator.state.get("prompt") if evaluator else None)
                or self.seed_reviewer_prompt
            )
            decision = self._chat(judge_prompt, f"Task: {user}\n\nCandidate answer:\n{artifact}")
            return int(_parse_accept(decision))
        except Exception:
            return 0


class FmhEvaluatorSlotProvider:
    """Evaluator slot grounded by the labeled verifier suite (pairwise gold)."""

    def __init__(
        self,
        slot: int = 0,
        backend: str = "9router",
        anchor_suite: str = "verifier/labeled",
        source_root: str | Path | None = None,
        max_anchors: int = 8,
        model: str = "omp",
    ) -> None:
        self.slot = slot
        self.backend = backend
        self.source_root = Path(source_root) if source_root else _FUGU_ROOT
        self._chat = _BackendChat(backend, model=model)
        self.seed_reviewer_prompt = _load_reviewer_seed()
        self._anchors = self._load_anchors(anchor_suite, max_anchors)

    def _load_anchors(self, anchor_suite: str, max_anchors: int) -> list[tuple[str, str]]:
        path = self.source_root / "evals" / anchor_suite / "tasks.jsonl"
        items: list[tuple[str, str]] = []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return items
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            winner = row.get("expected_winner")
            candidates = {c.get("id"): c.get("content", "") for c in row.get("candidates", [])}
            if winner and winner in candidates:
                items.append((candidates[winner], "Accept"))
                for candidate_id, content in candidates.items():
                    if candidate_id != winner:
                        items.append((content, "Reject"))
            if len(items) >= max_anchors:
                break
        return items[:max_anchors]

    def incumbent(self) -> EvaluatorCandidate:
        return EvaluatorCandidate("anchor_e0", {"prompt": self.seed_reviewer_prompt})

    def challengers(self, archive: Archive) -> list[EvaluatorCandidate]:
        seen: dict[str, str] = {}
        for node in archive.nodes.values():
            prompt = node.workspace.get("reviewer_prompt")
            if prompt and prompt != self.seed_reviewer_prompt:
                seen.setdefault(hashlib.sha256(prompt.encode()).hexdigest()[:12], prompt)
        return [
            EvaluatorCandidate(candidate_id, {"prompt": prompt})
            for candidate_id, prompt in sorted(seen.items())
        ]

    def anchor_outcomes(self, evaluator: EvaluatorCandidate) -> tuple[int, int]:
        prompt = evaluator.state.get("prompt", self.seed_reviewer_prompt)
        if not self._anchors:
            return (0, 0)
        successes = failures = 0
        for artifact, label in self._anchors:
            try:
                decision = self._chat(prompt, f"Candidate answer:\n{artifact}")
            except Exception:
                return (0, 0)
            if _parse_accept(decision) == (label == "Accept"):
                successes += 1
            else:
                failures += 1
        return successes, failures
