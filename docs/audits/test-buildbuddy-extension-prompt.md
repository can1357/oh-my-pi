# Test BuildBuddy Extension

**Date:** 2026-11-22
**Purpose:** Verify `extensions/buildbuddy/` (BuildBuddy vendor integration extension)
loads correctly and provides profile data and delegate operations.

## Background

The BuildBuddy extension (`extensions/buildbuddy/`) is a Python extension that
provides:

1. **REAPI profile data** — `omp_buildbuddy.profile` module with credential header,
   arch spelling, fixed properties, profile name, and endpoint.
2. **Run API delegate operations** — four stub operations (describe, start, poll,
   cancel) that raise `BuildBuddyUnavailable` until the `DelegatedBackend` adapter
   is built.

The extension follows Shape C1 from `docs/research/exec-out-of-core.md`.

## Prerequisites

1. **OMP built** — `cargo build` completed successfully
2. **Extension conformance** — `python3 scripts/check-extension-conformance.py` passes
3. **Python 3.14t** — Embedded CPython is configured (`just setup-python`)

## Test Prompt

Copy and paste this into an OMP chat session:

---

**Prompt:**

```
Please verify the BuildBuddy extension by checking its profile data and delegate operations.

1. Import the extension module and verify the profile data:
   - Check that omp_buildbuddy.profile exists
   - Print CREDENTIAL_HEADER (should be "x-buildbuddy-api-key")
   - Print ARCH_SPELLING (should be "short")
   - Print FIXED_PROPERTIES (should be "workload-isolation-type=oci")
   - Print PROFILE_NAME (should be "operator")
   - Print ENDPOINT (should be "grpcs://app.buildbuddy.io")

2. Verify the delegate operations are registered:
   - Check that omp_buildbuddy.devices exists
   - List the four operations: describe, start, poll, cancel
   - Call each operation and verify it raises BuildBuddyUnavailable
     (since DelegatedBackend adapter is not yet built)

3. Report:
   - Whether the extension module imports successfully
   - Whether all profile data values are correct
   - Whether all four delegate operations are registered
   - Whether each operation raises BuildBuddyUnavailable as expected

If any step fails, report the exact error message and traceback.
```

---

## Expected Behavior

### Success

The extension module imports successfully. Profile data values match the expected
defaults. All four delegate operations are registered and raise
`BuildBuddyUnavailable` with the message "DelegatedBackend adapter not yet built
(ADR 0040 Dimension 3)".

### Known Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ModuleNotFoundError: No module named 'omp_buildbuddy'` | Extension not installed | Run `just setup-python` and rebuild OMP |
| `ImportError` on profile module | Missing dependencies | Check `pyproject.toml` dependencies |
| Profile values don't match | Wrong extension version | Verify `extensions/buildbuddy/` is up to date |
| Delegate operations not registered | Hook not fired | Check `extension_activate` hook in `devices.py` |

## What This Tests

- **Extension module** — `extensions/buildbuddy/` imports correctly
- **Profile data** — `omp_buildbuddy.profile` provides correct BuildBuddy defaults
- **Delegate operations** — Four stub operations are registered via `extension_activate` hook
- **Error handling** — `BuildBuddyUnavailable` is raised correctly for stub operations
- **Extension conformance** — The extension follows ADR 0049 D5 conformance rules

## Alternative: Direct Python Test

If the OMP chat test fails, verify the extension directly:

```bash
cd /Users/enverfrancisco/repositories/oh-my-pi
python3 -c "
import sys
sys.path.insert(0, 'extensions/buildbuddy/src')
from omp_buildbuddy import profile, errors, devices
print('CREDENTIAL_HEADER:', profile.CREDENTIAL_HEADER)
print('ARCH_SPELLING:', profile.ARCH_SPELLING)
print('FIXED_PROPERTIES:', profile.FIXED_PROPERTIES)
print('PROFILE_NAME:', profile.PROFILE_NAME)
print('ENDPOINT:', profile.ENDPOINT)
print('Devices module loaded:', hasattr(devices, 'describe'))
print('Error class:', errors.BuildBuddyUnavailable)
"
```

This tests the extension module directly without OMP's extension host.
