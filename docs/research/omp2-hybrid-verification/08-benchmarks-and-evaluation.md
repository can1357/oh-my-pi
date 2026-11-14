# 08 — Benchmarks and evaluation protocol

## What ran, and what did not

OMP2 source pin: `9cb6fd638918de77913a3e6c8fc42f9d5b3365bc`. This research does **not** establish a defect-recall, token-saving, latency, or cost advantage for the proposed verifier. There is no production hybrid verifier to compare yet. No paid model requests or remote reranking requests were made for this experiment.

Executed from the repository root on 2026-11-14:

```sh
python3 docs/research/omp2-hybrid-verification/experiments/evidence_keys.py > docs/research/omp2-hybrid-verification/experiments/evidence_keys.raw.json
just check-pkg omp-exec
```

The first command exited 0. The second exited **127**, `/bin/bash: line 1: just: command not found`. `command -v` and the experiment's `shutil.which` also found no `cargo`, `rustc`, or `bun`. Host: Linux x86_64, glibc 2.41; Python 3.12.14. Installing a full pinned Rust/CPython toolchain would not make an unimplemented hybrid engine benchmarkable, so this documentation-only PR does not install it or claim native tests passed. No macOS/Apple Silicon performance experiment was possible on this Linux host.

The dependency-free research model and full raw input/output are committed in [experiments/evidence_keys.py](experiments/evidence_keys.py) and [experiments/evidence_keys.raw.json](experiments/evidence_keys.raw.json). It exercises canonical JSON + SHA-256 on synthetic evidence manifests: **12/12 expected key outcomes**, consisting of ten misses for source/dependency/policy/compiler/test/environment/verifier/schema changes and two hits for identical input or map reordering. The recorded single-run interval was 357,839 ns. This interval is only a raw observation of a tiny Python model, not a useful OMP2 performance estimate. The test demonstrates the proposed key's sensitivity to explicitly supplied inputs; it cannot prove that the dependency closure is complete, discover hidden inputs, prove cache safety, or measure content-store performance. The source values are deliberately symbolic rather than production source digests.

## Existing reproducible verification infrastructure

Reuse repository recipes rather than build another test runner. At the pinned revision:

- [`justfile:218–228`](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/justfile#L218-L228) defines workspace/package checks.
- [`justfile:294–311`](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/justfile#L294-L311) defines the package test recipe; use its nextest and doctest coverage rather than raw `cargo test`.
- [`crates/exec/src/cargo_just.rs:56–89`](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/exec/src/cargo_just.rs#L56-L89) classifies commands and host needs. Seatbelt, PTY and host-timing requirements must remain meaningful during benchmarking.
- [`crates/e2e/tests/p8_baselines.rs`](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/e2e/tests/p8_baselines.rs) is existing recorder/schema validation, not a semantic verification benchmark. The workload harness and its 30-sample default are documented in `crates/e2e/README.md` under P8. Reuse its separation of non-gating timing from gating correctness; do not reinterpret P8's kernel throughput as defect recall.

On a provisioned host, first run `just setup-python`, `just check-pkg omp-exec`, `just test-pkg omp-exec`, `just test-pkg omp-journal` and the owning-crate tests for any implementation introduced later. Run relevant `just e2e-*` proofs after those pass. This is a future procedure, not an executed result here. The proposed evaluation harness below is follow-up work, not an existing command.

## Four controlled arms

| Arm | Implementation under test | Control needed |
|---|---|---|
| E0 | Current OMP2 tools and existing configured CI/check recipes | Record exactly which checks actually ran; no invented universal OMP2 gate |
| E1 | Original HouMinXi Forge at the SHA pinned in chapter 02 | Preserve original perspectives, reset and clean-cycle semantics; keep backend/model/prompt pins |
| E2 | Proposed native hybrid without historical-memory semantic reranking | Same native checks and same model allocation as E3; no reranker |
| E3 | Proposed native hybrid with semantic evidence reranking | Same candidates and budgets as E2 before ranking; freeze memory snapshot |

Run two comparisons: (1) natural configuration, measuring each architecture's full operational cost; (2) matched check/model/token budgets, isolating review selection quality. Report both. Original Forge and the proposed nine objectives are different algorithms: matching the number nine does not establish equivalent effort or coverage. Forge's actual LLM backend fan-out, partitioning and retries determine observed request counts. Keep E1 unchanged as a control until noninferiority has evidence.

E2/E3 cannot presently run: the engine, revision-bound evidence receipts, policy scheduler and shared reranking boundary described here are proposals. E1 was source-inspected, not executed with live model credentials. These are explicit blockers to a four-arm result, not zero-valued measurements. Mark unavailable cells `NOT RUN` and preserve errors.

## Corpus and ground truth

Create a versioned manifest of at least 60 Rust patches: ten each for compilation/type failures, semantic contract defects, security defects, concurrency/lifetime defects, regressions/integration defects, and deliberately clean changes. Sixty is a starting design size, not a power calculation. Use real historical fixes with the fix inverted where licensing and repository history permit, plus small seeded patches; disclose the proportion of synthetic cases. Keep every patch pinned to a base SHA and record a patch digest, changed symbols, risk class and expected required checks.

Representative patch families in this repository should exercise:

| Family | Example seed | Independent oracle |
|---|---|---|
| Compilation | Wrong enum variant or missing field across an API caller | Pinned package check fails for expected diagnostic |
| Behavioral semantics | Invert an approval or cache eligibility predicate | Hidden table-driven regression plus source adjudication |
| Security | Drop path confinement or permit a foreign approval answer | Isolated traversal/authority regression; never exercise against real secrets |
| Concurrency | Omit child cancellation, reverse lock order, lose terminal settlement | Bounded cancellation/replay test, schedule variation, timeout classified separately |
| Integration | Wrong tool revision or incomplete journal projection | Relevant joined-system proof and hidden reproduction |
| Clean | Equivalent refactor, comments, harmless formatting | Same oracle suite passes and two-person adjudication finds no defect |

Use separate worktrees and private state roots per arm/run. Seed only committed baselines; never revert user edits. Keep gold labels and hidden tests inaccessible to reviewers and memory retrieval. Two independent maintainers adjudicate findings blind to arm; resolve disagreement explicitly, reporting inter-rater agreement. Label a finding by root cause plus affected contract, not wording or location alone. Keep multiple valid defects per patch distinct; do not reward duplicate descriptions. Exclude equivalent mutants from the kill denominator only after recorded adjudication. Missing tools, uncompilable mutants, timeouts and surviving mutants need separate outcomes.

Split development/calibration and held-out evaluation by defect family and base revision to reduce leakage. Freeze requirements, source snapshot, memory, policy, toolchain, model identifier, sampling settings and prompts for a run. Do not tune reranker thresholds on held-out outcomes.

## Run protocol

1. Record pins and host fingerprint: OS/architecture, CPU, physical RAM, pressure/swap, compiler and nextest versions, embedded Python, lockfiles, enabled features, model endpoint/version, prompt/reranker digests and runtime sandbox policy. Never include API keys.
2. Apply the case patch in an isolated worktree. Materialize the same requirements, native checks and retrieval corpus for all applicable arms. Run hidden oracles outside the reviewers' context.
3. Randomize arm order with a recorded seed; use at least five independent review runs per semantic case initially. Increase samples based on a preregistered precision/power analysis, not until a favored result appears. Report nondeterminism even at temperature zero.
4. Run each arm with cancellation, wall-clock, model-request, token, CPU and memory budgets. A stopped or missing required check is INCONCLUSIVE. Capture all emitted tool invocations and results plus immutable review inputs/outputs in access-controlled artifacts.
5. Measure cold runs (empty verification/retrieval caches, with model-provider cache state reported as unknown unless observable), warm unchanged replay, then incremental replay. Incremental variants change a caller/callee, dependency lockfile, policy, compiler, fixture, feature flag and environment separately. Compare replay verdicts with a clean recomputation oracle.
6. Add cancellation, partial-write, malformed-reranker, missing-index and stale-snapshot fault injections. A cache hit must reproduce the same evidence inputs; gate output alone is insufficient. Check that denied provider access never becomes a clean semantic result.
7. Test repair separately: first freeze source and compare detection, then allow a bounded correction loop on identical cases. Record repairs introducing new defects, number of revisions, nonconvergence and escalation. Detection and repair efficacy are separate estimands.
8. Re-run selected cases with tool access and model budget matched. Ablate cross-encoder, MMR, historical recall, context truncation and incremental cache independently. Include evidence-required security cases whose decisive context lies beyond the first hunk.

No Docker/Podman or mandatory service is needed. Use the current execution architecture and isolated worktrees. Reranking can be an explicitly enabled local model or approved remote endpoint; record the choice rather than comparing different providers as if they were the same condition.

## Metrics and exact denominators

| Metric | Definition and collection |
|---|---|
| Defect recall | Confirmed unique gold defects detected / all gold defects, with per-class and security-stratum breakdown |
| Precision / false discovery | Confirmed unique findings / all adjudicated findings; false discovery = FP/(TP+FP) |
| False-positive rate | For a patch-level clean/defective classifier: clean patches incorrectly failed / all clean patches; do not call false discovery the same metric |
| Escaped regression | Gold defect whose required gate returned PASS; report separately from INCONCLUSIVE and from defects repaired later |
| Required-check completion | Required checks with valid terminal evidence / all required checks; include policy exemptions separately |
| Tokens | Provider-reported input/output and cached input; also serialize exact messages for byte counts and model-specific offline tokenization |
| Repeated-token volume | Tokenized identical evidence segments re-sent across requests; declare segment boundary/tokenizer, distinguish cached billing from wire/context repetition |
| Context per review | Distribution of total and source/evidence tokens at each request, including tool responses and hidden provider overhead if exposed |
| Cached input reuse | Provider cached input / eligible input where observable; unknown provider cache hits are unknown, never inferred from latency |
| Latency | End-to-end wall time, queue/model/native/reranker durations; p50/p95 and uncertainty, cold/warm separated |
| CPU/RAM | Child-inclusive CPU seconds, peak RSS, host memory pressure and swap; platform method recorded |
| Tools / LLM requests | Actual executions and retries; distinguish cache hits from executions, parallel fan-out from review objectives |
| Evidence cache | Hits/misses by verifier and invalidation cause; stale-hit count compared against full recomputation |
| Mutation score | Killed valid non-equivalent mutants / all valid non-equivalent mutants; compile failures, timeouts, exclusions listed |
| Cost per true defect | Actual billable model/reranker/native execution cost / confirmed unique defects; with zero TP report undefined, not zero |
| Retrieval quality | Evidence Recall@K, nDCG@K and required-context coverage, plus diversity and latency at equal candidates/token budgets |

Use a machine-readable per-run record with `run_id`, `case_id`, all pins, `arm`, random seed, source and dependency digests, required/completed checks, request/tool events, evidence identities, findings, adjudication, verdict, cancellation reason, measured resources and prices/date. Publish small redacted aggregate JSON/CSV; retain large raw source/provider artifacts outside the research PR with integrity digests and access policy. Preserve model refusal and inconclusive results in denominators. Report confidence intervals clustered by case, paired differences, and sensitivity to label disagreement.

## Replacement criteria and fewer-call hypothesis

Preregister a noninferiority margin with maintainers before evaluation; do not invent a safety threshold from these source audits. Require no new security-critical escaped regression in the held-out corpus, complete required deterministic checks, no stale-cache PASS under fault injection, and an upper confidence bound on recall loss below the agreed margin. A small corpus with zero escapes is not a proof of security. Report precision/cost/latency improvements only if measured, alongside uncertainty and class-level regressions.

Fewer LLM calls is a hypothesis to test: native failures should stop needless semantic work; objectives can share immutable evidence and a focused investigation can address several contracts. Multiple independent perspectives remain configurable for high risk. Compare curves of defect recall against **observed** calls and token cost, rather than declare a fixed two- or three-call replacement for Forge. Stop a proposed replacement if reduced calls omit security context or required investigation. An objective is satisfied by evidence coverage, not a request counter.

## Upstream PR #19210: inspected, unrelated to reranking

Inspected [PR #19210](https://github.com/can1357/oh-my-pi/pull/19210), head `9f52feb512ffa69b63f5c0a3ffdcc49fe4ee97ad`, base `6ec2b71cd7d80e18e1b6481f2e3d9c05f5f0c56c`, and its [changed-files API](https://api.github.com/repos/can1357/oh-my-pi/pulls/19210/files?per_page=100). Its sole changed file is `packages/tui/src/chrome/diff.ts` (15 additions, 10 deletions). The actual source hoists regexes ([lines 11–15](https://github.com/can1357/oh-my-pi/blob/9f52feb512ffa69b63f5c0a3ffdcc49fe4ee97ad/packages/tui/src/chrome/diff.ts#L11-L15)) and reuses `parsedLines` in `renderDiff` ([lines 182–248](https://github.com/can1357/oh-my-pi/blob/9f52feb512ffa69b63f5c0a3ffdcc49fe4ee97ad/packages/tui/src/chrome/diff.ts#L182-L248)); it does not implement CodeIR, semantic reranking or verification evidence caching. This source observation is implemented-and-source-verified for that upstream head, not evidence that its TypeScript implementation exists in Rust OMP2.

The PR author's reported measurements—53/53 byte-identical diffs, about 24% fewer objects and 29% less GC heap per pass—are author-reported evidence, **not reproduced here**. Their input session and profiling setup are not included in this research checkout, and Bun is unavailable. Their stated check/test failures must not be silently converted into a clean independent validation. The transferable lesson is to avoid repeated parsing while preserving exact observable output; it provides no measured token-saving estimate for a native verifier.
