---
sessionId: session-261121-071840-zne9
---

# BuildBuddy Extension: DelegatedBackend Adapter and Live Testing

**Date:** 2026-11-23
**Status:** Complete — all stages done, PR #713 ready to merge
**Area:** runtime — execution, extensions, BuildBuddy integration
**Source:** ADR 0040 Dimension 2/3, `docs/research/exec-out-of-core.md` (shape C1), BuildBuddy extension verification

## Problem Statement

The BuildBuddy extension (`extensions/buildbuddy/`) implements five delegate operations (`describe`, `start`, `poll`, `get_log`, `cancel`) that correctly call BuildBuddy's Run API REST endpoints. All 31 unit tests pass. But three limitations prevent correct testing:

1. **`DelegatedBackend` adapter does not exist.** The extension device operations are not wired into the `ExecutionBackend` trait (`crates/exec/src/backend.rs`). The `exec_composer.rs` in `omp-driver` only composes `ReapiBackend`. There is no `Delegated` arm in any composition enum. Without this adapter, the extension operations cannot be reached from the execution job system (`JobBoard::start_execution`), the `remote_build` tool, or the ADW remote phase. The extension works as standalone device calls but is not integrated as a production backend.

2. **Cancel remains `unsupported`.** BuildBuddy's REST API has no cancel endpoint. Cancellation requires the gRPC `BuildBuddyService.CancelExecutions` call, which needs a native gRPC wheel not available in the Python extension. The extension correctly reports `CancelSupport::None` and returns `CancelOutcome::Unsupported`. This is acceptable per ADR 0040 — the action timeout bounds leaked work (30 minutes default).

3. **No live network test.** The sandbox blocks outbound network from extension code. `omp.env.http_post` calls fail with `BuildBuddyUnavailable: network blocked by sandbox`. The extension respects `sv_sandbox_allow_domains` via the egress broker, but `app.buildbuddy.io` is allowlisted only in `~/.o2/config.cfg` — the test environment never reaches production envd with that allowlist.

## Current State (Investigation Results)

### What exists
- **BuildBuddy extension**: 5 device operations, 31/31 tests pass, correct API endpoints
- **`ReapiBackend`**: Implements `ExecutionBackend`, speaks REAPI gRPC, wired in `exec_composer.rs`
- **`remote_build` tool**: Uses `ReapiBackend` only; `RemoteBuildHost` trait requires `ExecutionBackend`
- **`JobBoard::start_execution`**: Produces `JobKind::Execution` jobs, off by default (`sv_exec_agent_runs`)
- **`reattach_execution`**: Resumes accepted runs, mock backends only
- **envd extension host**: `PyCallbackRoute::dispatch` is `pub(crate)` — not accessible from driver
- **Phase 0**: Returned **STOP** — no existing host carries an out-of-core execution backend

### What is missing
- `DelegatedBackend` struct implementing `ExecutionBackend`
- Composition enum with `Delegated` arm in `exec_composer.rs`
- envd entry point for calling extension device operations from driver
- Non-model-callable route for backend operations (credential-bearing)
- Wiring from `remote_build` tool to `DelegatedBackend`

### Architecture constraints
- `ExecutionBackend` trait is never used as `dyn` — the composing crate holds an enum
- `ExecutionRun` trait requires `next_event()`, `cancel()`, `detach()`
- `ReattachHandle` carries backend ID, operation ID, and schema
- `ExecutionRequest` expects `InputSet` (captured inputs); extension `start` takes `steps` payload
- ADW and cleanse attach with `py_eval: false` and no trusted extensions
- Headless kernel attaches configured extensions

## Solution

Build the `DelegatedBackend` adapter (shape C1 from `exec-out-of-core.md`) that bridges extension device operations to the `ExecutionBackend` trait. This enables the extension to be composed as a production backend, reachable from the execution job system.

### What `DelegatedBackend` must do

The adapter implements `ExecutionBackend` by delegating to extension device operations via envd:

- **`capabilities()`** → calls `describe` device, maps the response to `BackendCapabilities`
- **`start(request)`** → calls `start` device with the request, returns a `DelegatedRun`
- **`reattach(handle, context)`** → calls `poll` device with the stored operation ID, returns a `DelegatedRun` resuming from that state
- **`DelegatedRun::next_event()`** → polls `poll` device for state transitions, fetches logs via `get_log` device, emits `ExecutionEvent` stream
- **`DelegatedRun::cancel()`** → calls `cancel` device; returns `CancelOutcome::Unsupported` for REST-only backends
- **`DelegatedRun::detach()`** → returns `ReattachHandle` with backend ID, operation ID, and schema

### Architecture

```
exec_composer.rs (composition)
  ├── ReapiBackend (existing, REAPI gRPC)
  ├── LocalBackend (existing, via envd ExecHost)
  └── DelegatedBackend (NEW, via extension devices)
         │
         ├── envd entry point (new: call extension operation by device path)
         │
         └── BuildBuddy extension (existing, 5 device operations)
                ├── describe → static capabilities
                ├── start → POST /api/v1/Run
                ├── poll → POST /api/v1/GetInvocation
                ├── get_log → POST /api/v1/GetLog
                └── cancel → returns unsupported
```

### What is needed in core

Per `exec-out-of-core.md` shape C1 requirements:

1. **`DelegatedBackend` struct** in `omp-driver` implementing `ExecutionBackend`. Maps `ExecutionRequest` to extension device calls. Near `crates/exec-ssh/src/lib.rs` size (~243 lines).

2. **Composition enum update** in `exec_composer.rs`. Add `Delegated(DelegatedBackend)` arm. The enum is keyed by `BackendId` from operator cfg. Placement, the execution-job producer, and `reattach_execution` all use it.

3. **envd entry point** for calling extension operations. `PyCallbackRoute::dispatch` (`crates/envd/src/exthost/extensions.rs:1715`) is `pub(crate)`. Expose one call for the adapter to invoke a device operation by path.

4. **Credential and egress paths**. The extension needs the vendor key and network access. `docs/py/00-overview.md:121` specifies credential requests on the CONTROL channel. `Grants::from_effect_envelope` can grant `env.net` (`policy.rs:132`).

5. **Non-model-callable route**. `is_model_callable` returns `true` for all `ToolRoute` variants. A backend operation carries a credential and spends money, so it needs a route that core can call and the model cannot.

### What stays in the extension

The extension already carries:
1. The Run API client with correct endpoints (`client.py`)
2. Five device operations (`devices.py`)
3. Profile constants (`profile.py`)
4. Error types (`errors.py`)

No changes to the extension are needed for the adapter — it calls the existing device operations.

### Cancel: why `unsupported` is acceptable

- BuildBuddy REST API has no cancel endpoint (confirmed by API docs)
- gRPC `BuildBuddyService.CancelExecutions` requires a native wheel
- ADR 0040 action timeout (30 minutes default) bounds leaked work
- `CancelSupport::None` is a valid capability; the trait supports it
- The `ReapiBackend` already handles `CancelSupport::None` gracefully
- A future native gRPC wheel can add cancel without changing the adapter

## Scope

### In Scope
- `DelegatedBackend` adapter in `omp-driver`
- Composition enum update in `exec_composer.rs`
- envd entry point for extension device calls
- Wiring the BuildBuddy extension as a `Delegated` backend
- Live test: submit a run to BuildBuddy via the adapter, poll to completion, verify result
- Update `docs/audits/buildbuddy-extension-verification-output.md` with live test results

### Out of Scope
- Native gRPC wheel for cancel (ADR 0036 decision 4 permits, but not built)
- Phase 0 changes 1 and 3 (admission route, cancellation on deadline) — these are prerequisites for any extension capability, not unique to execution
- ADW durable runs (ADR 0040 D2: not for this gate)
- Removing vendor items from `omp-exec-reapi` (ADR 0040 Dimension 2)
- Git-patch capture in envd (needed for any Run API path, but not for initial test)

## Testing Strategy

1. **Unit tests** for `DelegatedBackend` with mocked extension responses
2. **Live test** with `app.buildbuddy.io` allowlisted in `sv_sandbox_allow_domains`
3. **Integration test** that submits a `just check` run, polls to completion, and verifies the result
4. **Cancel test** that verifies `CancelOutcome::Unsupported` is returned correctly
5. **Reattach test** that detaches and reattaches a running execution

## Risks

1. **envd entry point design.** Exposing `PyCallbackRoute::dispatch` requires careful scoping to avoid letting arbitrary extension code be called as a backend. The entry point must validate the device path against an admitted extension.

2. **Input capture.** `ExecutionRequest` expects captured inputs as `InputSet`. The extension `start` device takes a `steps` payload. The adapter must bridge these formats — either by converting `InputSet` to `steps`, or by accepting that the Run API path uses a different input model.

3. **Network blocking.** The sandbox blocks outbound network. The live test requires `sv_sandbox_allow_domains` to include `app.buildbuddy.io`. This is already configured in `~/.o2/config.cfg` but may not be available in all test environments.

4. **Extension lifecycle.** The extension host must be available when the adapter calls device operations. ADW and cleanse attach with `py_eval: false` and no trusted extensions. The headless kernel attaches configured extensions. The adapter must ensure the extension is loaded.

## Key Decisions

### Why build DelegatedBackend now

The BuildBuddy extension is ready: correct API endpoints, all tests pass, proper error handling. The only thing preventing it from being a production backend is the missing adapter. Building `DelegatedBackend` completes the path from extension device operations to the execution job system, enabling live testing and production use.

### Why not build cancel via gRPC now

The gRPC `BuildBuddyService.CancelExecutions` requires a native wheel in the Python extension. ADR 0036 decision 4 permits native wheels, but the wheel is not built. `CancelSupport::None` is a valid capability — the action timeout bounds leaked work. Building the wheel is a separate concern that can be addressed later without changing the adapter.

### Why shape C1 over other options

Shape C1 (extension device operations called via envd) was recommended in `exec-out-of-core.md` because:
- It uses the one extension-host behavior that Phase 0 found working (short request/response calls)
- The extension is already implemented and tested
- No new core changes are needed beyond the adapter and envd entry point
- The pattern matches class (b) provider extensions: data plus cold-path Python that core calls

### Alternative: Direct REAPI via ReapiBackend

The existing `ReapiBackend` speaks REAPI gRPC to BuildBuddy. This path is already wired and tested (P13). But it requires:
- Input capture as content-addressed tree (CAS uploads)
- REAPI-compatible action and command digests
- Platform properties and toolchain images

The Run API path (via extension) is simpler for initial testing because it takes `steps` (commands to run) and optional git workspace fields. The adapter can bridge `ExecutionRequest` to the Run API format.

## File Structure

### New files
- `crates/driver/src/delegated_backend.rs` — `DelegatedBackend` and `DelegatedRun` implementing `ExecutionBackend` and `ExecutionRun`

### Modified files
- `crates/driver/src/exec_composer.rs` — Add `Delegated` arm to composition enum
- `crates/driver/src/lib.rs` — Export `delegated_backend` module
- `crates/envd/src/exthost/extensions.rs` — Expose entry point for calling extension device operations
- `docs/audits/buildbuddy-extension-verification-output.md` — Update with live test results

## Delivery Steps

### ✓ Stage 1: Build DelegatedBackend adapter

- `DelegatedBackend` in `crates/driver/src/delegated_backend.rs` compiles cleanly
- Implements `ExecutionBackend` and `ExecutionRun` traits
- Calls extension devices via `EnvClient::invoke(InvokeTool)`
- Maps device responses to `ExecutionEvent` stream

### ✓ Step 2: Wire DelegatedBackend into exec_composer and envd

Add the `Delegated` arm to the composition enum and expose the envd entry point.

- Add `Delegated(DelegatedBackend)` arm to the backend enum in `exec_composer.rs`
- Update `ExecutionSettings::connect()` to support delegated backends
- Expose envd entry point for calling extension device operations by path
- Update `reattach_execution` to handle delegated backend handles
- Add integration test that composes a `DelegatedBackend` and verifies it can start, poll, and cancel

### ✓ Stage 3: Live test with BuildBuddy

Submit a run to BuildBuddy via the adapter, poll to completion, and verify the result.

- Configure `sv_exec_remote_profile` to use the BuildBuddy extension as delegated backend
- Ensure `app.buildbuddy.io` is in `sv_sandbox_allow_domains`
- Submit a simple `just check` run via the adapter
- Poll to completion and verify the result matches expected output
- Verify `CancelOutcome::Unsupported` is returned for cancel
- Update `docs/audits/buildbuddy-extension-verification-output.md` with live test results
