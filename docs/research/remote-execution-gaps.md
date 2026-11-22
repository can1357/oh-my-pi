# Remote Execution Gap Analysis

**Date:** 2026-11-22
**Status:** Research report
**Area:** runtime — remote execution, ADR 0040/0047
**Source:** ADR 0040, ADR 0047, STATUS.md, TASKS.md, source code

## Executive Summary

ADR 0040 (remote build/test execution) and ADR 0047 (agent build execution model) define a comprehensive remote execution architecture. The core infrastructure is implemented but several gaps prevent full acceptance:

1. **ADR 0040 Gaps 1-4** — Producer exists but is unaccepted; two crash-window tests missing; live reattach not verified; typed results tested but owner acceptance pending.
2. **ADR 0047 C1-C4** — Credential containment (C1) undecided; producer prerequisite (C2) met but unaccepted; no remote default (C3); vendor removal verified (C4).
3. **Gate enforcement** — Remote REAPI wiring exists but no code enforces A0, G3, or G8 gates.

## Current Implementation

### What's Built

| Component | Location | Status |
|-----------|----------|--------|
| `ExecutionBackend` trait | `crates/exec/src/backend.rs:139` | Implemented |
| `ExecutionRun` trait | `crates/exec/src/backend.rs:168` | Implemented |
| `place()` router | `crates/exec/src/place.rs:50` | Implemented |
| `CargoJust` adapter | `crates/exec/src/cargo_just.rs` | Implemented |
| `LocalBackend` | `crates/exec-local/src/lib.rs` | Implemented |
| `ReapiBackend` | `crates/exec-reapi/src/execute.rs` | Implemented |
| `SshBackend` | `crates/exec-ssh/src/lib.rs` | Implemented |
| Job producer | `crates/agent/src/jobs.rs:1024` `start_execution` | Implemented, off by default |
| `remote_build` tool | `crates/driver/src/remote_build.rs` | Implemented, off by default |
| Real reattach | `crates/agent/src/jobs.rs:1669` `reattach_execution` | Implemented |
| Restart settlement | `crates/agent/src/jobs.rs:2194` `orphaned_execution` | Implemented |
| Approval integration | `crates/agent/src/jobs.rs:170` `AuthorizedExecution` | Implemented |
| Journal replay | `crates/agent/tests/jobs.rs` | Mock backends only |

### What's Missing

| Gap | Description | Risk |
|-----|-------------|------|
| ADR 0040 Gap 1 | Producer exists but unaccepted | Owner gate |
| ADR 0040 Gap 2 | Live reattach not verified | Owner gate |
| ADR 0040 Gap 3 | Two crash-window tests missing | Low |
| ADR 0040 Gap 4 | Typed results tested but unaccepted | Low |
| ADR 0047 C1 | Credential containment undecided | Blocked |
| Gate enforcement | No code enforces A0, G3, G8 | Medium |
| `DelegatedBackend` | Out-of-core adapter not built | Blocked on Phase 0 |

## Open Questions from ADR 0040

The ADR lists 9 open questions (D1-D9):

- **D1** — Accept Gaps 1, 3, 4? (needs Step 2 tests first)
- **D2** — ADW durability for remote phases? (recommended: not now)
- **D3** — Accept window 4 as residual? (recommended: yes)
- **D4** — Owner type for execution jobs? (recommended: agent-side enum)
- **D5** — Submit-time refusal for non-resumable backends? (recommended: not now)
- **D6** — Live-check prerequisites? (blocked on owner questions)
- **D7** — ADR 0047 C2 wording confirmation
- **D8** — ADR 0047 caller sentence amendment
- **D9** — Two `JobKind` enums (tool vs agent)

## Recommended Implementation Sequence

Based on the ADR's Step 0-6 sequence:

1. **Step 2** — Add two crash-window tests (Gap 3)
2. **Step 1** — Run verification tests (omp-agent suite)
3. **Step 5** — Verify typed results (Gap 4, tests exist)
4. **Step 3** — Live reattach check (Gap 2, owner-gated)
5. **Gate enforcement** — Enforce A0, G3, G8 in code

## Classification

| Change | Classification | Reason |
|--------|---------------|--------|
| Crash-window tests | Native enhancement | Extends existing test suite |
| Gate enforcement | Native enhancement | Adds code checks for gates |
| Live reattach | Verification | No code change, just evidence |
| DelegatedBackend | Extension | Out-of-core adapter |
| Credential containment | Documentation | ADR decision record |

## Key Files

- `crates/exec/src/backend.rs` — ExecutionBackend trait
- `crates/exec/src/place.rs` — place() router
- `crates/agent/src/jobs.rs` — Job board, producer, reattach
- `crates/driver/src/remote_build.rs` — remote_build tool
- `crates/driver/src/adw/remote.rs` — ADW remote execution
- `crates/driver/src/exec_composer.rs` — Backend composition
- `crates/agent/tests/jobs.rs` — Execution tests
- `docs/adr/0040-remote-build-and-test-execution.md` — ADR 0040
- `docs/adr/0047-agent-build-execution-model.md` — ADR 0047
