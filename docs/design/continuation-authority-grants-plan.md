# Operator-granted control capabilities: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a native extension receives `agents.continuation`, `approvals.decide` or `policy.write` only when its manifest declares it and an operator grant (`omp ext grant <DIR>`) covers it.

**Architecture:** a shared identity function in omp-ext; a control-grant set on `ExtHostSpec` filled at native admission by `grant_covers`; the CONTROL identity unions it with the DATA grants; a new `omp ext grant` command writes the record.

**Tech Stack:** Rust (omp-ext, omp-envd, omp-driver, omp-app, omp-e2e).

**Spec:** docs/design/continuation-authority.md, section "Revision (2026-11-17)".

## Global Constraints

- Control list exactly `["agents.continuation", "approvals.decide", "policy.write"]`.
- Grant values: `scope Exact`, `duration Persistent`, `tier Sandboxed`, `ship "path"`, `granted_by "explicit-grant"`.
- Unreadable grants file: empty control grants plus `tracing::warn!`; never stop admission.
- DATA grant behaviour unchanged.
- `parking_lot::Mutex`, never `std::sync::Mutex`. No new dependencies.
- Remote only: `OMP_REMOTE_KEYCHAIN_SERVICE=buildbuddy-omp2-trial just remote remote-plain-test <crate>` and `just remote clippy`. Local `cargo fmt --all -- --check` is fine.

## Review Focus

1. A manifest that adds a capability after the grant was issued loses all control grants (digest mismatch) (Task 2, `changed_manifest_voids_control_grant`).
2. A grant for one folder does not cover a copy of the extension in another folder (Task 2, `grant_for_other_root_does_not_cover`).
3. A workspace extension cannot be covered by a Client-layer grant and vice versa (Task 2, `layer_mismatch_does_not_cover`).

---

### Task 1: Shared identity, control list, spec field, identity union

**Review:** per-task — security

**Files:** `crates/ext/src/trust.rs` (shared publisher fn), `crates/driver/src/discovery/native.rs:577` (call it), `crates/envd/src/policy.rs` (`CONTROL_CAPABILITIES`), `crates/envd/src/worker.rs:176-206` (`control_grants` on `ExtHostSpec`), `:1118` (union).

**Interfaces (produces):**
- `pub fn native_path_publisher(root: &Path) -> String` in omp-ext (exact value of today's synthesis).
- `pub const CONTROL_CAPABILITIES: &[&str]` in omp-envd `policy`.
- `pub control_grants: BTreeSet<Str>` on `ExtHostSpec`, default empty.

- [ ] Failing tests: `native_path_publisher_is_stable_per_root`; `identity_carries_control_grants` (spec with `control_grants = {agents.continuation}` yields an identity whose capabilities contain it); `data_authority_never_sees_control_grants` (the DATA registration receives only `data_grants`).
- [ ] Run remotely (`omp-ext`, `omp-envd`), see them fail; implement; green; clippy; fmt.
- [ ] Commit `feat(envd): carry operator control grants to CONTROL identities`.

### Task 2: Admission check in native discovery

**Review:** per-task — security

**Files:** `crates/driver/src/discovery/native.rs` (around :600-605), plus the plumbing that gives admission `data_dir` and the project `WorkspaceUri` (callers `crates/driver/src/headless/kernel.rs:2490` and `crates/app/src/ext_cli/config.rs:176`; find how the kernel builds the workspace identity near `kernel.rs:2496`).

**Consumes:** Task 1's three items; `grants_path`, `GrantsFile::read`, `grant_covers`, `TrustTier`, `Layer` from omp-ext; `projection.capability_digest`.

- [ ] Failing tests (unit, temp dirs): `declared_without_grant_gets_no_control_grant`; `matching_grant_yields_control_grant`; `changed_manifest_voids_control_grant`; `grant_for_other_root_does_not_cover`; `layer_mismatch_does_not_cover`; `unreadable_grants_file_fails_closed`.
- [ ] Red, implement, green (`omp-driver`), clippy, fmt.
- [ ] Commit `feat(driver): admit control capabilities only with an operator grant`.

### Task 3: `omp ext grant <DIR>` (parallel with Task 2)

**Review:** per-task — security

**Files:** `crates/app/src/ext_cli/mod.rs` (new subcommand next to `trust` at :1985 and `ExtTrustArgs` at :563), its tests.

**Consumes:** Task 1's `native_path_publisher`; `GrantsFile::try_update`, `grants_path`, `Grant`, `GrantScope::Exact`, `GrantDuration::Persistent`, `TrustTier::Sandboxed` from omp-ext; manifest projection for DIR.

- [ ] Failing tests: `grant_writes_record_admission_accepts` (after `grant DIR --yes`, `grant_covers` with the admission's inputs is true); `revoke_removes_record`; `grant_without_consent_refuses` (no `--yes`, no terminal).
- [ ] Red, implement, green (`omp-app`), clippy, fmt.
- [ ] Commit `feat(app): omp ext grant issues control grants for path extensions`.

### Task 4: End to end and docs

**Files:** `crates/e2e/src/support/pyext.rs` (set `control_grants`), a test in `crates/e2e/tests/`; `docs/py/12-agents.md`, `docs/py/14-deploy.md`, `docs/adr/TASKS.md`.

- [ ] Test `granted_extension_sets_continuation_policy` and `ungranted_extension_gets_policy_denied` through real CONTROL; gate the file in `justfile` and `ci.yml` like the other p9 proofs.
- [ ] Docs: how to grant (`omp ext grant <DIR>`), that the digest pins the declared set, and a TASKS.md OPEN row for DATA grants following manifest declarations in trusted workspaces, plus an OPEN question on where installed site extensions load.
- [ ] Remote green (`omp-e2e`), commit `test(e2e): prove operator-granted continuation authority; docs`.
