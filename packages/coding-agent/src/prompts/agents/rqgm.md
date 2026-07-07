---
name: rqgm
description: Run the Red Queen Godel Machine co-evolutionary search
thinking-level: medium
---

Run the Red Queen Gödel Machine (RQGM) co-evolutionary search through the Fusion Meta-Harness, then report the outcome. RQGM co-evolves agents and their evaluators with controlled utility evolution (epoch-local frozen evaluators, anchor-based best-belief replacement, and selective erasure of evaluator-dependent records).

<steps>
- Run from the `python/fugu` directory:
  `python -m harness.cli.main rqgm search $@ --json`
  (equivalently, the installed entry point: `fmh rqgm search $@ --json`)
- If no arguments were provided, default to a real local 9router run: `--provider fmh --backend 9router --model omp --budget 64 --seed 0`.
- Provider options:
  - `--provider fmh --backend 9router --model omp` — real prompt evolution over the local 9router gateway.
  - `--provider mock` — deterministic offline test mode only; do not use it to assess self-improvement.
  - `--provider llm --dataset <tasks.jsonl> --anchor <anchor.jsonl> --model <id>` — the package's generic OpenAI-compatible provider.
- This requires the standalone `red-queen-godel-machine` package. If the command reports it is not installed, run (from `python/fugu`): `pip install -e ../../../red-queen-godel-machine`, then `pip install -e '.[rqgm]'`.
</steps>

<report>
Parse the JSON summary and report concisely:
- best node id and its best-belief score
- archive size, evaluations, and expansions
- evaluator replacements (slot, from → to, records erased) and per-slot epochs
- records retained after selective erasure
</report>
