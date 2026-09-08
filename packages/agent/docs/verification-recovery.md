# Verification & Failure-Recovery Engine

The verification engine is deterministic and model-agnostic. It runs at the existing agent yield boundary, uses the repository's real package scripts when available, and returns repair work through the existing follow-up queue.

## Lifecycle

```text
agent work
  -> existing OMP turn/tool execution
  -> pre-yield verification gate
  -> changed-scope policy
  -> cheapest meaningful check
  -> targeted/larger checks only after earlier checks pass
  -> compact failure evidence
  -> bounded repair follow-up
  -> verify again
```

No second agent loop is created. The repair is an ordinary `Agent.followUp()` continuation.

## Verification policy

The policy considers Task Router complexity, changed files, file types, affected packages, and discovered package/root scripts. TypeScript package changes prefer `check:types`, then package tests, then lint, with build validation for configuration/high-complexity changes. Rust uses the repository `check:rs` script when present; Python falls back to `py_compile`; Go uses `go test ./...` then `go vet ./...` when package-specific scripts are unavailable.

Documentation-only changes intentionally return `UNVERIFIED` rather than inventing application evidence.

## Failure evidence

Failures retain raw output in telemetry while passing a compact record to repair context: check name, category, summary, primary error, expected/actual evidence, related files, affected symbols, attempt number, and raw-output availability.

## Recovery

Recovery defaults to at most two repairs for the same failure signature and four total autonomous repair attempts. Environment, network, dependency, and timeout failures are `BLOCKED`. Repeated unknown failures stop autonomous recovery. Repeated verification failures can escalate the existing Task Router complexity rather than increasing retries indefinitely.

## Completion states

`VERIFIED_SUCCESS` means all selected deterministic checks passed. `PARTIAL_SUCCESS` means runnable checks passed while dependent checks were skipped. `FAILED` means deterministic verification found a code/build/test problem that was not repaired within policy. `BLOCKED` means the verification environment prevented meaningful execution. `UNVERIFIED` means no meaningful deterministic application verification was available.

## Runtime controls

- `PI_VERIFICATION=0` disables the verification gate.
- `PI_VERIFICATION_TIMEOUT_MS=<ms>` controls a single check timeout.
- `PI_VERIFICATION_MAX_SAME_FAILURE=<count>` bounds repeated same-failure repairs.
- `PI_VERIFICATION_MAX_REPAIRS=<count>` bounds total autonomous repairs.

Raw command output is kept in the runtime telemetry object returned by `getVerification(agent)` and is not repeatedly injected into model context. Task 02's Context Intelligence hook handles the resulting repair message as normal context.
