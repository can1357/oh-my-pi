# Implementation roadmap

This research does not implement the engine. Relative complexity estimates below
are engineering judgments: **S** is a bounded local contract/adapter, **M** spans
several owning modules, **L** changes cross-subsystem behavior. They are not
elapsed-time commitments. Each slice needs an independently reviewable PR;
preserve default behavior until a profile is explicitly enabled.

## P0: deterministic receipt before autonomy

| Task and dependency | Concrete owning files / API boundary | Acceptance and tests | Estimate / risk |
|---|---|---|---|
| P0.1 Required inventory and verdict, no dependency | Extend `crates/adw/src/workflow.rs`, `run.rs` only for general domain concepts; proposed `crates/driver/src/verification/{mod,policy}.rs` integrates `VerificationObjective`, `VerificationGate` | Table-driven PASS/FAIL/INCONCLUSIVE tests; missing, empty, neutral, duplicate, stale and cancelled required results cannot pass; intentional non-applicability recorded; existing ADW tests unchanged | M; scope creep into scheduler |
| P0.2 Canonical snapshot/action keys, P0.1 | Proposed `driver/src/verification/snapshot.rs`; reuse `vcs/src/lib.rs`, `exec/src/request.rs`, `kb/src/store.rs` rather than new capture service | Whole-input manifest includes dirty/untracked relevant inputs, dependency/feature/toolchain/runner/policy/test identity; deterministic encoding; every sensitivity case and source-race test changes key; full recomputation agrees | M; hidden inputs and source races |
| P0.3 Durable evidence adapter, P0.1–2 | Proposed `driver/src/verification/evidence.rs`; `journal/src/runlog.rs`, `kind.rs`, `gc.rs`, `blob.rs` if vocabulary/retention needs extension; `session` Component projection | `EvidenceStore`, `VerificationReceipt`; finalize blobs then journal complete root inventory; crash/replay/corruption/missing child/GC tests; no second session database | M; GC reachability and version migration |
| P0.4 Existing checks to receipts, P0.1–3 | `driver/src/cleanse/checkers.rs` and parsers, `driver/src/adw/production.rs`, `exec/src/{request,result,report}.rs`; proposed native adapter | Run selected repository `just` check/test recipes via existing authority; retain raw logs and test inventory; missing executable, zero selected tests, truncation, nonzero exit and host proof skips are explicit; exercise real driver/envd path | M; discovery completeness and test selection |
| P0.5 Opt-in Quick profile, P0.1–4 | `driver/src/adw/{mod,definition,production}.rs`; app adapter only for selecting/displaying profile; existing approval seam | Receipt source identity rechecked before authorized commit; changed source/policy after checks blocks; default agent behavior unchanged; integration test one valid and one failing revision plus cancellation | M; mutation/commit TOCTOU |
| P0.6 Evaluation scaffolding, independent | Research-derived harness in existing `crates/e2e` or a justified benchmark tool, pinned external Forge adapter outside production dependency graph | Frozen small Rust corpus with hidden ground truth; machine-readable events and NOT RUN prerequisites; deterministic and semantic counts separate; no paid calls in default CI | M; leakage and invalid baselines |

**First implementation slice:** P0.1–4 restricted to A1 and an explicitly selected
C1 package test recipe, whole-input invalidation, no model, no reranker and no
automatic repair. Expose an opt-in driver verification command/phase returning
a journal-rooted receipt. A missing check must block even if every received
check is green. This is a useful reviewable milestone without claiming nine-objective
coverage or changing current commit behavior.

Quick wins include preserving raw check outputs, explicit completion inventory,
source-bound receipts and revealing unsupported tools. Whole-program impact,
semantic review quality and granular cache reuse are substantial architectural
work, not prerequisites to a first deterministic receipt.

## P1: conservative impact and focused semantic investigation

| Task and dependency | Files / candidate boundary | Acceptance and tests | Estimate / risk |
|---|---|---|---|
| P1.1 Hunk/symbol/impact manifest, P0.2 | `vcs/src/{lib,types}.rs`, `ast/src/{symbol,summary}.rs`, `kb/src/{store,graph}.rs`, `tools/src/lsp/`; proposed `driver/src/verification/impact.rs` implementing `ChangeImpactAnalyzer` | Base/head rename/deletion mapping; SCIP versus syntax provenance; stale/missing producer, cfg/macro/FFI uncertainty widens to crate/workspace; known caller/callee mutations invalidate expected consumers | L; unsound pruning is worse than coarse reruns |
| P1.2 Focused reviewer protocol, P0.3–4 + P1.1 | `driver/src/headless/kernel.rs`, `driver/src/subagent/spawn.rs`, `tool/src/restrictions.rs`, `tools/src/review.rs`, proposed verification review module | `SemanticReviewer` receives compact manifest and bounded evidence reads; structured claims cite revision and objective; denied writes/network, malicious source/log/memory and missing mandatory context tests; malformed output stays inconclusive | L; prompt injection and apparent certainty |
| P1.3 Finding validation, P1.2 | Proposed `driver/src/verification/validate.rs`; reuse source/LSP/check execution and `envd/src/security_scan.rs` lineage without treating `validate` as truth | `FindingValidator` produces confirmed/falsified/unresolved; source-excerpt matching and reproduction captured; passing unrelated tests cannot dismiss security/concurrency claim; stale anchor rejected | L; executable evidence rarely proves absence |
| P1.4 Standard profile, P1.1–3 | `contract/src/director.rs` implementation via existing Director surface; driver registration, `session` Component and ADW transitions | Enforce objective-specific coverage and total budgets; shared evidence across A3/B3; bounded repair, oscillation, superseded consumer, effects-unknown and cancellation integration tests | L; do not insert feature state into kernel loop |
| P1.5 Incremental action reuse, P1.1 + P0.3 | Proposed evidence adapter index over existing CAS; native KB graph queries; no new mandatory search backend | Compare warm/incremental verdict with full rerun on dependency/compiler/policy/fixture/feature/environment changes; no stale PASS; incomplete closure forces full invalidation | L; cross-language/build-script hidden dependencies |
| P1.6 Evaluation decision gate, P0.6 + P1.4 | Existing e2e/benchmark infrastructure and external pinned Forge process adapter | Run four-arm protocol where implemented; blind adjudication and preregistered noninferiority/security strata; publish raw receipts and failures; decide policies by effectiveness, not nine labels or lower tokens alone | L; model variability and inadequate statistical power |

No new framework is justified for VCS, AST, SCIP, lexical search, execution,
workflow orchestration or journaling. An optional external static-analysis tool
can be a provider, with declared installation/version/posture and unavailable
status. Do not add dependencies in advance of a concrete approved adapter.

## P2: targeted reranking, adversarial campaigns and Strict autonomy

| Task and dependency | Files / candidate boundary | Acceptance and tests | Estimate / risk |
|---|---|---|---|
| P2.1 Shared optional ranking, P1.2 + labeled retrieval evaluation | `memory/src/{recall,runtime,aux_lane,config}.rs` as verified in chapter 03; proposed shared provider boundary integrated by driver; existing `omp-ai`/native ML conventions | Off by default; actual production caller and candidate identity; timeout/malformed/nonfinite/partial-score fallback; model/config/tokenization cache scope; mandatory context retained; evidence Recall@K improves on held-out set without unsafe omission | L; current aux interface is not working CE recall wiring |
| P2.2 Optional mutation/property/fuzz, P0.4 + P1.1 | Existing exec adapters and isolated worktree ownership; proposed native verifier providers | Pinned tool/operator/seed/corpus, compile-invalid/equivalent/timeout/survivor distinctions; pre/post source capture unchanged; cancellation cleans child worktrees; bounded campaign receipts | M/L; tool availability and runaway resources |
| P2.3 Strict multi-perspective policy, P1.4–6 + P2.2 | Driver Director/ADW policy and reviewer provider registry, existing approval and sandbox contracts | Independent initial findings, conflict escalation, per-risk configurable model budgets; missing enforcement or critical uncertainty blocks; no narrative memory grants gate status | L; correlated reviewer errors and expensive tails |
| P2.4 Risk-adaptive closed-loop rollout, all prior evidence | Existing ADW host, subagent workpools, `agent/src/jobs.rs`, envd authority, verification receipt projector | Shadow mode versus operator decisions first; bounded opt-in repairs then autonomous authorized commits; no source-race/stale-hit passes under fault injection; human escalation includes minimal reproducible evidence | L; nonconvergence and authority boundaries |

Dependency order is intentional: receipts precede incremental reuse, validated
impact precedes narrowed checks, semantic hypothesis validation precedes automated
repair, and measured retrieval benefit precedes making reranking part of a
profile. Reranking need not block the native verification work.

## Required validation for implementation PRs

Follow repository `just` recipes, focused owning-crate checks/tests, then relevant
joined proofs. Examples include cancellation, crash/replay, prefix stability,
worktree isolation, approval routing and tool-source routing. Confirm exact proof
names in current `crates/e2e/tests` when implementing. Do not interpret a filtered
run with zero tests as success. Host-specific sandbox proofs require that host;
unsupported execution is not a passing test. Production implementations need
tests at real driver/envd/session seams as well as pure-domain unit tests.

This documentation PR independently validates source references and executable
research models only. It cannot substitute those for future integration proofs.
