"""``RqgmEvolver`` — a real-world Red Queen Gödel Machine loop over the FMH scaffolding.

Drives an RQGM search/co-evolution loop using the standalone ``rqgm`` *primitives*
(``Archive``, ``best_belief``, ``exponential_checkpoints``, ``Archive.erase_slot``)
directly — it does not call the package's ``RQGMSearch`` — and wires them onto the
FMH editable surface (``_COPY_SURFACE``) with three real-world gates:

* **Improvement 1** — verifiable archive search with proportional stepping-stone
  sampling. Replaces the greedy ``Frontier`` selection (the collapse-to-seed cause);
  the reward is executable pass/fail from ``success_commands``, never an LLM judge
  or ``bool(nonempty answer)``.
* **Improvement 2** — a 3-stage evaluation cascade (compile → cheap canary → strong),
  a DE-anchored mutation operator, and a sha256 novelty gate.
* **Improvement 3** — a co-evolving but anchored verifier: dual-split gate +
  discriminative anchor best-belief + EST invariance + master-key rejection +
  subterfuge firewall + selective erasure, gated on the frozen holdout anchor.

Safety: the loop never edits ``FORBIDDEN_PATHS`` (``CandidateManager.check_paths``
guarantees it) and never weakens ``command_policy``. The executable coding reward
requires an agentic editing backend (``codex_cli`` / ``claude_code`` /
``subprocess_cli``, run with ``cwd=workspace``). Single-shot or mock backends are
rejected for ``rqgm evolve`` because they cannot test real self-improvement.
"""

from __future__ import annotations

import json
import os
import shutil
import statistics
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from rqgm.archive import Archive, ArchiveNode, UtilityRecord
from rqgm.beta import best_belief, posterior_mean
from rqgm.providers import EvaluatorCandidate, RoleSpec
from rqgm.search import exponential_checkpoints

from harness.meta.candidate_manager import CandidateManager
from harness.meta.evaluator import (
    EvalInfraError,
    _build_overlay,
    _run_eval_subprocess,
    evaluate_candidate_suite,
    evaluate_candidate_task,
)
from harness.meta.forbidden_paths import FORBIDDEN_PATHS
from harness.meta.promotion import promotion_allowed
from harness.meta.proposer import ClaudeProposer, MockProposer, ProposerError, _snapshot_tree

# -- tunables (plan defaults; each is a code-level constant with a documented value).
BB_EPSILON = 0.05          # best-belief quantile (matches RQGMConfig default)
EPS_SAMPLING = 0.1         # children divisor floor in proportional stepping-stone sampling
ALPHA = 0.6                # UCB-Air expansion gate exponent
MIN_NODE_EVALS = 5         # minimum evaluations before a node is final-selection eligible
CANARY_N = 2               # tasks run in the cheap cascade canary (Stage 2)
CHECKPOINT_BASE = 2
CHECKPOINT_MIN = 8
EST_TAU = 0.5              # max verdict-flip rate under semantic-preserving perturbation
R_DISC_MIN = 0.1          # drop a saturated/non-discriminating verifier below this verdict std
MIN_ANCHOR_OUTCOMES = 4    # minimum anchor items scored for a verifier challenger to qualify

# Real self-improvement needs an agentic CLI that edits the task workspace.
_AUTO_BACKEND = "auto"
_AGENTIC_BACKEND_ORDER = ("codex_cli", "claude_code", "subprocess_cli")
_AGENTIC_BACKENDS = frozenset(_AGENTIC_BACKEND_ORDER)
_AGENTIC_CMD_ENV = {
    "codex_cli": "FMH_CODEX_CLI_CMD",
    "claude_code": "FMH_CLAUDE_CODE_CMD",
    "subprocess_cli": "FMH_SUBPROCESS_CLI_CMD",
}
_AUTO_AGENTIC_COMMANDS = {
    "codex_cli": ("codex", "codex exec --sandbox workspace-write --skip-git-repo-check --ephemeral"),
    "claude_code": ("claude", "claude -p --permission-mode dontAsk"),
}

# Evaluator subset of the editable surface: a candidate editing any of these is a
# verifier challenger (Improvement 3). configs/rubric.yaml + harness/rubric +
# harness/fusion drive the accept/reject behavior.
_EVALUATOR_SURFACE = ("configs/rubric.yaml", "harness/rubric", "harness/fusion")

# Confirmed false-positive triggers for LLM-as-judge gaming (arXiv:2507.08794). A
# healthy command verifier rejects all of these (they cannot satisfy a real test);
# a gamed always-accept verifier takes at least one and is rejected.
MASTER_KEYS = ("", ":", ".", "Thought process:", "Let's solve this problem step by step.")


@dataclass
class RqgmEvolveResult:
    best_candidate_id: str
    seed_holdout_pass: float
    best_holdout_pass: float
    holdout_delta: float
    replacements: list[dict] = field(default_factory=list)
    archive_size: int = 0
    records_retained: int = 0
    num_evaluations: int = 0
    num_expansions: int = 0
    sampled_parents: list[str] = field(default_factory=list)
    applied: bool = False

    def to_dict(self) -> dict:
        return {
            "best_candidate_id": self.best_candidate_id,
            "seed_holdout_pass": round(self.seed_holdout_pass, 6),
            "best_holdout_pass": round(self.best_holdout_pass, 6),
            "holdout_delta": round(self.holdout_delta, 6),
            "replacements": self.replacements,
            "archive_size": self.archive_size,
            "records_retained": self.records_retained,
            "num_evaluations": self.num_evaluations,
            "num_expansions": self.num_expansions,
            "sampled_parents": sorted(set(self.sampled_parents)),
            "applied": self.applied,
        }


def _load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def _perturb(src: str) -> str:
    """Semantic-preserving perturbation for the EST invariance check: append a
    comment + whitespace. A command verifier (pytest) is byte-insensitive so its
    verdict is unchanged; a verifier keying off exact bytes flips and is rejected."""
    return src.rstrip("\n") + "\n\n# rqgm-est: semantically-irrelevant trailing comment\n"


def prepare_real_world_backend(backend: str) -> str:
    """Resolve and configure a backend that can edit task workspaces.

    ``auto`` picks the first locally available agentic backend. Explicit codex/claude
    backends use operator-provided launch commands when present, or a safe local
    non-interactive default when the CLI is on PATH. ``subprocess_cli`` is generic and
    therefore must be configured explicitly."""
    if backend == _AUTO_BACKEND:
        for candidate in _AGENTIC_BACKEND_ORDER:
            env_name = _AGENTIC_CMD_ENV[candidate]
            auto = _AUTO_AGENTIC_COMMANDS.get(candidate)
            if os.environ.get(env_name) or (auto is not None and shutil.which(auto[0]) is not None):
                return prepare_real_world_backend(candidate)
        raise EvalInfraError(
            "rqgm evolve requires an agentic editing backend; set FMH_CODEX_CLI_CMD, "
            "FMH_CLAUDE_CODE_CMD, or FMH_SUBPROCESS_CLI_CMD, or install codex/claude"
        )
    if backend not in _AGENTIC_BACKENDS:
        raise EvalInfraError(
            f"rqgm evolve requires an agentic editing backend, got {backend!r}; "
            f"choose one of {sorted(_AGENTIC_BACKENDS)} or {_AUTO_BACKEND!r}"
        )
    env_name = _AGENTIC_CMD_ENV[backend]
    if os.environ.get(env_name):
        return backend
    auto = _AUTO_AGENTIC_COMMANDS.get(backend)
    if auto is not None and shutil.which(auto[0]) is not None:
        os.environ[env_name] = auto[1]
        return backend
    raise EvalInfraError(
        f"backend {backend!r} requires {env_name} to be set to an agentic CLI launch command"
    )


def _default_proposer(_backend: str):
    """Real runs use ClaudeProposer for scaffold edits. If Claude is unavailable,
    preflight rejects the run rather than silently falling back to no-op evolution."""
    claude = ClaudeProposer()
    return claude if claude.available() else MockProposer()


# -- pure gate decision functions (injectable `verdict_fn` for deterministic tests) --

def discriminative_outcomes(verdict_fn, items) -> tuple[int, int, float]:
    """Score a verifier on labeled (solution, test, should_accept) anchors.

    Returns (successes, failures, r_disc) where successes counts correct verdicts
    and r_disc is the population std of the raw verdicts (0 = saturated / accepts or
    rejects everything; > 0 = discriminates)."""
    verdicts: list[int] = []
    successes = failures = 0
    for solution_src, test_src, should_accept in items:
        accepted = bool(verdict_fn(solution_src, test_src))
        verdicts.append(1 if accepted else 0)
        if accepted == should_accept:
            successes += 1
        else:
            failures += 1
    r_disc = statistics.pstdev(verdicts) if len(verdicts) > 1 else 0.0
    return successes, failures, r_disc


def passes_master_key(verdict_fn, test_src: str) -> bool:
    """True iff the verifier rejects every confirmed master-key trigger."""
    return not any(verdict_fn(key, test_src) for key in MASTER_KEYS)


def est_stable(verdict_fn, items, tau: float = EST_TAU) -> bool:
    """True iff the verdict-flip rate under semantic-preserving perturbation <= tau."""
    if not items:
        return True
    flips = 0
    for solution_src, test_src, _ in items:
        if bool(verdict_fn(solution_src, test_src)) != bool(verdict_fn(_perturb(solution_src), test_src)):
            flips += 1
    return (flips / len(items)) <= tau


def dual_split_ok(delta_in: float, delta_ho: float) -> bool:
    """Self-Harness dual-split: accept only with no regression on either split and a
    strict gain on at least one."""
    return delta_in >= 0 and delta_ho >= 0 and max(delta_in, delta_ho) > 0


def _verdict_contract(rel: str) -> dict:
    """One-row coding contract that runs the candidate verifier on an artifact at
    ``rel`` (relative to the overlay root)."""
    return {
        "task_id": f"verdict_{Path(rel).name}",
        "task_type": "coding",
        "title": "rqgm verifier verdict",
        "user_request": "Judge the candidate solution against its tests.",
        "repo": {"local_path": rel},
        "workspace": {"mode": "workspace_write", "allowed_paths": ["."]},
        "acceptance_criteria": ["pytest passes"],
        "success_commands": ["python -m pytest -q"],
        "budget": {
            "max_total_usd": 1.0,
            "max_candidate_usd": 0.25,
            "max_wall_clock_seconds": 120,
            "max_agent_turns": 2,
            "max_repair_attempts": 1,
        },
    }


def _snapshot_guarded(root: Path) -> dict:
    """Hash-snapshot the forbidden + holdout subtrees of ``root`` for the subterfuge
    firewall (Improvement 3 / DGM objective-hacking guard). Compiled-bytecode caches
    are excluded so a benign ``__pycache__`` write is never mistaken for tampering."""
    root = Path(root)
    snapshot: dict[str, tuple[str, int]] = {}
    for rel in (*FORBIDDEN_PATHS, "evals/holdout/"):
        target = root / rel.rstrip("/")
        if not target.exists():
            continue
        for key, value in _snapshot_tree(target).items():
            if "__pycache__" in key or key.endswith(".pyc"):
                continue
            snapshot[f"{rel}::{key}"] = value
    return snapshot


class _VerifierProbe:
    """Runs a candidate verifier against fixed (solution, test) artifacts in one
    reused overlay, and reports whether the episode tampered with forbidden/holdout
    files. Verdicts use the non-editing ``mock`` backend so they measure the verifier
    (accept/reject), not a solver."""

    def __init__(self, candidate_dir: str, source_root: Path) -> None:
        self.overlay = _build_overlay(Path(candidate_dir), Path(source_root))
        self._before = _snapshot_guarded(self.overlay)
        self._n = 0

    def verdict(self, solution_src: str, test_src: str) -> bool:
        self._n += 1
        rel = f"evals/_rqgm_verdict/v{self._n:04d}"
        fixture = self.overlay / rel
        fixture.mkdir(parents=True, exist_ok=True)
        (fixture / "solution.py").write_text(solution_src, encoding="utf-8")
        (fixture / "test_solution.py").write_text(test_src, encoding="utf-8")
        suite = fixture / "suite.jsonl"
        suite.write_text(json.dumps({"task_contract": _verdict_contract(rel)}) + "\n", encoding="utf-8")
        try:
            summary = _run_eval_subprocess(self.overlay, suite, "mock", "default", 1)
        except EvalInfraError:
            return False  # fail-closed: a verifier that can't run cannot accept
        rate = summary.get("pass_rate", 0.0)
        return bool(isinstance(rate, (int, float)) and rate >= 1.0)

    def tampered(self) -> bool:
        return _snapshot_guarded(self.overlay) != self._before

    def close(self) -> None:
        shutil.rmtree(self.overlay, ignore_errors=True)


class RqgmEvolver:
    def __init__(
        self,
        suite: str = "rqgm_code",
        holdout: str = "holdout/rqgm_code",
        backend: str = _AUTO_BACKEND,
        model: str = "omp",
        canary_backend: str | None = None,
        canary_model: str | None = None,
        budget: int = 24,
        seed: int = 0,
        source_root: str | Path | None = None,
        root: str | Path = Path("harness_candidates"),
        proposer=None,
    ) -> None:
        import random

        self.suite = suite
        self.holdout = holdout
        self.backend = backend
        self.model = model
        self.canary_backend = canary_backend or backend
        self.canary_model = canary_model or model
        self.budget = budget
        self.source_root = Path(source_root).resolve() if source_root else Path.cwd()
        self.manager = CandidateManager(root)
        self.proposer = proposer or _default_proposer(backend)
        self.archive = Archive()
        self._rng = random.Random(seed)
        self._signatures: set[str] = set()
        self._canary_cache: dict[str, float] = {}
        self._shipped_cache: dict[str, bool] = {}
        self._anchor_items_cache: list[tuple[str, str, bool]] | None = None
        self._current_epoch: dict[int, str] = {}

        rows = _load_rows(self.source_root / "evals" / self.suite / "tasks.jsonl")
        self._task_ids = [str(row["task_contract"]["task_id"]) for row in rows]
        self._canary_tasks = self._task_ids[:CANARY_N]

    # -- roles ------------------------------------------------------------------
    def roles(self) -> list[RoleSpec]:
        return [
            RoleSpec("coder", "evaluator_independent", self._task_ids),
            RoleSpec("reviewer", "evaluator_dependent", self._task_ids, slot=0),
        ]

    # -- preflight (fail fast so a misconfigured real backend can't pass vacuously) --
    def _preflight(self) -> None:
        self.backend = prepare_real_world_backend(self.backend)
        self.canary_backend = prepare_real_world_backend(self.canary_backend)
        if isinstance(self.proposer, MockProposer):
            raise EvalInfraError(
                "rqgm evolve requires the `claude` proposer CLI for real scaffold edits; "
                "install claude or pass an explicit proposer in tests"
            )

    # -- compilation / liveness -------------------------------------------------
    def _compiles(self, candidate_dir: Path, paths: list[str]) -> bool:
        candidate_dir = Path(candidate_dir)
        for rel in paths:
            target = candidate_dir / rel
            if not target.exists():
                continue
            files = [target] if target.is_file() else [
                *target.rglob("*.py"),
                *target.rglob("*.yaml"),
                *target.rglob("*.yml"),
            ]
            for f in files:
                if "__pycache__" in f.parts:
                    continue
                try:
                    if f.suffix == ".py":
                        # builtin compile() checks syntax WITHOUT writing a .pyc, so it
                        # never pollutes the candidate's evaluator-surface digest.
                        compile(f.read_text(encoding="utf-8"), str(f), "exec")
                    else:
                        yaml.safe_load(f.read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001 - any parse/compile error = not live
                    return False
        return True

    # -- ground truth (executable, cached) --------------------------------------
    def _shipped_passes(self, fixture_dir: Path) -> bool:
        key = str(fixture_dir)
        if key in self._shipped_cache:
            return self._shipped_cache[key]
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "pytest", "-q"],
                cwd=str(fixture_dir),
                capture_output=True,
                text=True,
                timeout=120,
            )
            result = proc.returncode == 0
        except Exception:  # noqa: BLE001
            result = False
        self._shipped_cache[key] = result
        return result

    def _anchor_items(self) -> list[tuple[str, str, bool]]:
        if self._anchor_items_cache is not None:
            return self._anchor_items_cache
        items: list[tuple[str, str, bool]] = []
        for row in _load_rows(self.source_root / "evals" / self.holdout / "tasks.jsonl"):
            contract = row["task_contract"]
            fixture = self.source_root / contract["repo"]["local_path"]
            solution = (fixture / "solution.py").read_text(encoding="utf-8")
            test = (fixture / "test_solution.py").read_text(encoding="utf-8")
            items.append((solution, test, self._shipped_passes(fixture)))
        self._anchor_items_cache = items
        return items

    def _master_key_test(self) -> str:
        items = self._anchor_items()
        return items[0][1] if items else "def test_noop():\n    assert True\n"

    # -- selection: proportional stepping-stone sampling ------------------------
    def _node_counts(self, node_id: str) -> tuple[int, int]:
        return self.archive.node_counts(node_id, self._current_epoch)

    def _sample_node(self) -> str:
        ids = list(self.archive.nodes)
        weights: list[float] = []
        for node_id in ids:
            successes, failures = self._node_counts(node_id)
            bb = best_belief(successes, failures, BB_EPSILON)
            children = len(self.archive.nodes[node_id].children)
            weights.append(bb / (children + EPS_SAMPLING))
        if sum(weights) <= 0:
            return self._rng.choice(ids)
        return self._rng.choices(ids, weights=weights, k=1)[0]

    def _least_measured_cell(self, node_id: str, roles: list[RoleSpec]) -> tuple[RoleSpec, str]:
        role = min(roles, key=lambda r: self.archive.role_count(node_id, r.name, self._current_epoch))
        best_task = role.tasks[0]
        best_count: int | None = None
        for task in role.tasks:
            successes, failures = self.archive.role_task_counts(node_id, role.name, task, self._current_epoch)
            count = successes + failures
            if best_count is None or count < best_count:
                best_count, best_task = count, task
        return role, best_task

    # -- expansion: DE-anchored mutation + novelty gate -------------------------
    def _node_bb(self, node: ArchiveNode) -> float:
        return best_belief(*self._node_counts(node.node_id), BB_EPSILON)

    def _de_instruction(self, base: ArchiveNode, parent: ArchiveNode, live: list[ArchiveNode]) -> str:
        if len(live) >= 3:
            others = [n for n in live if n.node_id != base.node_id]
            b, c = self._rng.sample(others, 2)
            return (
                "Apply a differential-evolution mutation to the harness scaffolding: "
                f"(1) identify what differs between variant {b.node_id} and variant {c.node_id}; "
                "(2) concisely mutate only those differing parts; "
                f"(3) graft the result onto the proven base {base.node_id} (the current files), "
                "selectively replacing only the changed segments; "
                f"(4) finally crossover with parent {parent.node_id}. Keep the edit small and testable."
            )
        return (
            "Make one small, testable improvement to the harness scaffolding (routing, "
            "fusion, rubric, agents, or prompts) that should raise the executable pass-rate."
        )

    def _signature(self, candidate_dir: Path, changed_paths: list[str]) -> str:
        import hashlib

        snapshot = _snapshot_tree(Path(candidate_dir))
        parts = []
        for rel in sorted(changed_paths):
            norm = rel.replace("\\", "/")
            digest = snapshot.get(norm, ("", 0))[0]
            parts.append(f"{norm}:{digest}")
        return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()

    def _de_expand(self, parent: ArchiveNode) -> dict | None:
        live = list(self.archive.nodes.values())
        base = max(live, key=self._node_bb) if len(live) >= 3 else parent
        base_dir = Path(base.workspace["candidate_dir"])
        candidate_id = self.manager.next_id()
        candidate_dir = self.manager.create_candidate(
            candidate_id, parent.workspace["candidate_id"], source_root=base_dir
        )
        instruction = self._de_instruction(base, parent, live)
        try:
            proposal = self.proposer.propose(candidate_id, candidate_dir, instruction=instruction)
        except ProposerError as exc:
            raise EvalInfraError(f"proposer failed: {exc}") from exc
        if self.manager.check_paths(proposal.changed_paths):
            return None  # forbidden-path / off-surface edit -> no node
        if not proposal.changed_paths:
            return None  # benign empty LLM proposal; fail only if the whole run gets stuck
        signature = self._signature(candidate_dir, proposal.changed_paths)
        if signature in self._signatures:
            return None  # novelty gate: duplicate diff
        self._signatures.add(signature)
        return {
            "candidate_id": candidate_id,
            "candidate_dir": str(candidate_dir),
            "changed_paths": list(proposal.changed_paths),
        }

    # -- evaluation cascade -----------------------------------------------------
    def _canary_pass(self, node: ArchiveNode) -> float:
        node_id = node.node_id
        if node_id in self._canary_cache:
            return self._canary_cache[node_id]
        candidate_dir = Path(node.workspace["candidate_dir"])
        overrides = {"max_agent_turns": 2, "max_wall_clock_seconds": 60}
        passed = 0
        for task in self._canary_tasks:
            passed += int(
                evaluate_candidate_task(
                    self.suite, task, candidate_dir,
                    self.canary_backend, self.canary_model,
                    budget_overrides=overrides, strict=True,
                )
            )
        rate = passed / len(self._canary_tasks) if self._canary_tasks else 0.0
        self._canary_cache[node_id] = rate
        return rate

    def _cascade_eval(self, node: ArchiveNode, role: RoleSpec, task: str) -> int:
        candidate_dir = Path(node.workspace["candidate_dir"])
        # Stage 1 (model-free): the candidate's changed files must compile/parse.
        if not self._compiles(candidate_dir, node.workspace.get("changed_paths", [])):
            return 0
        if role.kind == "evaluator_dependent":  # reviewer: verifier liveness signal
            return 1 if self._compiles(candidate_dir, list(_EVALUATOR_SURFACE)) else 0
        # Stage 2 (cheap canary): skip the strong eval if the child is worse than its
        # parent on a fixed canary subset. The affordability lever is task-count +
        # reduced per-task budget, which works for every backend (incl. agentic CLIs).
        canary = self._canary_pass(node)
        parent_id = node.parent_id
        if parent_id is not None and canary < self._canary_pass(self.archive.nodes[parent_id]):
            return 0
        # Stage 3 (strong): real executable pass/fail of the (node, task).
        return int(
            evaluate_candidate_task(self.suite, task, candidate_dir, self.backend, self.model, strict=True)
        )

    # -- checkpoint: co-evolving anchored verifier ------------------------------
    def _evaluator_surface_digest(self, candidate_dir: Path) -> str:
        import hashlib

        candidate_dir = Path(candidate_dir)
        parts = []
        for rel in _EVALUATOR_SURFACE:
            target = candidate_dir / rel
            if not target.exists():
                continue
            snapshot = _snapshot_tree(target)
            for key in sorted(snapshot):
                if "__pycache__" in key or key.endswith(".pyc"):
                    continue
                parts.append(f"{rel}/{key}:{snapshot[key][0]}")
        return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()

    def _verifier_len(self, candidate_dir: Path) -> int:
        candidate_dir = Path(candidate_dir)
        total = 0
        for rel in _EVALUATOR_SURFACE:
            target = candidate_dir / rel
            if target.is_file():
                total += target.stat().st_size
            elif target.is_dir():
                total += sum(f.stat().st_size for f in target.rglob("*") if f.is_file())
        return total

    def _evaluator_challengers(self, incumbent: EvaluatorCandidate) -> list[EvaluatorCandidate]:
        incumbent_digest = self._evaluator_surface_digest(Path(incumbent.state["candidate_dir"]))
        seen: dict[str, str] = {}
        for node in self.archive.nodes.values():
            candidate_dir = node.workspace["candidate_dir"]
            digest = self._evaluator_surface_digest(Path(candidate_dir))
            if digest != incumbent_digest and digest not in seen:
                seen[digest] = candidate_dir
        return [EvaluatorCandidate(f"verifier_{digest[:12]}", {"candidate_dir": cdir}) for digest, cdir in seen.items()]

    def _suite_delta(self, child_dir: str, parent_dir: str, suite: str) -> float:
        child = evaluate_candidate_suite(suite, Path(child_dir), self.backend, self.model, strict=True)
        parent = evaluate_candidate_suite(suite, Path(parent_dir), self.backend, self.model, strict=True)
        return child - parent

    def _evaluate_challenger(self, challenger: EvaluatorCandidate, incumbent: EvaluatorCandidate) -> tuple[float, int] | None:
        """Run the full Improvement-3 gate for one verifier challenger. Returns
        (anchor_best_belief, verifier_len) if it passes every gate, else None."""
        challenger_dir = challenger.state["candidate_dir"]
        probe = _VerifierProbe(challenger_dir, self.source_root)
        items = self._anchor_items()
        try:
            successes, failures, r_disc = discriminative_outcomes(probe.verdict, items)
            master_ok = passes_master_key(probe.verdict, self._master_key_test())
            est_ok = est_stable(probe.verdict, items[:2])
        finally:
            tampered = probe.tampered()
            probe.close()
        if tampered:
            return None  # subterfuge firewall: episode invalid
        if successes + failures < MIN_ANCHOR_OUTCOMES:
            return None
        if r_disc < R_DISC_MIN:
            return None  # saturated / non-discriminating verifier
        if not master_ok or not est_ok:
            return None  # master-key gaming or format-sensitivity
        delta_in = self._suite_delta(challenger_dir, incumbent.state["candidate_dir"], self.suite)
        delta_ho = self._suite_delta(challenger_dir, incumbent.state["candidate_dir"], self.holdout)
        if not dual_split_ok(delta_in, delta_ho):
            return None
        return best_belief(successes, failures, BB_EPSILON), self._verifier_len(Path(challenger_dir))

    def _checkpoint(self, frozen: dict, epoch: dict, replacements: list, at_eval: int) -> None:
        slot = 0
        incumbent = frozen[slot]
        challengers = self._evaluator_challengers(incumbent)
        if not challengers:
            return
        # Score the incumbent on the same frozen anchor (its own probe).
        inc_probe = _VerifierProbe(incumbent.state["candidate_dir"], self.source_root)
        try:
            inc_successes, inc_failures, _ = discriminative_outcomes(inc_probe.verdict, self._anchor_items())
        finally:
            inc_probe.close()
        winner = incumbent
        winner_bb = best_belief(inc_successes, inc_failures, BB_EPSILON)
        winner_len = self._verifier_len(Path(incumbent.state["candidate_dir"]))
        for challenger in challengers:
            decision = self._evaluate_challenger(challenger, incumbent)
            if decision is None:
                continue
            bb, vlen = decision
            # Strict ">" keeps the incumbent on ties; length-control tie-break prefers
            # the shorter/stricter verifier on near-equal anchor best-belief.
            if bb > winner_bb + 1e-9 or (abs(bb - winner_bb) <= 1e-9 and vlen < winner_len):
                winner, winner_bb, winner_len = challenger, bb, vlen
        if winner.evaluator_id != incumbent.evaluator_id:
            epoch[slot] += 1
            frozen[slot] = winner
            self._current_epoch[slot] = winner.evaluator_id
            erased = self.archive.erase_slot(slot, winner.evaluator_id)
            replacements.append({
                "slot": slot,
                "from_id": incumbent.evaluator_id,
                "to_id": winner.evaluator_id,
                "anchor_best_belief": round(winner_bb, 6),
                "erased": erased,
                "at_eval": at_eval,
            })

    # -- final selection --------------------------------------------------------
    def _select_best(self) -> str:
        best_id: str | None = None
        best_score = -1.0
        for node_id in self.archive.nodes:
            successes, failures = self._node_counts(node_id)
            if successes + failures < MIN_NODE_EVALS:
                continue
            score = best_belief(successes, failures, BB_EPSILON)
            if score > best_score:
                best_score, best_id = score, node_id
        if best_id is not None:
            return best_id
        # Fallback: most-measured posterior mean among all nodes.
        return max(
            self.archive.nodes,
            key=lambda n: posterior_mean(*self._node_counts(n)),
        )

    # -- main loop --------------------------------------------------------------
    def run(self) -> RqgmEvolveResult:
        self._preflight()
        roles = self.roles()
        checkpoints = set(exponential_checkpoints(self.budget, CHECKPOINT_BASE, CHECKPOINT_MIN))

        seed_dir = self.manager.create_candidate("candidate_seed", None, source_root=self.source_root)
        self.archive.add_node(ArchiveNode(
            "node_0000", None,
            workspace={"candidate_id": "candidate_seed", "candidate_dir": str(seed_dir), "changed_paths": []},
        ))
        self._signatures.add(self._signature(seed_dir, []))

        epoch = {0: 1}
        frozen = {0: EvaluatorCandidate("verifier_e0", {"candidate_dir": str(seed_dir)})}
        self._current_epoch = {0: frozen[0].evaluator_id}
        next_index = 1
        num_eval = num_exp = 0
        replacements: list[dict] = []
        sampled_parents: list[str] = []

        while num_eval < self.budget:
            # (1) UCB-Air-gated expansion via DE-anchored mutation + novelty gate.
            if num_eval ** ALPHA >= len(self.archive.nodes):
                parent_id = self._sample_node()
                sampled_parents.append(parent_id)
                child = self._de_expand(self.archive.nodes[parent_id])
                if child is not None:
                    child_id = f"node_{next_index:04d}"
                    next_index += 1
                    self.archive.add_node(ArchiveNode(child_id, parent_id, workspace=child))
                num_exp += 1

            # (2) proportional sampling -> least-measured cell -> cascade eval.
            node_id = self._sample_node()
            sampled_parents.append(node_id)
            role, task = self._least_measured_cell(node_id, roles)
            outcome = self._cascade_eval(self.archive.nodes[node_id], role, task)
            dep = (0,) if role.kind == "evaluator_dependent" else ()
            tags = {0: frozen[0].evaluator_id} if dep else {}
            self.archive.add_record(UtilityRecord(
                node_id=node_id, role=role.name, task=task, outcome=int(outcome),
                dep=dep, criterion_tags=tags, epoch_vector=(epoch[0],),
            ))
            num_eval += 1

            # (3) checkpoint: maybe co-evolve the verifier + selectively erase.
            if num_eval in checkpoints:
                self._checkpoint(frozen, epoch, replacements, num_eval)
        if num_exp > 0 and len(self.archive.nodes) == 1:
            raise EvalInfraError(
                "proposer produced no accepted scaffold edits; check proposer CLI permissions and output"
            )


        best_id = self._select_best()
        best_dir = self.archive.nodes[best_id].workspace["candidate_dir"]
        seed_ho = evaluate_candidate_suite(self.holdout, seed_dir, self.backend, self.model, strict=True)
        best_ho = evaluate_candidate_suite(self.holdout, Path(best_dir), self.backend, self.model, strict=True)
        return RqgmEvolveResult(
            best_candidate_id=self.archive.nodes[best_id].workspace["candidate_id"],
            seed_holdout_pass=seed_ho,
            best_holdout_pass=best_ho,
            holdout_delta=best_ho - seed_ho,
            replacements=replacements,
            archive_size=len(self.archive.nodes),
            records_retained=len(self.archive.records),
            num_evaluations=num_eval,
            num_expansions=num_exp,
            sampled_parents=sampled_parents,
        )

    # -- promotion (--apply) ----------------------------------------------------
    def apply_best(self, result: RqgmEvolveResult) -> bool:
        """Promote the best candidate's editable surface into the source repo iff the
        promotion policy allows it: a strictly positive holdout delta, no forbidden
        edits, human-initiated (the operator passed --apply). Writes only
        ``_COPY_SURFACE`` files; ``check_paths`` guarantees nothing forbidden is touched."""
        node = next(
            (n for n in self.archive.nodes.values() if n.workspace["candidate_id"] == result.best_candidate_id),
            None,
        )
        if node is None:
            return False
        candidate_dir = Path(node.workspace["candidate_dir"])
        changed = node.workspace.get("changed_paths", [])
        if self.manager.check_paths(changed):
            return False
        search_improved = result.holdout_delta > 0
        if not promotion_allowed(search_improved, validation_ok=True, safety_failures=0, human_review=True):
            return False
        from harness.meta.candidate_manager import _COPY_SURFACE

        for rel in _COPY_SURFACE:
            src = candidate_dir / rel
            if not src.exists():
                continue
            dest = self.source_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(src, dest, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dest)
        result.applied = True
        return True
