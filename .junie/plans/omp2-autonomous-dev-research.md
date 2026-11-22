---
sessionId: session-261121-071840-zne9
---

# Implementation Specification: OMP2 Autonomous Development Architecture

**Date:** 2026-01-13
**Status:** Approved spec (grill decisions G1-G5)
**Area:** runtime — verification, execution, CI
**Source:** Research report, ADRs 0051-0053, grill session 2026-01-13

## Problem Statement

OMP2 has comprehensive autonomous development infrastructure, but three critical gaps prevent it from operating as a fully verified, executor-unified, CI-gated system:

1. **ADW phase acceptance ignores verification evidence.** Producing Agent phases are accepted on any answer (completion claim only). The verification module (`VerificationPolicy::evaluate()`) produces `GateVerdict` (Pass/Fail/Inconclusive) but ADW's `judge()` function never consults it. ADR 0053 D1-D4 specify this should use verification policy, but it is not implemented.

2. **Delegated executor is dead code for production work.** ADR 0052 D5 requires native OMP2 to be an executor behind the same interface as delegated executors, so a workflow can move a phase between native and delegated without edits. The delegated executor contract exists but is not wired to production. The child-kernel path (`run_child`) is not the `NativeOmp` implementation.

3. **P13 (remote execution) is not CI-gated.** The test exists at `crates/e2e/tests/p13_remote_exec.rs` but CI has no P13 job. This is the one gap identified in the research report and explicitly noted in AGENTS.md.

These gaps mean that OMP2 cannot claim independent verification (ADR 0053), cannot route phases between native and delegated executors (ADR 0052), and has an incomplete CI gate.

## Solution

Three coordinated improvements to existing OMP2 infrastructure:

1. **Replace ADW `judge()` with `VerificationPolicy::evaluate()`.** When a phase has verification evidence, evaluate it through the verification policy. For phases without verification, record the completion claim as evidence and apply the unverified-by-default rule (ADR 0053 O1). This makes verification first-class and eliminates the placeholder acceptance logic.

2. **Implement ADR 0052 D5: native OMP2 as executor.** Make the child-kernel path (`run_child`) the `NativeOmp` implementation behind the `Executor` trait. The Executor trait covers Subagent and Execution JobKind shapes only — Tool and Process stay in the job board since they are single-turn. Connect `ExecutorRegistry` and `run_delegated_turn` to one production path.

3. **Gate P13 in CI.** Add P13 to CI as a required check. Add the missing `e2e-p13` recipe to the justfile. Update CI workflow to include P13 in the Linux E2E job.

## User Stories

1. As a workflow author, I want producing Agent phases to be verified against deterministic checks so that a completion claim alone cannot pass work that fails its gates.

2. As a workflow author, I want unverified phases to be rejected by default so that I must explicitly declare `accept_on_claim` for cheap phases where verification is unnecessary.

3. As a workflow author, I want to route a phase between native OMP2 and a delegated executor by changing assignment policy, not the workflow definition.

4. As a workflow author, I want the ADW engine to retry a rejected phase up to a configured budget so that transient failures do not halt the run.

5. As a CI operator, I want P13 (remote execution) to be gated in CI so that regressions in remote execution are caught before merge.

6. As a recovery operator, I want to resume a crashed ADW run and have uncertain phases reconciled via idempotency keys so that external effects are not duplicated.

7. As a verification engineer, I want verification evidence to be persisted in the journal and blob CAS so that acceptance decisions are auditable and replayable.

8. As a subagent supervisor, I want verification subagents to run with read-only authority and reduced tool rosters so that they cannot mutate the workspace while judging it.

9. As a workflow author, I want the judge to run in a fresh context with no producer transcript so that the verdict is independent of the producer's conversation.

10. As a workflow author, I want the verdict to record independence (whether the judge route differs from the producer route) so that I can distinguish true independent reviews from same-route reviews.

11. As a CI operator, I want the verification policy to reject a phase even when the judge says Accept if a required gate fails, so that deterministic checks cannot be overruled by a model.

12. As a recovery operator, I want a phase with a dispatch but no settle to be classified as Uncertain on resume, so that I can reconcile external effects before continuing.

13. As a workflow author, I want the executor to report evidence (not verdicts) so that ADW alone decides acceptance from evidence, gates, and an independent verdict.

14. As a verification engineer, I want the verification policy to retain every declared check result (including optional failures) so that the full assessment is visible even on a passing verdict.

15. As a workflow author, I want to declare acceptance criteria per phase so that the judge can tie each criterion to the evidence for it.

16. As a CI operator, I want the justfile to include an `e2e-p13` recipe so that I can run P13 locally before pushing.

## Implementation Decisions

### Module: `crates/driver/src/adw/production.rs` (Verification Integration)

**Current state:** `judge()` (line 757-771) accepts all non-Review phases on any answer. `judge_delegated()` (line 773-783) adds an empty-answer rejection for delegated executors.

**Changes:**
- Replace `judge()` with a new `judge_with_verification()` function that:
  - For phases with verification evidence: calls `VerificationPolicy::evaluate()` and maps `GateVerdict::Pass` to accepted, `GateVerdict::Fail` to rejected, `GateVerdict::Inconclusive` to rejected with feedback.
  - For phases without verification evidence: records the completion claim as evidence and applies the unverified-by-default rule (reject unless `accept_on_claim` is declared).
  - For Review phases: preserves the first-word parse (ACCEPT/REJECT) but also consults verification evidence if present.
- Add `accept_on_claim` field to `PhaseSpec` (TOML: `accept_on_claim = true`). When set, a phase without verification evidence is accepted on its completion claim.
- Add `Verdict` struct: `{ decision: VerdictDecision, feedback: Str, criteria: Arc<[CriterionAssessment]>, independent: bool }` where `VerdictDecision` is `Accept`, `Reject`, or `NeedsHuman`.
- Record the verdict in the `adw.phase.settle` journal entry per ADR 0051 D3.

**Native components reused:**
- `VerificationPolicy` (policy.rs) — deterministic evaluation of check observations.
- `GateVerdict` (policy.rs) — Pass/Fail/Inconclusive reducer.
- `CheckObservation` (policy.rs) — host-observed results with evidence digests.
- `RunLog` (runlog.rs) — journal-based run persistence for settle entries.
- `EvidenceBundle` (evidence.rs) — retained evidence with CAS integrity.

**What must not be duplicated:**
- Do not create a new acceptance logic layer. The verification policy is the sole gate authority.
- Do not create a new verdict storage. Use the existing journal settle entry.
- Do not create a new evidence store. Use the existing blob CAS and journal.

### Module: `crates/contract/src/delegated/` (Executor Contract)

**Current state:** `DelegatedExecutor` and `DelegatedSession` traits exist. `ExecutorRegistry` and `run_delegated_turn` are defined in `delegated_host.rs` but have no production callers outside that file.

**Changes:**
- Add `Executor` trait covering Subagent and Execution JobKind shapes:
  - `execute(assignment: WorkAssignment) -> impl Future<Output = WorkOutcome>`
  - `capabilities() -> Capabilities`
  - `cancel(turn: TurnId) -> impl Future<Output = Result<(), ExecutorError>>`
- Implement `NativeOmp` as the `Executor` trait implementation for the child-kernel path (`run_child`).
- Connect `ExecutorRegistry` to one production path: task dispatch and an ADW phase.
- `WorkAssignment` carries: work item, phase, attempt, executor, workspace reference, acceptance criteria, budget, and policy.
- `WorkOutcome` is: `Accepted(EvidenceBundle)`, `Rejected(VerificationFailure)`, `NeedsHuman(ApprovalRequest)`, `Cancelled`, or `Uncertain(RecoveryReference)`.

**Native components reused:**
- `DelegatedExecutor` trait (executor.rs) — extended to become the `Executor` trait.
- `Capabilities` (capability.rs) — executor capability declaration.
- `DelegatedPolicy` (policy.rs) — policy mediation.
- `JobBoard` (jobs.rs) — Subagent and Execution JobKind shapes.
- `run_child` (adw/mod.rs) — child-kernel path, becomes NativeOmp.

**What must not be duplicated:**
- Do not create a new execution backend. Reuse `omp-exec` for remote execution.
- Do not create a new job primitive. The job board remains the authoritative job primitive (ADR 0010).
- Do not create a new lifecycle tracking system. Reuse `JobState` and `JobRef`.

### Module: `crates/driver/src/adw/mod.rs` (Retry Policy)

**Current state:** ADW has resume from journal but no retry policy. On rejection, the phase is marked rejected and the workflow continues.

**Changes:**
- Add `RetryPolicy` to the ADW engine as a phase-level configuration:
  - `max_attempts: usize` — maximum retry attempts per phase.
  - `redispatch_on_reject: bool` — whether to redispatch on rejection (default: true).
  - `budget: Budget` — resource budget for retries (carved from parent budget per ADR 0052 D10).
- On rejection, ADW redispatches the phase up to the budget. A `redispatch` repeats an attempt without spending the retry budget (per ADR 0051 S6).
- The retry policy is recorded in the `adw.run.start` journal entry.

**Native components reused:**
- `Run` states (adw/run.rs) — additive states: Failed, Uncertain, NeedsHuman.
- `redispatch` (adw/run.rs) — repeats an attempt without spending budget.
- `RunLog` (runlog.rs) — journal-based persistence for retry state.
- `ApprovalBook` (jobs.rs) — approval integration for retry decisions.

**What must not be duplicated:**
- Do not create a new retry infrastructure. ADW owns retry per G5.
- Do not create a new budget system. Reuse hierarchical budgets from ADR 0052 D10.

### Module: `.github/workflows/ci.yml` and `justfile` (P13 CI Gate)

**Current state:** P13 test exists at `crates/e2e/tests/p13_remote_exec.rs`. CI has no P13 job. `just e2e` does not include P13.

**Changes:**
- Add `e2e-p13` recipe to justfile: `cargo nextest run -p omp-e2e --test p13_remote_exec --locked`.
- Add P13 to the `just e2e` recipe: `e2e: e2e-build e2e-core e2e-p7 e2e-p13 e2e-p9 ...`.
- Add P13 to CI workflow as a required check in the Linux E2E job.
- Update AGENTS.md to remove the P13 gap note.

**Native components reused:**
- P13 test (p13_remote_exec.rs) — existing test, no changes needed.
- CI workflow (ci.yml) — existing job structure, P13 added to Linux E2E job.
- justfile — existing e2e recipes, P13 added.

**What must not be duplicated:**
- Do not create a new CI job. P13 runs in the existing Linux E2E job.
- Do not create a new test. The P13 test exists.

## Testing Decisions

### Testing Philosophy

Test at existing public interfaces. Prefer tests that verify observable behavior over implementation details. Use the highest seam possible — the ideal number of new test seams is zero.

### Modules to Test

1. **`crates/driver/src/adw/production.rs`** — `judge_with_verification()` behavior:
   - A failed required gate rejects a phase even when the judge says Accept.
   - A phase without verification evidence is Unverified and rejected under unverified-by-default.
   - A phase with `accept_on_claim = true` is accepted on its completion claim.
   - A Review phase still uses first-word parse but also consults verification evidence.
   - The verdict records independence (judge route vs producer route).
   - An unparseable judge answer rejects.
   - The settle entry names judge route, context digest, and evidence digest.

2. **`crates/contract/src/delegated/executor.rs`** — `Executor` trait:
   - NativeOmp implementation executes a Subagent job and returns WorkOutcome.
   - Capabilities are reported correctly.
   - Cancellation works for in-flight turns.
   - The executor reports evidence, not verdicts.

3. **`crates/driver/src/adw/mod.rs`** — Retry policy:
   - A rejected phase is redispatched up to the budget.
   - A phase that exhausts its budget is marked Failed.
   - A `redispatch` does not spend the retry budget.
   - The retry state is recorded in the journal.

4. **`crates/e2e/tests/p13_remote_exec.rs`** — P13 CI gate:
   - The test passes in CI (Linux E2E job).
   - The `just e2e-p13` recipe runs the test locally.

### Prior Art for Tests

- `crates/driver/tests/verification_policy.rs` — public contract tests for VerificationPolicy.
- `crates/driver/src/adw/production.rs` — inline tests for judge and verification.
- `crates/e2e/tests/p1_doc_race.rs` through `p14_session_attach.rs` — E2E proofs with bounded waits and RAII-owned processes.
- `crates/contract/src/delegated/mock.rs` — mock backend for delegated executor tests.

### Test Seams

- **Verification integration:** Test at `judge_with_verification()` in `production.rs`. Existing test seam: inline tests in the same module.
- **Executor contract:** Test at `Executor` trait in `delegated/executor.rs`. Existing test seam: `mock.rs` provides a mock backend.
- **Retry policy:** Test at `Run` states in `adw/run.rs`. Existing test seam: replay tests in `adw/replay.rs`.
- **P13 CI gate:** Test at the E2E proof level. Existing test seam: `p13_remote_exec.rs`.

## Out of Scope

- **Creating a new workflow engine.** ADW is the sole workflow engine (ADR 0051 D1).
- **Creating a parallel state store.** Journal is the single source of truth (ADR 0051 D3).
- **Reopening ADRs without new evidence.** D1-D8 locked decisions remain.
- **TUI rendering changes.** Not part of autonomous development architecture.
- **Provider transport changes.** Catalog data, not verification.
- **LLM-based semantic verification as core.** EGM pattern is a first-party review recipe, not core (ADR 0053 D7).
- **Cross-workflow evidence.** Evidence is scoped to one run per ADR 0051.
- **Delegated verification.** ADR 0052 D1, D6 require the router first.
- **Continuous verification.** Verification runs at phase boundaries per G1+G2.
- **Mnemopi (SQLite) backend.** Deferred; journal file is the default store.
- **Concurrent driver (roadmap P3).** Deferred; phases run sequentially.
- **MicroVM execution backend.** Deferred; ADR 0052 D8 implementation guide.
- **Router implementation.** Deferred; ADR 0052 D1-D3 require it but it is not in scope.
- **Tool and Process JobKind shapes in Executor trait.** They stay in the job board as single-turn jobs.
- **Breaking changes without authorization.** All changes preserve backward compatibility except the unverified-by-default rule, which is explicitly authorized by G2.

## Further Notes

### Concurrency and Failure Scenarios

- **Phase-level concurrency:** Deferred until the concurrent driver (roadmap P3). Phases run sequentially; a `NeedsHuman` phase halts the whole run.
- **Crash recovery:** A phase with a dispatch but no settle is Uncertain on resume. External effects are reconciled via idempotency keys (ADR 0051 D5).
- **Cancellation:** A cancelled phase appends `adw.run.halt` with reason `cancelled`. On resume, an effectful phase with a dispatch and no settle is Uncertain.
- **Budget exhaustion:** A phase that exhausts its retry budget is marked Failed. The run continues if the phase has no dependents.

### Deterministic Verification Requirements

- **Gate authority:** `VerificationPolicy::evaluate()` is the sole gate authority. No model can overrule a failed required check (ADR 0053 D1).
- **Evidence retention:** Every declared check result is retained, including optional failures (ADR 0053 D6).
- **Scope checking:** Verification scope (inputs and policy digests) is checked before outcome. Stale results are Inconclusive.
- **Evidence integrity:** Evidence digests identify bytes, not producer trust. The policy does not inspect bytes or verify tool coverage.

### Optional LLM Reasoning Cases

- **Judge verdict:** The judge (independent model) reads evidence and decides Accept, Reject, or NeedsHuman. This is the only LLM-based reasoning in the verification path.
- **Advisor notes:** The Advisor Director provides advice (nit, concern, blocker) but never accepts, rejects, or blocks a phase.
- **EGM review recipe:** A review-loop recipe ships as a workflow extension with parallel fresh-context reviewers. Core owns the role, verdict contract, and independence checks; the personas and loop are data an extension supplies.

### Persistence and Recovery Behavior

- **Run journal:** One `.oms` file per run under `<data dir>/adw/runs/<run-id>.oms` (ADR 0051 S2).
- **Dispatch before start:** A dispatch entry is committed before the phase starts. A settle entry is committed before the result is applied (ADR 0051 D4).
- **Recovery:** On resume, uncertain phases are classified and reconciled. A phase with no external effect is re-dispatched as the same attempt number with a `recovered` marker (ADR 0051 D5).
- **Lease:** On a single host, the lease is an advisory OS file lock on the run journal plus a generation entry (ADR 0051 D6).

### Interface and Compatibility Requirements

- **Backward compatibility:** The `judge()` function is replaced by `judge_with_verification()`. Existing workflows that rely on completion-claim acceptance must declare `accept_on_claim = true` for producing Agent phases. This is a breaking change authorized by G2.
- **Executor trait:** The `Executor` trait covers Subagent and Execution JobKind shapes. Tool and Process stay in the job board. The public API of the job board is unchanged.
- **Verification policy:** The `VerificationPolicy` API is unchanged. New callers use `judge_with_verification()` which internally calls `evaluate()`.
- **Journal kinds:** The `adw.*` journal kinds are registered via the journal vocabulary constructor (ADR 0051 S1). Session journals keep their closed set.

### Measurable Verification Methods

| Requirement | Verification Method |
|-------------|-------------------|
| Failed gate rejects phase | Unit test: `judge_with_verification()` with failing gate returns rejected PhaseResult |
| Unverified-by-default | Unit test: phase without evidence is rejected unless `accept_on_claim` |
| Verdict records independence | Unit test: verdict `independent` field is true when judge route differs from producer |
| Executor trait works | Unit test: NativeOmp executes Subagent job and returns WorkOutcome |
| Retry policy works | Unit test: rejected phase redispatched up to budget; budget exhaustion marks Failed |
| P13 passes in CI | CI job: P13 runs in Linux E2E job and passes |
| Evidence retained | Unit test: `GateAssessment.checks` contains all declared checks including optional failures |
| Recovery works | E2E test: kill at dispatch/settle boundary; resume reaches same terminal state |
| Journal integrity | Unit test: replay from journal gives identical Run state |
| No duplicate effects | E2E test: phase with external effect is killed after effect but before settle; recovery does not duplicate |

### Classification of Changes

| Change | Classification | Reason |
|--------|---------------|--------|
| Replace judge() with verification policy | Native enhancement | Extends existing ADW production host in `crates/driver` |
| Unverified-by-default rule | Native enhancement | Adds `accept_on_claim` to PhaseSpec in `crates/driver` |
| Verdict struct | Native enhancement | New type in `crates/driver` for structured verdicts |
| Executor trait | Native enhancement | Extends `crates/contract/src/delegated/` with unified trait |
| NativeOmp implementation | Native enhancement | Makes `run_child` the NativeOmp Executor implementation |
| Retry policy | Native enhancement | Adds retry config to ADW engine in `crates/driver` |
| P13 CI gate | Documentation/configuration only | Adds P13 to CI workflow and justfile |
| ADR status updates | Documentation/configuration only | Updates ADR 0051-0053 status sections |

---

## Tickets

The approved spec has been decomposed into 4 tickets published to `.scratch/omp2-autonomous-dev/issues/`.

GitHub Issues are disabled for this repository, so tickets are stored as local files per the to-tickets skill fallback.

### Dependency graph

```
01-p13-ci-gate          (no blockers) ← initially runnable
02-accept-on-claim      (no blockers) ← initially runnable
    ↓
03-verification-judge   (blocked by 02)
04-native-as-executor   (no blockers) ← initially runnable
```

**Initially runnable frontier:** 01, 02, 04 (3 tickets can start in parallel).

### Ticket summary

| # | Title | Blocked by | Scope |
|---|-------|------------|-------|
| 01 | Gate P13 in CI | None | justfile, CI workflow, AGENTS.md |
| 02 | Add accept_on_claim to PhaseSpec | None | PhaseSpec schema, TOML parsing |
| 03 | Replace ADW judge() with verification policy | 02 | production.rs, Verdict, VerificationPolicy |
| 04 | Implement native OMP2 as Executor | None | Executor trait, NativeOmp, ExecutorRegistry |

### Note on retry policy (Stage 3)

The retry policy is **already implemented** in the ADW domain:
- `OnReject::Retry` causes `Run::reject()` to return `Outcome::Retried`
- `max_attempts` budget controls retry depth
- `interrupt()` resets a running phase to pending without spending attempt
- The host handles `Outcome::Retried` in the run loop

No ticket is needed for retry policy.

## Delivery Steps

### ✓ Step 1: Gate P13 in CI (Ticket 01)

- Add `e2e-p13` recipe to justfile
- Add P13 to `just e2e` recipe
- Add P13 to CI workflow Linux E2E job
- Update AGENTS.md to remove P13 gap note

### ✓ Step 2: Add accept_on_claim to PhaseSpec (Ticket 02)

- Add `accept_on_claim` field to `PhaseSpec`
- Update TOML parsing
- Update all callers

### ✓ Step 3: Replace ADW judge() with verification policy (Ticket 03)

- Blocked by Step 2
- Replace `judge()` with `judge_with_verification()`
- Wire `VerificationPolicy::evaluate()` into the judge path
- Add `Verdict` struct
- Unverified-by-default rule

### ✓ Step 4: Implement native OMP2 as Executor (Ticket 04)

- Add `Executor` trait to `crates/contract/src/delegated/`
- Implement `NativeOmp` for the child-kernel path
- Connect `ExecutorRegistry` to one production path

### ✓ Step 5: Wire VerificationPolicy into judge_with_verification()

- Connect `VerificationPolicy::evaluate()` to `judge_with_verification()` so phases with verification evidence are evaluated against gates
- Add `CheckObservation` collection from verification runner to ADW dispatch path
- Map `GateVerdict` to `PhaseResult` in `judge_with_verification()`
- Persist `Verdict` in journal settle entries
- Fix pre-existing warnings in omp-driver (unused imports, dead code, missing docs)

### ✓ Step 6: Evidence collection bridge

- Add `observations` field to `NativeVerificationReport` so raw observations are available
- Add `verification_observations` to `ProductionAdwHost` to carry observations between phases
- Wire observations from verification phase to `judge_with_verification()` for subsequent phases
- Add test for evidence flow from verification phase to Agent phase judge

### ✓ Step 7: Verdict persistence in journal settle entries

- Add `verdict` and `independent` fields to `PhaseSettle` in `crates/journal/src/runlog.rs`
- Add `verdict` and `independent` fields to `PhaseResult` in `crates/driver/src/adw/mod.rs`
- Wire verdict from `judge_with_verification()` through `PhaseResult` to settle entries
- Update all `PhaseResult` and `PhaseSettle` constructions across the codebase
- All 55 ADW tests and 74 journal tests pass

### ✓ Step 8: Wire Native executor to run_child (ADR 0052 D5)

- Route executor id "native" through `run_child` in `ProductionAdwHost::dispatch()`
- Add `NativeOmp` struct as standalone executor for future use
- Update `run_delegated_turn` comment to document the native executor path
- All 55 ADW tests pass

### ✓ Step 9: Construct VerificationPolicy and wire to judge

- Add `policy: Option<VerificationPolicy>` to `NativeVerificationReport`
- Store the policy in the report at the end of `verify()` in runner.rs
- Add `verification_policy` field to `ProductionAdwHost`
- Store the policy from verification report alongside observations
- Pass the policy to `judge_with_verification()` instead of `None`

### ✓ Step 10: Check hosted macOS runner availability before dispatching

- Add `hosted_available()` method to macOS CI controller that scans queued workflow runs
- Modify `execute()` to check availability before dispatching to hosted
- Relax self-hosted pool validation to allow generation 0 (direct dispatch)
- Add 7 tests for the availability check and execute() pool selection
- PR #701 merged: https://github.com/blyzer/oh-my-pi/pull/701

### ✓ Step 11: Fix CI ruleset and merge all PRs

- Fixed live GitHub ruleset check name mismatch (`"Acceptance proofs P9, P10..."` → `"Acceptance proofs P9-P14..."`)
- Rebased and merged all 5 PRs: #696 (verdict persistence), #697 (native executor), #698 (VerificationPolicy), #700 (macOS fallback fix), #701 (hosted availability check)
- All delivery steps complete, `omp2` branch is up to date