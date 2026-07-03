---
name: tree-of-thoughts
description: Use for hard single problems where intermediate errors compound — combinatorial choices, multi-step math/logic, design decisions with genuinely different branches. Structured branch-evaluate-prune reasoning with explicit budgets; includes the MapReduce hybrid pattern.
---

# Tree-of-Thoughts Scaling

Chain-of-thought commits to the first plausible reasoning chain; on problems with combinatorial structure, one early wrong step sinks the run. Tree-of-Thoughts frames the problem as **search over reasoning states**: generate alternatives at each step, evaluate before descending, prune and backtrack.

Cost is O(k × depth × beam) model calls vs 1 for linear reasoning. Spend it only where it pays.

## When to use / not use

| Use | Don't use |
|---|---|
| Combinatorial search (scheduling, constraint satisfaction) | Simple or single-step tasks — linear reasoning suffices |
| Multi-step math/logic where errors compound | No reliable way to evaluate intermediate states |
| Design decisions with materially different branches | Open-ended generation with no goal state |
| Puzzle-like debugging (many hypotheses, cheap tests) | High-throughput / latency-critical paths |

## The four decisions

1. **Granularity** — what is one "thought"? One arithmetic operation, one design commitment, one hypothesis. Too coarse hides errors; too fine wastes budget.
2. **Generation** — k=2–4 candidates per node. *Sampling* (independent, diverse) for open-ended steps; *sequential proposal* (each aware of the previous) for structured ones. Candidates must differ materially, not in phrasing.
3. **Evaluation** — score each candidate before descending: `sure / likely / impossible`, grounded in evidence (read the code, check the doc, run the arithmetic). Comparative voting between siblings beats absolute scores for subjective quality. Unreliable evaluation degrades the search to random walk — if you can't evaluate, don't tree-search.
4. **Search** — beam of 1–2 per level. Descend on the leader; backtrack immediately on `impossible`. Stop when a goal state passes verification or the budget cap hits (~15 expanded nodes default).

## Delegation

For a self-contained hard problem, spawn the `tot-reasoner` agent — it returns the answer plus the winning path and the pruned branches (the rejected alternatives are often as valuable as the answer). Do the tree search inline only when the problem is entangled with your current working context.

## Hybrid: MapReduce × ToT

When the workload is **large input AND deep per-item reasoning** (e.g. security scan where shard verdicts need multi-step exploit-chain reasoning):

1. `agentic-mapreduce` outer loop shards the input deterministically.
2. Each map worker applies ToT discipline (or spawns `tot-reasoner`) for its shard's hard sub-problem.
3. The reducer composes per-shard solutions cross-shard as usual.

Cost multiplies: N_shards × k × d × b. Control it with beam search, tight per-worker node caps, and adaptive depth (stop expanding once one candidate clearly dominates). Skip the hybrid when input is small (just ToT) or per-item reasoning is simple (just MapReduce with linear workers).

## Failure modes

| Failure | Mitigation |
|---|---|
| Branch explosion | Beam ≤ 2, node cap, adaptive depth |
| Poor evaluation → wrong pruning | Evidence-grounded scores; sibling voting; widen beam when unsure |
| No goal state → search never ends | Define termination criteria and budget cap up front |
| Tree overhead on easy problems | Collapse to linear when one candidate dominates for 2 straight levels |
