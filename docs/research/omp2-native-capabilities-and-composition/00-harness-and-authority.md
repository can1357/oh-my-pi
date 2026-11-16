# Harness capabilities and project authority

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff` (2026-11-16 UTC).

## Authority order

1. User instructions for this program.  
2. Repository `AGENTS.md` and accepted ADRs.  
3. Repo-native OMP skills (`.claude/skills/omp-*`).  
4. Vendored EGM skills (`.claude/skills/egm-*`) when explicitly invoked — provenance
   [EGM-PROVENANCE.md](../../../.claude/skills/EGM-PROVENANCE.md), upstream
   `964a4f1ecd333961375c35cb37ed09364dab5e4e`.  
5. Optional external references only when a concrete gap requires them.

## Production ownership (must not duplicate)

| Concern | Owner |
|---|---|
| Composition | `omp-driver` (`compose_kernel`) |
| Presentation / CLI | `omp-app` |
| Kernel / turns | `omp-agent` |
| Project effects / policy | `omp-envd` |
| Typed env client | `omp-env` |
| Durable state | `omp-journal` / session DOM |
| Model routing | catalog + `omp-ai` |
| Tools | `omp-tool` contracts, `omp-tools` / envd impl |
| Workflow DAG | `omp-adw` + driver ADW host |
| Hooks | contract catalog + driver/envd/ai surfaces |

## EGM operational rules for this program

- Elephant (this coordinator) retains evidence, alternatives, and owner questions.  
- Goldfish reviewers run as fresh Cursor `Task` agents with pinned SHA and narrow
  assignment; they do not inherit this chat’s conclusions.  
- Model agreement is not acceptance. ADRs stay `proposed` until the owner accepts.  
- Vendored EGM files are not modified.

## What this program will not do without authorization

- Second production stack, scheduler, approval engine, model router, skill registry,
  journal, or verification engine.  
- Nonstandard Agent Skills top-level fields claimed as “official”.  
- Embedding sHEL or a second shell interpreter without measured benefit.  
- Merging PRs.
