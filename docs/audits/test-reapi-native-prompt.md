# Test Native REAPI Crate Against BuildBuddy

**Date:** 2026-11-22
**Purpose:** Verify `crates/exec-reapi/` (REAPI v2 gRPC client) works against
BuildBuddy without using the `bb` CLI.

## Background

The native REAPI gRPC client (`crates/exec-reapi/`) is vendor-neutral. It
speaks the open REAPI v2 protocol and connects to BuildBuddy through gRPC.
The `remote_build` session tool uses this client, not the `bb` CLI.

The client authenticates via operator convars in `~/.o2/config.cfg`:

```
sv_exec_remote_endpoint "grpcs://app.buildbuddy.io"
sv_exec_remote_credential "!security find-generic-password -s buildbuddy-omp2-trial -w"
sv_exec_remote_credential_header "x-buildbuddy-api-key"
sv_exec_remote_arch_spelling "short"
sv_exec_remote_fixed_properties "workload-isolation-type=oci"
sv_exec_remote_profile "operator"
sv_exec_remote_image "docker://gcr.io/flame-public/rbe-ubuntu24-04@sha256:f7db0d4791247f032fdb4451b7c3ba90e567923a341cc6dc43abfc283436791a"
sv_sandbox_allow_domains ["www.googleapis.com", "app.buildbuddy.io"]
```

## Prerequisites

1. **BuildBuddy API key** in macOS Keychain under service `buildbuddy-omp2-trial`
2. **All convars set** in `~/.o2/config.cfg` (see above)
3. **OMP restarted** after convar changes
4. **Sandbox allowlist** includes `www.googleapis.com` (OAuth auth) and
   `app.buildbuddy.io` (REAPI gRPC)

## What `remote_build` Actually Tests

The `remote_build` tool tests the **REAPI gRPC submission path** — it connects
to BuildBuddy, authenticates via the `x-buildbuddy-api-key` gRPC metadata
header, and submits a job. If the job is accepted (returns a job ID), the
REAPI client authenticated successfully.

**Important:** The remote runner unsets `BUILDBUDDY_API_KEY` for security
(ADR 0040 Part H.2). The live tests in `crates/exec-reapi/tests/live_buildbuddy.rs`
are `#[ignore]`d and need this env var, so they don't run. The `remote_build`
tool does NOT test the crate's live gRPC tests — it only tests the submission
path.

## Test Prompt

Copy and paste this into an OMP chat session:

---

**Prompt:**

```
Please verify the native REAPI gRPC client by running a remote build test.

1. Use the remote_build tool to run "test-pkg" for the package "omp-exec-reapi"
   on BuildBuddy.

2. After the job is submitted, monitor its status until it completes or fails.

3. Report:
   - Job ID
   - Submission status (accepted or rejected) — if accepted, the REAPI gRPC
     client authenticated successfully
   - Execution status (running, completed, failed)
   - Any error messages from the remote runner
   - Whether the job ran on BuildBuddy (check the destination URL)

Note: The remote runner unsets BUILDBUDDY_API_KEY for security, so the live
tests in crates/exec-reapi/tests/live_buildbuddy.rs are #[ignore]d and won't
run. The unit tests (capabilities, cas, digest, endpoint, profile, status, tree)
don't connect to any remote endpoint. The job may fail because the test
package has no meaningful remote tests — but if the job was accepted and ran,
the REAPI gRPC client authenticated correctly.

If remote_build fails at submission (before the job is accepted), try:
- Checking if the BuildBuddy endpoint is reachable
- Verifying the API key is configured in the keychain
- Checking the sandbox allowlist includes app.buildbuddy.io and www.googleapis.com
```

---

## Expected Behavior

### Success (Submission Verified)

The `remote_build` tool creates a job and submits it to BuildBuddy via the
native REAPI gRPC client. The job is accepted (returns a job ID pointing at
`https://app.buildbuddy.io:443`). This proves the REAPI gRPC client
authenticated successfully.

The job may fail on the remote runner because:
- The live tests are `#[ignore]`d (no `BUILDBUDDY_API_KEY` on the runner)
- The unit tests don't exercise remote gRPC
- The test package has no meaningful remote tests

**This is expected.** The submission success is what matters for verifying
the REAPI gRPC client authentication.

### Known Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `execution start failed; its submission is unknown` | OAuth auth blocked | Add `www.googleapis.com` to `sv_sandbox_allow_domains` |
| `X-Omp-Policy-Blocked: remote.buildbuddy.io:443` | Egress broker blocks BuildBuddy | Add `app.buildbuddy.io` to `sv_sandbox_allow_domains` |
| `unconfigured` | Missing convars | Set all BuildBuddy convars in `~/.o2/config.cfg` |
| `403 Forbidden` from BuildBuddy | Invalid API key | Verify keychain service `buildbuddy-omp2-trial` |
| Job accepted but failed on runner | Live tests are `#[ignore]`d | Expected — submission success is the goal |

## What This Tests

- **REAPI gRPC submission** — `crates/exec-reapi/` authenticates and submits to BuildBuddy
- **Native auth path** — The client uses `x-buildbuddy-api-key` gRPC metadata header
- **Profile data** — Arch spelling, fixed properties, and profile name are correct
- **Sandbox egress** — The broker allows both required domains
- **`remote_build` tool** — Native session tool, not the `bb` CLI

## Alternative: Direct Script Test

If `remote_build` fails silently, test the REAPI client directly:

```bash
env BUILDBUDDY_API_KEY="$(security find-generic-password -s buildbuddy-omp2-trial -w)" \
  scripts/remote-verify.sh test-pkg omp-exec-reapi
```

This uses the `bb` CLI directly (outside the sandbox) to verify BuildBuddy
connectivity. If this works but `remote_build` doesn't, the issue is the
sandbox egress policy or the REAPI client's convar configuration.

## Testing Live REAPI gRPC Tests

The live gRPC tests in `crates/exec-reapi/tests/live_buildbuddy.rs` are
`#[ignore]`d by default. To run them against BuildBuddy:

```bash
just remote-live-reapi
```

This recipe sets `LIVE_REAPI_TESTS=1`, which tells the runner script to
preserve `BUILDBUDDY_API_KEY` on the remote runner so the live tests can
authenticate. It then runs `remote-live-reapi-tests`, which calls nextest
with `--include-ignored` so the `#[ignore]`d live tests actually execute.

**Security note:** `LIVE_REAPI_TESTS=1` preserves `BUILDBUDDY_API_KEY` on the
remote runner. This is intentional for live tests but means the key is available
to all processes on the runner. Use only when you need to verify the REAPI
client against a real BuildBuddy endpoint.
