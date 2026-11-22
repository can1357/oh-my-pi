# 04: Implement native OMP2 as Executor (ADR 0052 D5)

**What to build:** The child-kernel path (`run_child`) becomes a `NativeOmp` implementation behind an `Executor` trait covering Subagent and Execution JobKind shapes. A workflow can route a phase between native OMP2 and a delegated executor by changing assignment policy, not the workflow definition. The executor reports evidence, not verdicts.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Add `Executor` trait to `crates/contract/src/delegated/executor.rs` covering Subagent and Execution JobKind shapes:
  - `execute(assignment: WorkAssignment) -> impl Future<Output = WorkOutcome>`
  - `capabilities() -> Capabilities`
  - `cancel(turn: TurnId) -> impl Future<Output = Result<(), ExecutorError>>`
- [ ] Define `WorkAssignment` carrying: work item, phase, attempt, executor, workspace reference, acceptance criteria, budget, and policy
- [ ] Define `WorkOutcome` as: `Accepted(EvidenceBundle)`, `Rejected(VerificationFailure)`, `NeedsHuman(ApprovalRequest)`, `Cancelled`, or `Uncertain(RecoveryReference)`
- [ ] Implement `NativeOmp` as the `Executor` trait implementation for the child-kernel path (`run_child` in `crates/driver/src/adw/production.rs`)
- [ ] Connect `ExecutorRegistry` to one production path: task dispatch and an ADW phase
- [ ] Add unit tests:
  - NativeOmp executes a Subagent job and returns WorkOutcome
  - Capabilities are reported correctly
  - Cancellation works for in-flight turns
  - Executor reports evidence, not verdicts
- [ ] Run `just check-pkg omp-contract` and `just test-pkg omp-contract`
- [ ] Run `just check-pkg omp-driver` and `just test-pkg omp-driver`
- [ ] Update ADR 0052 status to mark D5 (native-as-executor) as implemented

**Public interface changes:** New `Executor` trait in `crates/contract/src/delegated/`. New `WorkAssignment` and `WorkOutcome` types. The job board API is unchanged — Tool and Process JobKind shapes stay in the job board as single-turn jobs.

**High-risk changes:** The `Executor` trait unifies the execution abstractions (job board, delegated executor, execution backend) into one contract. High blast radius (~8 files touched across `crates/contract/src/delegated/`, `crates/driver/src/delegated_host.rs`, and `crates/driver/src/adw/production.rs`).

**Native components reused:**
- `DelegatedExecutor` trait — extended to become the `Executor` trait
- `Capabilities` — executor capability declaration
- `DelegatedPolicy` — policy mediation
- `JobBoard` — Subagent and Execution JobKind shapes
- `run_child` — child-kernel path, becomes NativeOmp

**What must not be duplicated:**
- Do not create a new execution backend. Reuse `omp-exec` for remote execution.
- Do not create a new job primitive. The job board remains the authoritative job primitive (ADR 0010).
- Do not create a new lifecycle tracking system. Reuse `JobState` and `JobRef`.

**Verification evidence:**
- All unit tests pass
- `just check-pkg omp-contract` and `just test-pkg omp-contract` pass
- `just check-pkg omp-driver` and `just test-pkg omp-driver` pass
- ADR 0052 status updated
