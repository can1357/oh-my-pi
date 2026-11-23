# BuildBuddy Remote Execution Extension

Vendor integration for BuildBuddy remote execution (ADR 0040 Dimension 1).

## What this is

A Python extension that provides:

1. **REAPI profile data** — credential header, arch spelling, fixed properties,
   profile name. The native REAPI gRPC client (`crates/exec-reapi/`) reads these
   from operator convars in `~/.o2/config.cfg`.

2. **Run API delegate operations** — four short operations (describe, start,
   poll, cancel) that the future `DelegatedBackend` adapter will call through
   the extension host.

## Architecture

This extension follows **Shape C1** from `docs/research/exec-out-of-core.md`:
a Python extension carrying four short operations behind one adapter.

```
omp chat → remote_build tool (native)
              ↓
      crates/exec/ (generic ExecutionBackend trait)
              ↓
      crates/exec-reapi/ (REAPI v2 gRPC client — vendor-neutral)
              ↓
      BuildBuddy via gRPC (grpcs://app.buildbuddy.io)
```

The extension provides the profile data and delegate operations. The native
REAPI client handles the gRPC communication.

## Profile Data

| Convar | Value | Purpose |
|--------|-------|---------|
| `sv_exec_remote_credential_header` | `x-buildbuddy-api-key` | gRPC metadata header |
| `sv_exec_remote_arch_spelling` | `short` | BuildBuddy arch spelling |
| `sv_exec_remote_fixed_properties` | `workload-isolation-type=oci` | Platform property |
| `sv_exec_remote_profile` | `operator` | Profile name |

## Delegate Operations

| Operation | Returns | Safe to repeat |
|---|---|---|
| `describe` | BackendCapabilities | Yes |
| `start(request, inputs)` | Opaque operation identity | No |
| `poll(operation, cursor)` | State, output page, next cursor | Yes |
| `cancel(operation)` | CancelOutcome | Yes |

## Status

- **Profile data:** Complete — available via `omp_buildbuddy.profile`
- **Delegate operations:** Implemented — Run API HTTP client (`client.py`) calls
  BuildBuddy's REST endpoints (`describe`, `start`, `poll`, `cancel`). The
  `DelegatedBackend` adapter (ADR 0040 Dimension 3) is not yet built, so these
  operations are not wired to production.

## Testing

See `docs/audits/test-reapi-native-prompt.md` for the interactive test prompt
to verify the native REAPI crate against BuildBuddy.
