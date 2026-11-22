# Remote Execution Implementation Plan

**Date:** 2026-11-22
**Status:** In progress
**Area:** runtime — remote execution, ADR 0040/0047
**Source:** Research report `docs/research/remote-execution-gaps.md`

## Problem Statement

ADR 0040 and ADR 0047 define a comprehensive remote execution architecture. The core infrastructure is implemented but several gaps prevent full acceptance:

1. Two crash-window tests are missing (Gap 3)
2. No code enforces the A0, G3, G8 gates before composing remote backends
3. Live reattach verification is not yet possible (owner-gated)

## Solution

Three coordinated improvements:

1. **Add two crash-window tests** — Cover crash windows 1 and 4 from ADR 0040 section 3
2. **Enforce gates in code** — Refuse to compose remote backend unless gates are satisfied
3. **Prepare live reattach plan** — Document prerequisites for owner approval

## Delivery Steps

### ✓ Step 1: Add crash-window tests (ADR 0040 Gap 3)

- Added `execution_no_node_no_start_on_restart` — crash before `requested` commits, reopen, assert no job
- Added `execution_t13_crash_between_acceptance_and_commit_is_submission_unknown` — accept, drop board before poll, reopen, assert SubmissionUnknown
- All 30 execution tests pass

### ✓ Step 2: Enforce gates in code (ADR 0047 follow-up)

- Added `SV_EXEC_ACCEPTED` convar (default false) in `remote.rs`
- Added `AdwRemoteError::GatesNotSatisfied` variant
- Added gate check at start of `run_remote()` that refuses when gate not set
- Added test `remote_execution_gate_default_is_not_accepted`
- All 1236 tests pass

###   Step 3: Prepare live reattach verification plan

- Document prerequisites from ADR 0040 D6
- Identify what needs owner approval
- Create a checklist for when owner is ready
- PR #702 created: https://github.com/blyzer/oh-my-pi/pull/702

## Verification

- All `omp-agent` tests pass
- `cargo check -p omp-driver -p omp-agent -p omp-exec` compiles cleanly
- Gate enforcement test passes
