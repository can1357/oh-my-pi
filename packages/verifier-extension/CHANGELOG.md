# @pk-nerdsaver-ai/verifier-extension

## [Unreleased]

### Added

- Added `/verify` to audit the current tracked workspace diff against operator-supplied acceptance criteria with the configured verifier model.


## [16.1.10] - 2026-06-22

### Added

- Added the LLM-as-verifier extension package with the `llm_as_verifier` tool and smoke-test commands.
- Added `groundTruthNote` tool parameter.
- Added regression tests in `src/__tests__/verifier.test.ts`.
- Added `subagent_orchestrator_plan` for deterministic Oh My Pi route planning.
- Reworked the `pk-subagent-orchestrator` skill around OMP-native task batching, recursion caps, and verifier tiers.

### Fixed

- Bundled Python runner now resolves its local `harness/` import regardless of invocation cwd.
- Swap-consistency calculation now asserts the expected (original, swapped) repetition pairing.
- Smoke-command example JSON is validated before use.
- Candidate and evidence files that are binary or exceed size limits are rejected before reading.
- Python backend now uses a 90-second outer timeout to avoid hanging on a stuck runner.
- Documented the `mean_pair_score` and winner tie-break behaviour in comments.
