# Skills and execution-plan validation

Date: 2026-11-14. Branch base: actual pulled `omp2` merge
`355a324e4c52bb473eca53925807972d6491d265`. This follow-up changes skill/document
assets only; it does not implement the proposed verification engine.

## Changes and rationale

- Seven EGM skill directories plus referenced personas, standards and host docs
  preserve the upstream relative layout under `.claude/`. Exact source revision,
  license, local-notice distinction and fingerprints are recorded in
  [EGM-PROVENANCE.md](../../../.claude/skills/EGM-PROVENANCE.md).
- Four short native skills follow OMP2 source-audit, ADR, implementation and
  evidence-review conventions. They reuse native architecture and prohibit
  interpreting unavailable checks or assumed parent readiness as passing/merged.
- [Execution plan](11-execution-plan.md) orders S1–S4 toward the first working
  A1/C1 deterministic receipt. Later impact/reviewer/reranker work stays separate.
  The research index links that plan. No ADR acceptance status is changed.
- No upstream plugin manifest, automatic hook, dependency or settings change
  is imported. EGM's review workflow is available, not automatically invoked.

## Executed checks

A dependency-free Python inspection compared every copied file to the pinned
checkout, checked skill entry-point names/descriptions and parsed JSON, checked native relative references,
and recomputed the manifest with the algorithm in provenance. Observed result:

```text
unchanged_upstream_files: 59
aggregate_sha256: 3d12cec49d24c644e1592cbd74df9cc7544b961dad3832df7b24c99c138becfb
skill_entrypoints: 11
native_skill_links: 13 (all resolve)
JSON: valid
seven ../../docs/codex.md links: resolve
seven ../../TESTING.md links: resolve
44 literal relative Markdown links across the bundle: resolve
```

`python3 docs/research/omp2-hybrid-verification/experiments/evidence_keys.py`
exited 0 and reported 12/12 expected synthetic key outcomes. The follow-up
output was retained in `/tmp/omp2-skills-evidence-check.json`, not substituted
for the original research raw measurement. This checks the existing research
model, not skill execution or native-verifier correctness.

`git diff --check` and staged whitespace validation passed. Changed-path review
is limited to `.claude/{agents,resources,docs,skills}`, the referenced upstream
`.claude/TESTING.md` playbook, and the research execution
plan/index/validation note. Existing `.claude/settings.json` is unchanged.

## Review and limitations

A fresh-context read-only reviewer received the plan and source reading list,
not the producer's conversation. It checked current `@judge` selection versus
first-word acceptance, checker contracts, missing-evidence handling, snapshot
applicability, work ownership, branch assumptions and native skill discovery.
It returned no blocking or major findings. This is a source review, not an
executed Goldfish workflow, independent model-family agreement or a runtime proof.
The coordinator applied the native `omp-evidence-review` instructions for final
scope and evidence checks.

`just`, `cargo`, `rustc` and `bun` remain unavailable. No native compile/tests,
live skill discovery, Claude plugin-variable substitution, persona registration,
fresh reviewer permission enforcement or paid-model workflow was tested. Those
checks are **not run**, not passing. They do not prevent preparing the next
implementation slice, but production compile/integration readiness must remain
unverified until its appropriate checks execute. No runner dependency is added.
