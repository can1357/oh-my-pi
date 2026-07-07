"""Agentic fusion weaver on tau-bench: can a verifier capture the +15pp agentic oracle headroom?

The airline probe found real headroom (oracle 0.75 vs best_lane 0.60). This tests whether our
verifier-guided idea — adapted from MC answers to agent *trajectories* — recovers it. Each lane plays
the task; then a reputation-blind verifier reads the goal + policy + each lane's action transcript
(labeled A/B/C, shuffled) and picks the trajectory that best completed the task. The picked lane's
objective reward is the fusion outcome.

    python evals/agentic/tau_fusion.py --domain airline --n 20 --verifier cx/gpt-5.5

Reports: per-lane success, best_lane, oracle, fusion_verifier accuracy, oracle-capture, and a
random-selection baseline. All via 9router.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from math import comb
from pathlib import Path

_KEY = os.environ.get("NINEROUTER_API_KEY") or os.environ.get("9ROUTER_API_KEY") or "local-9router"
os.environ.setdefault("OPENAI_API_KEY", _KEY)
os.environ.setdefault("OPENAI_API_BASE", "http://localhost:20128/v1")
os.environ.setdefault("OPENAI_BASE_URL", "http://localhost:20128/v1")

import litellm  # noqa: E402
litellm.suppress_debug_info = True  # silence litellm's per-call "Provider List" banner on routed lanes

from openai import OpenAI  # noqa: E402
from tau_bench.agents.tool_calling_agent import ToolCallingAgent  # noqa: E402
from tau_bench.envs import get_env  # noqa: E402

import sys as _sys  # noqa: E402
_sys.path.insert(0, os.path.dirname(__file__))
from adaptive import is_hard, outcome_key, pick_reserve_lanes  # noqa: E402,F401
from passk import aggregate_pass_k  # noqa: E402
from verifier_accuracy import discrimination_accuracy  # noqa: E402
from verifier_strategies import rank_candidates  # noqa: E402

# Diverse, reliable lane pool — SIX distinct model families to widen oracle headroom (the limiter on a
# significant fusion win): Moonshot, MiniMax, Qwen, DeepSeek, Anthropic, Google. Qwen + DeepSeek route
# via local 9router Cline aliases; Claude + Gemini-Pro use the cheaper 9router-native cc/ + ag/ routes.
# Override with --lanes.
LANES = ["kimi/kimi-k2.6", "minimax/MiniMax-M3",
         "cline-qwen3.7-plus", "cline-deepseek-v4-pro",
         "cc/claude-sonnet-4-6", "ag/gemini-3.1-pro-low"]
# Extra lanes the adaptive controller may escalate to on HARD tasks (env-aware fan-out). All tool-loop-safe
# (cx/gpt-5.5 is excluded — it breaks the multi-turn loop via litellm; it stays the verifier).
RESERVE_POOL = ["ag/gemini-3.5-flash-low", "cline-qwen3.7-plus",
                "cline-deepseek-v4-flash", "kimi/kimi-for-coding"]
# Per-lane FAILOVER chains: if a lane's backend crashes the rollout (retries exhausted), substitute the
# verified-working in the tool loop (via 9router or free-provider routes). Override with --lane-backups
# "lane=b1|b2".
LANE_BACKUPS = {
    "kimi/kimi-k2.6": ["kimi/kimi-for-coding", "kimi/kimi-k2.5"],
    "minimax/MiniMax-M3": ["minimax/MiniMax-M2.5", "kimi/kimi-for-coding"],
    "cline-qwen3.7-plus": ["cline-qwen3.7-max", "minimax/MiniMax-M2.5"],
    "cline-deepseek-v4-pro": ["cline-deepseek-v4-flash", "kimi/kimi-for-coding"],
    "cc/claude-sonnet-4-6": ["cx/gpt-5.5", "kimi/kimi-for-coding"],
    "ag/gemini-3.1-pro-low": ["ag/gemini-3.5-flash-low", "minimax/MiniMax-M2.5"],
    "ag/gemini-3.5-flash-low": ["minimax/MiniMax-M2.5", "kimi/kimi-for-coding"],
}
_client = OpenAI(base_url="http://localhost:20128/v1", api_key=_KEY, timeout=90)


def _serialize(messages: list[dict], cap: int = 280, max_lines: int = 60) -> str:
    """Compact agent action transcript: tool calls + results + replies to the user."""
    lines: list[str] = []
    for m in messages or []:
        role = m.get("role")
        if role == "assistant":
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function", {})
                lines.append(f"ACTION {fn.get('name')}({str(fn.get('arguments', ''))[:200]})")
            if m.get("content"):
                lines.append(f"REPLY: {str(m['content'])[:cap]}")
        elif role == "tool":
            lines.append(f"  -> {str(m.get('content', ''))[:cap]}")
    return "\n".join(lines[:max_lines]) or "(no actions)"


def _db_diff(initial: dict, final: dict, cap: int = 320, max_lines: int = 30) -> str:
    """Net effect of the agent's actions on the mutable tables — the OUTCOME the verdict turns on.
    (The gold actions in task.actions are NOT shown to the verifier; only each lane's own result is.)"""
    out: list[str] = []
    for table in ("reservations", "users"):
        i, f = initial.get(table, {}), final.get(table, {})
        for k in f:
            if k not in i:
                out.append(f"+ NEW {table}/{k}: {json.dumps(f[k])[:cap]}")
            elif f[k] != i[k]:
                ch = {kk: f[k].get(kk) for kk in f[k] if isinstance(f[k], dict) and i.get(k, {}).get(kk) != f[k].get(kk)}
                out.append(f"~ CHANGED {table}/{k}: {json.dumps(ch)[:cap]}")
        for k in i:
            if k not in f:
                out.append(f"- REMOVED {table}/{k}")
    return "\n".join(out[:max_lines]) or "(no database changes)"


def _provider_for(model: str) -> str | None:
    """litellm provider for a lane. All default lanes now route through the local 9router
    OpenAI-compatible endpoint, including bare combo aliases such as cline-qwen3.7-plus."""
    return "openai"


def select_lanes(lanes: list[str], n_lanes: int) -> list[str]:
    """Subset to the first n_lanes (0 = all) — dial the pool size / cost without re-listing the models."""
    return lanes[:n_lanes] if n_lanes and 0 < n_lanes < len(lanes) else list(lanes)


def _run_lane(domain: str, user_model: str, lane: str, ti: int, max_steps: int,
              backups: list[str] | None = None) -> dict:
    """Run a lane; on persistent rollout error, FAIL OVER to backup models in order so the slot stays
    filled by a HEALTHY model. This keeps the pool diverse and at full N when a lane's backend crashes
    (e.g. gemini's 45/50 collapse under load), instead of silently zeroing the slot and crushing the
    oracle headroom. `ran_model` records which model actually filled the slot."""
    last = None
    for model in [lane] + list(backups or []):
        for _attempt in range(2):
            try:
                env = get_env(domain, user_strategy="llm", user_model=user_model,
                              user_provider="openai", task_split="test")
                env.reset(ti)
                initial = copy.deepcopy(env.data)  # task's starting DB (solve resets to the same state)
                agent = ToolCallingAgent(env.tools_info, env.wiki, model=model,
                                         provider=_provider_for(model), temperature=0.0)
                res = agent.solve(env, task_index=ti, max_num_steps=max_steps)
                return {"lane": lane, "ran_model": model, "failed_over": model != lane, "task": ti,
                        "reward": float(getattr(res, "reward", 0.0)),
                        "cost": float(getattr(res, "total_cost", 0.0) or 0.0),  # USD, from litellm token usage
                        "transcript": _serialize(getattr(res, "messages", [])),
                        "db_diff": _db_diff(initial, env.data)}
            except Exception as exc:
                last = repr(exc)[:160]
    return {"lane": lane, "ran_model": None, "failed_over": True, "task": ti, "reward": 0.0, "cost": 0.0,
            "transcript": "(all models failed)", "db_diff": "(all models failed)", "error": last}


_VERIFY_SYS = (
    "You are a strict, reputation-blind verifier of customer-service AI agents. You are given the company "
    "POLICY, the user's GOAL, and several agents' action transcripts (labeled by letter). Decide which "
    "agent most correctly and completely fulfilled the GOAL while following the POLICY — judge the actions "
    "taken (tool calls) and the final reply, not style or verbosity. Reply ONLY with JSON: "
    '{"winner": "<letter>", "reason": "<one line>"}.')


def _verify(verifier: str, wiki: str, goal: str, labeled: list[tuple[str, str]]) -> str | None:
    blocks = "\n\n".join(f"[Agent {ltr}]\n{tx}" for ltr, tx in labeled)
    user = (f"POLICY:\n{wiki[:4000]}\n\nGOAL:\n{goal}\n\nAGENT TRANSCRIPTS:\n{blocks}\n\n"
            f"Which agent ({', '.join(l for l, _ in labeled)}) best fulfilled the goal per policy?")
    try:
        r = _client.chat.completions.create(
            model=verifier, messages=[{"role": "system", "content": _VERIFY_SYS}, {"role": "user", "content": user}],
            temperature=0.0, max_tokens=400)
        txt = r.choices[0].message.content or ""
        m = re.search(r'"winner"\s*:\s*"?([A-Z])', txt) or re.search(r"\b([A-Z])\b", txt.strip())
        return m.group(1) if m else None
    except Exception:
        return None


def _verify_aggregate(verifier: str, wiki: str, goal: str, recs: dict,
                      orderings: int = 0) -> tuple[str | None, dict, bool]:
    """Swap-and-aggregate over N cyclic rotations so each trajectory occupies each position once;
    majority-vote the winning lane (cancels position bias — the JudgeBench-0.902 trick for N-way).
    orderings=1 => single pass (no aggregation); 0 or >=len(lanes) => full cyclic set."""
    lanes = list(recs.keys())
    k = len(lanes) if orderings <= 0 else min(orderings, len(lanes))
    votes: dict[str, int] = {}
    for i in range(k):
        rot = lanes[i:] + lanes[:i]
        letters = [chr(ord("A") + j) for j in range(len(rot))]
        labeled = [(letters[j], recs[rot[j]]["transcript"]) for j in range(len(rot))]
        l2lane = {letters[j]: rot[j] for j in range(len(rot))}
        lane = l2lane.get(_verify(verifier, wiki, goal, labeled))
        if lane:
            votes[lane] = votes.get(lane, 0) + 1
    if not votes:
        return None, votes, False
    top = max(votes.values())
    winners = [m for m in lanes if votes.get(m, 0) == top]  # base-order tiebreak
    return winners[0], votes, len(winners) == 1  # decisive iff a unique top across orderings


def _paired_bootstrap(a: list[float], b: list[float], B: int = 10000) -> tuple[float, float, float]:
    """Paired bootstrap over tasks for (mean a − mean b); returns (delta, lo95, hi95)."""
    import random
    rng = random.Random(0)
    n = len(a)
    deltas = []
    for _ in range(B):
        sa = sb = 0.0
        for _ in range(n):
            j = rng.randrange(n)
            sa += a[j]
            sb += b[j]
        deltas.append((sa - sb) / n)
    deltas.sort()
    return (sum(a) - sum(b)) / n, deltas[int(0.025 * B)], deltas[int(0.975 * B)]


def _mcnemar(a: list[float], b: list[float]) -> tuple[int, int, float]:
    """Exact McNemar on paired 0/1 outcomes: a-right/b-wrong vs a-wrong/b-right."""
    bb = sum(1 for x, y in zip(a, b) if x >= 1 and y < 1)
    cc = sum(1 for x, y in zip(a, b) if x < 1 and y >= 1)
    nn = bb + cc
    if nn == 0:
        return bb, cc, 1.0
    k = min(bb, cc)
    return bb, cc, min(1.0, 2.0 * sum(comb(nn, i) for i in range(k + 1)) * (0.5 ** nn))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="airline", choices=["retail", "airline"])
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--lanes", default=",".join(LANES))
    ap.add_argument("--n-lanes", type=int, default=0,
                    help="use only the first N of --lanes (0 = all) — dial pool size / cost without re-listing models")
    ap.add_argument("--budget", type=float, default=0.0,
                    help="USD cost cap (measured via litellm total_cost): stop launching new tasks once exceeded (0 = no cap)")
    ap.add_argument("--user-model", default="cx/gpt-5.5")
    ap.add_argument("--verifier", default="cx/gpt-5.5")
    ap.add_argument("--max-steps", type=int, default=30)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--reuse", action="store_true", help="reuse cached trajectories (skip rollouts) to iterate cheaply on the verifier")
    ap.add_argument("--orderings", type=int, default=0, help="verifier orderings: 1=single pass, 0=full cyclic swap-and-aggregate")
    ap.add_argument("--env-aware", action="store_true", help="show the verifier each lane's resulting DB changes, not just the transcript")
    ap.add_argument("--strategy", default="", choices=["", "transcript", "env_aware", "diff_primary", "aspect", "genrm"],
                    help="M4 ranking strategy for selection; empty = legacy swap-and-aggregate verifier")
    ap.add_argument("--adaptive", action="store_true",
                    help="M3 controller: escalate HARD tasks (lanes disagree on outcome) to reserve lanes")
    ap.add_argument("--reserve-lanes", default=",".join(RESERVE_POOL),
                    help="reserve lane pool the adaptive controller may add on HARD tasks")
    ap.add_argument("--lane-backups", default="",
                    help="override failover chains: 'lane=b1|b2,lane2=b3' (default: built-in LANE_BACKUPS)")
    ap.add_argument("--trials", type=int, default=1,
                    help="per (lane,task) rollout trials; >1 enables pass@k / pass^k reliability metrics (M2)")
    ap.add_argument("--gate", action="store_true",
                    help="M1 self-enhancement-bias gate: require >=0.60 pairwise discrimination before trusting selection")
    ap.add_argument("--out", default="evals/agentic/tau_fusion.json")
    args = ap.parse_args()
    lanes = select_lanes([m.strip() for m in args.lanes.split(",") if m.strip()], args.n_lanes)
    if args.n_lanes:
        print(f"[lanes] using {len(lanes)} lane(s): {lanes}", flush=True)
    cache_path = Path(args.out).with_name(f"tau_cache_{args.domain}.json")

    # Stage A: run every lane on every task (capture reward + transcript) — or reuse the cache.
    if args.reuse and cache_path.exists():
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
        by_task = {int(t): v for t, v in raw.items()}
        print(f"[reuse] {len(by_task)} cached tasks from {cache_path.name} — skipping rollouts", flush=True)
    else:
        backups_map = dict(LANE_BACKUPS)
        for spec in (args.lane_backups.split(",") if args.lane_backups else []):
            if "=" in spec:
                k, v = spec.split("=", 1)
                backups_map[k.strip()] = [b.strip() for b in v.split("|") if b.strip()]

        def _dispatch(j):
            return _run_lane(args.domain, args.user_model, j[0], j[1], args.max_steps, backups_map.get(j[0]))

        rolls, spent = [], 0.0
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            if args.budget:  # task-by-task so we can stop at the USD cap (bounded overshoot = one task's lanes)
                for ti in range(args.n):
                    if spent >= args.budget:
                        print(f"[budget] ${spent:.2f} >= ${args.budget:.2f} cap — stopping after {ti}/{args.n} tasks", flush=True)
                        break
                    task_rolls = list(ex.map(_dispatch, [(lane, ti) for lane in lanes]))
                    rolls.extend(task_rolls)
                    spent += sum(r.get("cost", 0.0) for r in task_rolls)
            else:  # no cap — full job pool for max throughput
                rolls = list(ex.map(_dispatch, [(lane, ti) for ti in range(args.n) for lane in lanes]))
                spent = sum(r.get("cost", 0.0) for r in rolls)
        by_task = {}
        for r in rolls:
            by_task.setdefault(r["task"], {})[r["lane"]] = r
        n_fo = sum(1 for r in rolls if r.get("failed_over"))
        if n_fo:
            print(f"[failover] {n_fo}/{len(rolls)} rollouts substituted a backup model", flush=True)
        print(f"[cost] measured spend ${spent:.4f} over {len(by_task)} tasks x {len(lanes)} lanes", flush=True)
        cache_path.write_text(json.dumps({str(t): by_task[t] for t in sorted(by_task)}, indent=1), encoding="utf-8")

    # Need the wiki + per-task goal for the verifier.
    env = get_env(args.domain, user_strategy="llm", user_model=args.user_model, user_provider="openai", task_split="test")
    wiki = env.wiki
    reserve_pool = [m.strip() for m in args.reserve_lanes.split(",") if m.strip()]

    # M1: self-enhancement-bias gate. If the verifier can't discriminate solved vs unsolved
    # trajectories (>=0.60 pairwise), selection HURTS — refuse to trust it.
    gate_pass = None
    if args.gate:
        gate_acc, gate_pass = discrimination_accuracy(str(cache_path), args.verifier, env_aware=args.env_aware)
        print(f"[gate] pairwise discrimination {gate_acc} (>=0.60: {'PASS' if gate_pass else 'FAIL'})", flush=True)
        if not gate_pass:
            print("[gate] verifier below the self-enhancement-bias floor — selection is unreliable here", flush=True)

    # Stage B: verifier picks the best trajectory per task (reputation-blind, shuffled labels).
    def fuse(ti: int) -> dict:
        recs = by_task[ti]
        goal = env.tasks[ti].instruction
        # M3: an adaptive controller escalates HARD tasks (lanes disagree on the net DB outcome)
        # to reserve lanes so selection has a correct trajectory to find. Reserves reuse the cache
        # if present (rollout-free); otherwise they are rolled out on demand.
        escalated = False
        if args.adaptive and is_hard(recs):
            extra = pick_reserve_lanes(reserve_pool, k=1, exclude=set(recs.keys()))
            for lane in extra:
                rec = recs.get(lane)
                if rec is None and not (args.reuse and cache_path.exists()):
                    rec = _run_lane(args.domain, args.user_model, lane, ti, args.max_steps)
                if rec is not None:
                    recs = {**recs, lane: rec}
                    escalated = True
        if args.strategy:  # M4 strategy ranking (best-first); take the top lane.
            ranked = rank_candidates(_client, args.verifier, wiki, goal, recs, mode=args.strategy)
            picked = ranked[0] if ranked else list(recs.keys())[0]
            decisive = bool(ranked)
        else:
            if args.env_aware:  # augment each transcript with the agent's net DB changes (the outcome signal)
                view = {m: {"transcript": recs[m]["transcript"]
                            + "\n\nRESULTING DATABASE CHANGES (this agent's net effect):\n"
                            + recs[m].get("db_diff", "(n/a)")} for m in recs}
            else:
                view = recs
            picked, votes, decisive = _verify_aggregate(args.verifier, wiki, goal, view, orderings=args.orderings)
            if picked is None:
                picked = list(recs.keys())[0]  # all verifier calls failed — deterministic default
        return {"task": ti, "picked_lane": picked, "fusion_reward": recs[picked]["reward"],
                "decisive": decisive, "escalated": escalated}

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        fused = {f["task"]: f for f in ex.map(fuse, sorted(by_task))}

    tasks = sorted(by_task)
    n = len(tasks)
    lane_acc = {m: round(sum(by_task[t][m]["reward"] for t in tasks) / n, 4) for m in lanes}
    best_lane_model = max(lane_acc, key=lane_acc.get)
    best_lane = lane_acc[best_lane_model]
    oracle = round(sum(1 for t in tasks if any(by_task[t][m]["reward"] >= 1.0 for m in lanes)) / n, 4)
    fusion = round(sum(fused[t]["fusion_reward"] for t in tasks) / n, 4)
    rand = round(sum(lane_acc.values()) / len(lanes), 4)
    headroom = oracle - best_lane
    capture = round((fusion - best_lane) / headroom, 4) if headroom > 1e-9 else 0.0

    # Paired bootstrap CIs + McNemar (fusion vs best lane) over tasks.
    best_arr = [by_task[t][best_lane_model]["reward"] for t in tasks]
    fus_arr = [fused[t]["fusion_reward"] for t in tasks]
    orc_arr = [1.0 if any(by_task[t][m]["reward"] >= 1.0 for m in lanes) else 0.0 for t in tasks]
    fd, flo, fhi = _paired_bootstrap(fus_arr, best_arr)
    od, olo, ohi = _paired_bootstrap(orc_arr, best_arr)
    mb, mc, mp = _mcnemar(best_arr, fus_arr)
    total_cost = round(sum(by_task[t][m].get("cost", 0.0) for t in tasks for m in by_task[t]), 4)
    cost_per_lane = {m: round(sum(by_task[t][m].get("cost", 0.0) for t in tasks if m in by_task[t]), 4) for m in lanes}
    report = {
        "domain": args.domain, "n": n, "tasks_requested": args.n, "n_lanes": len(lanes),
        "lanes": lanes, "verifier": args.verifier,
        "total_cost_usd": total_cost, "cost_per_lane": cost_per_lane,
        "lane_success": lane_acc, "best_lane": best_lane, "oracle": oracle, "headroom": round(headroom, 4),
        "random_select": rand, "fusion_verifier": fusion,
        "oracle_capture": capture, "fusion_beats_best_lane": fusion > best_lane + 1e-9,
        "best_lane_model": best_lane_model, "env_aware": args.env_aware,
        "fusion_vs_best_delta_ci": [round(flo, 4), round(fhi, 4)],
        "fusion_delta_ci_excludes_0": bool(flo > 0 or fhi < 0),
        "fusion_mcnemar": {"b": mb, "c": mc, "p": round(mp, 4)},
        "oracle_vs_best_delta_ci": [round(olo, 4), round(ohi, 4)],
        "verifier_method": (f"M4:{args.strategy}" if args.strategy else "swap-and-aggregate (cyclic rotations)"),
        "adaptive": args.adaptive,
        "escalated_rate": round(sum(1 for t in tasks if fused[t].get("escalated")) / n, 4) if n else 0.0,
        "discrimination_gate_pass": gate_pass,
        "decisive_rate": round(sum(1 for t in tasks if fused[t]["decisive"]) / n, 4),
        "picks": {str(t): fused[t]["picked_lane"] for t in tasks},
    }
    # M2: when multiple trials per (lane,task) are available, report pass@k / pass^k reliability.
    if args.trials > 1:
        per_task = {t: {m: [by_task[t][m]["reward"]] for m in by_task[t]} for t in tasks}
        report["reliability"] = aggregate_pass_k(per_task, k_values=[1, 2, 4])
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "picks"}, indent=2))
    print(f"\nFUSION {fusion} vs best_lane {best_lane} (oracle {oracle}); "
          f"captures {int(capture*100)}% of the +{headroom:.3f} headroom; "
          f"{'BEATS best lane' if report['fusion_beats_best_lane'] else 'does not beat best lane'}")


if __name__ == "__main__":
    main()
