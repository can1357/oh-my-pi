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

### ✓ Step 3: Prepare live reattach verification plan (ADR 0040 Gap 2, D6)

- Created `docs/audits/live-reattach-verification-plan.md` with test procedure and success criteria
- Set `sv_exec_accepted = true`, `sv_exec_agent_runs = true`, `sv_exec_remote_endpoint` in operator config
- Added `sv_sandbox_allow_domains` with both required domains: `www.googleapis.com` (OAuth auth) and `app.buildbuddy.io` (REAPI gRPC)
- Owner approved BuildBuddy source upload and image hosting (D6 prerequisites)
- BuildBuddy connectivity verified: `just remote-test-pkg omp-exec-reapi` passed
- PR #702 merged: https://github.com/blyzer/oh-my-pi/pull/702

### ✓ Step 4: Document BuildBuddy-specific convars

- Updated `docs/audits/live-reattach-verification-plan.md` with all required convars:
  - `sv_exec_remote_credential_header "x-buildbuddy-api-key"` — gRPC metadata header
  - `sv_exec_remote_arch_spelling "short"` — BuildBuddy arch spelling
  - `sv_exec_remote_fixed_properties "workload-isolation-type=oci"` — platform property
  - `sv_exec_remote_profile "operator"` — BuildBuddy profile
- These convars exist in `exec_composer.rs` but default to generic REAPI values
- Without them, `remote_build` fails silently (6 failed jobs confirmed)
- Direct `bb remote` via `scripts/remote-verify.sh` succeeds (exit 0, 16s)

### ✓ Step 5: Create BuildBuddy extension (ADR 0040 Dimension 1)

- Created `extensions/buildbuddy/` with profile data and stub delegate operations
- `omp_buildbuddy.profile` — REAPI profile data (credential header, arch spelling, fixed properties)
- `omp_buildbuddy.devices` — four delegate operations (describe, start, poll, cancel) as stubs
- `omp_buildbuddy.errors` — `BuildBuddyUnavailable` error type
- Updated `extensions/README.md` to include BuildBuddy extension
- Created `docs/audits/test-reapi-native-prompt.md` — interactive test prompt for native REAPI crate

### ✓ Step 6: Create test prompts for native REAPI and extension

- Created `docs/audits/test-reapi-native-prompt.md` — test prompt for native REAPI gRPC crate
- Created `docs/audits/test-buildbuddy-extension-prompt.md` — test prompt for BuildBuddy extension
- Both prompts are ready for user to copy-paste into OMP chat sessions

### ✓ Step 7: Add LIVE_REAPI_TESTS=1 path for live gRPC tests

- Added `LIVE_REAPI_TESTS=1` env var support to `scripts/remote-verify-runner.sh` — conditionally preserves `BUILDBUDDY_API_KEY` on the runner
- Added `LIVE_REAPI_TESTS` env var passthrough in `scripts/remote-verify.sh`
- Added `just remote-live-reapi` recipe that sets `LIVE_REAPI_TESTS=1` and runs `remote-live-reapi-tests`
- Added `just remote-live-reapi-tests` recipe that runs nextest with `--include-ignored`
- Updated `docs/audits/test-reapi-native-prompt.md` to document the live test path
- PR #703 created: https://github.com/blyzer/oh-my-pi/pull/703

### ✓ Step 8: Verify BuildBuddy extension

- Extension test passed: all profile data values correct (CREDENTIAL_HEADER, ARCH_SPELLING, FIXED_PROPERTIES, PROFILE_NAME, ENDPOINT)
- Four delegate operations registered (describe, start, poll, cancel)
- Each operation raises BuildBuddyUnavailable as expected
- Extension follows ADR 0040 Dimension 1 (vendor integration outside core)

### * Step 9: Execute live reattach test (interactive, user-performed)

- **REAPI gRPC submission verified** — Job 01M81822QAFM1B61JC44AFTQEM was accepted by BuildBuddy, proving the native REAPI client authenticates correctly
- Remaining: restart OMP, run live reattach test (kill OMP after job accepted, reattach, verify no duplicate work)

## Verification

- All `omp-agent` tests pass (30 execution tests, including 2 new crash-window tests)
- `cargo check -p omp-driver -p omp-agent -p omp-exec` compiles cleanly
- Gate enforcement test passes
- Sandbox allowlist configured: `["www.googleapis.com", "app.buildbuddy.io"]`
