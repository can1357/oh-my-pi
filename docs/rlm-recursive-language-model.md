# Recursive Language Model (RLM) mode

Proposal to add a first-class **Recursive Language Model (RLM)** mode to omp, following the
MIT CSAIL paradigm described in *Zhang, Kraska & Khattab* — **arXiv:2512.24601**
([paper](https://arxiv.org/abs/2512.24601), [reference impl](https://github.com/alexzhang13/rlm),
[author blog](https://alexzhang13.github.io/blog/2025/rlm/)).

An RLM treats the (potentially huge) input as an external, programmable object inside a REPL
and lets the model recursively query sub-instances of itself over only the relevant snippets —
instead of forcing one giant forward pass. This addresses **context rot** (quality degradation
on dense long contexts) and extends effective context well beyond the model window.

omp is unusually well positioned to adopt this because it already ships the two building blocks
the paradigm requires: a **persistent eval kernel** and a **recursive `task` subagent
primitive**. This doc proposes wiring them together behind an opt-in RLM mode.

## Background

The MIT study proposes a general inference strategy where the model runs in a Python REPL that
stores the full prompt in an external variable. It writes code to inspect, chunk, and call a
`llm_query(snippet, instructions)` function — which invokes a sub-instance of the model on a
specific segment — recursively narrowing to the relevant parts before producing a final answer.

Reported results (median across four diverse long-context tasks, on GPT-5):

- Processes inputs up to **~2 orders of magnitude beyond the model context window**.
- **+26%** vs compaction, **+130%** vs CodeAct-with-sub-calls, **+13%** vs Claude Code, at
  comparable cost.
- A post-trained **RLM-Qwen3-8B** beats its base model by **+28.3%** and approaches vanilla
  GPT-5 on three long-context tasks.

**Why not compaction:** summarization is lossy; RLM *delegates* context to scripts and sub-LLMs
rather than condensing it, so no relevant detail is dropped. This makes it a complementary
strategy to the existing compaction machinery (see `docs/compaction.md`), not a replacement.

## Why it fits omp

1. **The REPL already exists.** `packages/coding-agent/src/eval/py/kernel.ts` (and the eval
   backend in `packages/coding-agent/src/eval/backend.ts`,
   `kernel-session-registry.ts`) is a persistent Python kernel that can call back into the
   agent's own tools over the loopback bridge — exactly the surface `llm_query()` needs.
2. **Sub-instances already exist.** The recursive `task` primitive
   (`packages/coding-agent/src/task/index.ts`, `executor.ts`, `structured-subagent.ts`) is the
   "call a sub-instance of itself" step. Recursion is already budgeted via `task.maxRecursionDepth`
   in `packages/coding-agent/src/config/settings-schema.ts`.
3. **The pain is real.** Long-context failures today surface as compaction timeouts
   (e.g. subagent `input exceeds context window` errors) — see also the demand for lossless
   context management in `docs/context-files.md` and `docs/memory.md`.

## Proposed design

An **opt-in RLM mode** (flag-gated, default off — matching omp's convention for experimental
features):

1. **`llm_query(snippet, instructions)` in the eval sandbox.**
   Expose a callable inside the persistent kernel that dispatches to the existing
   `task`/agent-spawn infrastructure rather than a new runtime. Contract mirrors the paper:
   takes a snippet of the external context plus optional instructions, returns the sub-instance
   answer.

2. **External context, not in-context.**
   Oversized inputs (multi-MB log dumps, large doc scans, broad repo sweeps) are materialized
   as an external variable in the kernel instead of being loaded into the model context.
   Candidates: a read-only reference to the session's blob/artifact store (see
   `docs/blob-artifact-architecture.md`) or a scoped temp file.

3. **Inspection/chunking helpers.**
   Provide `chunk(by=tokens|lines)`, `metadata`, and `search` so the model can recursively
   narrow before querying — the paper's decomposition pattern. These should reuse existing
   scanning/search primitives rather than introducing new ones.

4. **Recursion budget as a config knob.**
   Extend/align the recursion limit with the existing `task.maxRecursionDepth` so RLM sub-queries
   are bounded and observable (progress surfaced in the subagent HUD).

## Key implementation files (proposed touch points)

- `packages/coding-agent/src/eval/py/kernel.ts` — `llm_query()` bridge into the REPL
- `packages/coding-agent/src/eval/backend.ts` / `kernel-session-registry.ts` — kernel wiring
- `packages/coding-agent/src/task/index.ts` / `executor.ts` — dispatch of sub-instance queries
- `packages/coding-agent/src/config/settings-schema.ts` — `rlm` mode + recursion budget flags

## Success criteria

- An oversized input that today triggers `input exceeds context window` is processed
  successfully under RLM mode *without* summarization.
- An attributable quality/cost comparison vs compaction on the same input (results reported in
  the RLM mode).

## Related docs and issues

- `docs/compaction.md` — existing lossy-context machinery (RLM is complementary)
- `docs/context-files.md`, `docs/memory.md` — context surface an RLM would delegate
- Upstream: `Whamp/pi-rlm`, `manojlds/pi-rlm` — prior RLM ports for the Pi coding agent

## References

- MIT CSAIL paper: https://arxiv.org/abs/2512.24601
- Official RLM library: https://github.com/alexzhang13/rlm
- Author blog: https://alexzhang13.github.io/blog/2025/rlm/
- Follow-ups: [Prime Intellect](https://www.primeintellect.ai/blog/rlm);
  self-reflective program search (arXiv:2603.15653)
