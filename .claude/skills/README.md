# Project skills

These are instructions for explicitly selected tasks, not new hooks, runtime
tools or verification gates. Existing project/user rules remain authoritative.

| Repo-native skill | Purpose |
|---|---|
| [omp-source-audit](omp-source-audit/SKILL.md) | Trace current code and classify implemented versus planned capabilities |
| [omp-adr-plan](omp-adr-plan/SKILL.md) | Turn evidence into a repo-format decision and bounded implementation slice |
| [omp-implement-slice](omp-implement-slice/SKILL.md) | Implement one owned slice with native seams and appropriate checks |
| [omp-evidence-review](omp-evidence-review/SKILL.md) | Review current artifacts against complete, source-bound evidence |
| [omp-gap-research](omp-gap-research/SKILL.md) | Study / inventory / classify / research a capability gap (`docs/research/`) |
| [omp-adr](omp-adr/SKILL.md) | Author ADRs with this repo's format, numbering, and STATUS/TASKS rows |
| [omp-slice-plan](omp-slice-plan/SKILL.md) | Slice an ADR into one-PR units with acceptance criteria and test kinds |
| [omp-pre-pr](omp-pre-pr/SKILL.md) | Diff review plus `just` check/test/lintx before opening a slice PR |

Seven upstream EGM skills are included separately: brainstorm, draft, resolve,
review, review-loop, bootstrap and drift-report. Read their
[provenance and host instructions](EGM-PROVENANCE.md) before invocation.
Upstream files remain unchanged; their LICENSE and local NOTICE apply as stated
there. Vendoring does not execute their interactive workflow or certify host isolation.

OMP2 already discovers ancestor `.claude/skills/<name>/SKILL.md` when the Claude
project skill source is enabled. Host source policy/trust and session loading
still apply. No `.claude/settings.json` change is needed. In a harness without
automatic discovery, explicitly read the desired entry point and its references.
