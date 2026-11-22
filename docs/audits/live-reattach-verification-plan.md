# Live Reattach Verification Plan — ADR 0040 Gap 2

**Date:** 2026-11-22
**Status:** Plan — awaiting live execution
**Area:** runtime — remote execution, ADR 0040/0047
**Source:** ADR 0040 Amendment §5 Step 3, D6

## Objective

Verify that a remote execution job can survive a process crash and be resumed via `omp jobs attach`, proving the reattach path works end-to-end with a live REAPI backend (BuildBuddy).

## Prerequisites (ADR 0040 D6)

The following must be resolved before running:

1. **Source upload to BuildBuddy Cloud** — Owner approved. The `bb remote` command uploads the current checkout to BuildBuddy's CAS.
2. **Image hosting** — BuildBuddy uses `gcr.io/flame-public/rbe-ubuntu24-04` (pinned in `scripts/remote-verify.sh:94`). The runner snapshot is seeded on the `omp2` branch.

## Configuration

The following operator convars must be set in `~/.o2/config.cfg`:

```
sv_exec_accepted true
sv_exec_agent_runs true
sv_exec_remote_endpoint "grpcs://app.buildbuddy.io"
sv_exec_remote_image "docker://gcr.io/flame-public/rbe-ubuntu24-04@sha256:f7db0d4791247f032fdb4451b7c3ba90e567923a341cc6dc43abfc283436791a"
sv_exec_remote_credential "!security find-generic-password -s buildbuddy-omp2-trial -w"
sv_exec_remote_credential_header "x-buildbuddy-api-key"
sv_exec_remote_arch_spelling "short"
sv_exec_remote_fixed_properties "workload-isolation-type=oci"
sv_exec_remote_profile "operator"
sv_sandbox_allow_domains ["www.googleapis.com", "app.buildbuddy.io"]
```

- `sv_exec_accepted` — Gate for remote execution (ADR 0047). Must be explicitly set after the owner accepts ADR 0040 Gaps 1-4.
- `sv_exec_agent_runs` — Enables the `remote_build` session tool.
- `sv_exec_remote_endpoint` — The REAPI endpoint address. Empty disables remote execution.
- `sv_exec_remote_image` — Digest-pinned container image for the BuildBuddy runner.
- `sv_exec_remote_credential` — Command that outputs the BuildBuddy API key. The key is stored in the macOS Keychain under service `buildbuddy-omp2-trial`.
- `sv_exec_remote_credential_header` — gRPC metadata header for API key auth. BuildBuddy requires `x-buildbuddy-api-key`.
- `sv_exec_remote_arch_spelling` — Architecture property spelling. BuildBuddy uses `short` (`Arch`/`amd64`), not `reapi` (`ISA`/`x86-64`).
- `sv_exec_remote_fixed_properties` — Fixed platform properties. BuildBuddy requires `workload-isolation-type=oci`.
- `sv_exec_remote_profile` — REAPI profile name. BuildBuddy uses `operator`.
- `sv_sandbox_allow_domains` — Domains the sandbox egress broker admits. The REAPI backend requires:
  - `www.googleapis.com` — OAuth/token authentication before any REAPI call. Without this, auth fails and the submission is unknown.
  - `app.buildbuddy.io` — The REAPI gRPC endpoint for job submission and status polling.

**Status:** All convars are set. The sandbox allowlist includes both required domains. The BuildBuddy-specific profile convars (credential_header, arch_spelling, fixed_properties, profile) are required for the `remote_build` tool to authenticate and submit correctly — without them, the tool fails silently.

## Test Procedure

### Step 1: Verify BuildBuddy connectivity

```bash
# Verify bb CLI works
bb --version

# Verify API key is accessible
security find-generic-password -s buildbuddy-omp2-trial -w

# Run a quick remote test
just remote-test-pkg omp-exec-reapi
```

Expected: The remote test completes successfully, confirming the BuildBuddy runner is reachable and the API key works.

### Step 2: Start a remote execution job

```bash
# Start OMP with the remote_build tool enabled
omp chat

# In the chat, trigger a remote build
/remote_build test-pkg omp-exec-reapi
```

Expected: The agent asks for network approval, then starts a remote execution job on BuildBuddy. The job should reach the `Accepted` state.

### Step 3: Kill the process after acceptance

After the job shows as `Accepted` (check the journal or logs), kill the OMP process:

```bash
# Find the omp process
ps aux | grep omp

# Kill it (simulates a crash)
kill -9 <pid>
```

### Step 4: Reattach via `omp jobs attach`

```bash
# Start a new OMP session
omp chat

# Reattach to the orphaned job
/attach <job-id>
```

The job ID can be found in the session journal:

```bash
# Find the last session journal
ls -lt ~/.local/share/oh-my-pi/sessions/ | head -5

# Look for the execution job
grep -l "execution_state" ~/.local/share/oh-my-pi/sessions/*.oms | head -1
```

### Step 5: Verify the result

Check that:

1. The job settled exactly once (no duplicate starts)
2. The backend started exactly once (check BuildBuddy invocation logs)
3. The settlement is recorded in the journal with the correct execution state
4. The invocation ID is recorded for audit

## Success Criteria

| Criterion | Pass Condition |
|-----------|---------------|
| One settlement | The job reaches a terminal state (Settled or EffectsUnknown) |
| One backend start | BuildBuddy shows exactly one execution for the action |
| Recorded invocation ID | The journal contains the BuildBuddy operation name |
| No duplicate work | The job was not restarted after reattach |

## Known Risks

1. **Approval timeout** — The network approval may expire between steps. The operator must approve the endpoint host.
2. **BuildBuddy runner availability** — The runner may be busy or unavailable. Use `just remote-test-pkg` first to verify.
3. **Window 4 residual** — If the crash happens between backend acceptance and poll commit, the job settles `SubmissionUnknown` (ADR 0040 D3). This is a known residual, not a failure.

## Audit Trail

After the test, record the following in this document:

- Date and time of the test
- BuildBuddy invocation ID
- Job ID from the session journal
- Observed wall times (start, acceptance, crash, reattach, settlement)
- Any errors or unexpected behavior

## References

- ADR 0040 Amendment §5 Step 3 (line 2004)
- ADR 0040 D6 (line 2016) — Live-check prerequisites
- `crates/agent/src/jobs.rs:1669` — `reattach_execution`
- `crates/app/src/jobs_cmd.rs:105` — `omp jobs attach` CLI
- `crates/driver/src/remote_build.rs` — `remote_build` session tool
- `docs/audits/remote-verification-trial.md` — Previous remote verification results
