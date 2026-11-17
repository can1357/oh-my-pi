# Operator-granted control capabilities: implementation plan (revision 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a user-layer native extension receives `agents.continuation`, `approvals.decide` or `policy.write` only when its manifest declares it and an operator grant written by `omp ext grant` covers it; nothing an extension or repository controls can create or alter that grant.

**Architecture:** omp-ext validates capability names and owns the path-grant identity (publisher, length-prefixed digest); omp-envd carries control grants to CONTROL identities and protects the grants store in the exec sandbox; omp-driver admits control grants for user-layer extensions after checking the store; omp-app issues and revokes grants.

**Spec:** docs/design/continuation-authority.md, sections "Revision (2026-11-17)" and "Revision 2" (Revision 2 wins on conflict).

## Global Constraints

- Control list exactly `["agents.continuation", "approvals.decide", "policy.write"]`.
- Only `RootOrigin::User` extensions can receive control grants.
- Capability names: non-empty, `[a-z0-9._-]` only.
- Path-grant digest: BLAKE3 over `omp.path-grant.v1`, each sorted unique capability as u64-LE length + bytes, then the 32-byte manifest digest; `b3:<hex>`. Signed-install `capability_digest` unchanged.
- Grant values: `scope Exact`, `duration Persistent`, `tier Sandboxed`, `ship "path"`, `granted_by "explicit-grant"`, `layer Client`, `workspace None`.
- Store check failure or unreadable store: empty control grants plus `tracing::warn!`; never stop admission.
- DATA grant behaviour unchanged.
- `parking_lot::Mutex`, never `std::sync::Mutex`. No new dependencies.
- Remote only: `OMP_REMOTE_KEYCHAIN_SERVICE=buildbuddy-omp2-trial just remote remote-plain-test <crate>` and `just remote clippy`. Local `cargo fmt --all -- --check` is fine.

## Review Focus

1. `["approvals.decide\nzz"]` cannot load, and `path_grant_digest` differs for `["a","b\nc"]` vs `["a","b","c"]` (Task 1).
2. A process in the exec sandbox cannot write `<data>/ext/grants.toml`, in workspace-write and in Off mode (Task 2).
3. A symlinked or foreign-owned store, or one inside the workspace, yields no control grants (Task 3).
4. A workspace-layer or explicit-root extension never gets a control grant even with a matching record (Task 3).
5. The grant written by the command is exactly what admission checks (Task 5 end to end).

---

### Task 1: omp-ext names, digest, publisher

**Review:** per-task — security

**Files:** `crates/ext/src/config.rs` (`DeploymentManifest::validate` :1699), `crates/ext/src/trust.rs` (new fns next to `capability_digest` :1130).

**Produces:** `pub fn path_grant_digest(capabilities: impl IntoIterator<Item = Str>, manifest_digest: &[u8; 32]) -> Str`; `pub fn native_path_publisher(canonical_root: &Path) -> Str`.

- [ ] Failing tests: `capability_name_with_newline_is_rejected`, `capability_name_with_uppercase_or_space_is_rejected`, `valid_capability_names_load`; `path_grant_digest_separates_entries` (the two sets above differ), `path_grant_digest_binds_manifest`, `path_grant_digest_ignores_order_and_duplicates`; `native_path_publisher_matches_admission_format` (equals `unsigned:path:<blake3 hex of the path text>`).
- [ ] Red (`omp-ext`), implement, green, clippy, fmt. Commit `feat(ext): validate capability names; path-grant identity`.

### Task 2: omp-envd control grants and protected store (parallel with Task 1)

**Review:** per-task — security

**Files:** `crates/envd/src/policy.rs` (`CONTROL_CAPABILITIES`), `crates/envd/src/worker.rs` (:176-206 `control_grants`, :1118 union), `crates/envd/src/exec_sandbox.rs` (absolute protected paths next to `CARVE_OUTS` :37, applied like :1385-1398, also in Off :1400).

**Produces:** `pub const CONTROL_CAPABILITIES: &[&str]`; `pub control_grants: BTreeSet<Str>` on `ExtHostSpec`; a way to pass absolute protected paths into the sandbox spec (builder picks the signature; it must be set from the canonical `<data>/ext` wherever the envd exec sandbox is configured).

- [ ] Failing tests: `identity_carries_control_grants`, `data_authority_never_sees_control_grants`, `sandbox_denies_write_to_protected_store_workspace_write`, `sandbox_denies_write_to_protected_store_off_mode` (protected path placed under a writable root for the first).
- [ ] Red (`omp-envd`), implement, green, clippy, fmt. Commit `feat(envd): carry control grants; protect the grants store in the exec sandbox`.

### Task 3: omp-driver admission (after Task 1 and 2)

**Review:** per-task — security

**Files:** `crates/driver/src/discovery/native.rs` (:219 `RootOrigin`, :576-577, :600-605), plus plumbing that gives admission the data dir, workspace root and writable roots (callers `crates/driver/src/headless/kernel.rs:2490`, `crates/app/src/ext_cli/config.rs:176`).

- [ ] Failing tests: `user_layer_declared_without_grant_gets_none`, `user_layer_matching_grant_yields_control_grant`, `changed_manifest_voids_grant`, `grant_for_other_root_does_not_cover`, `workspace_layer_never_gets_control_grant`, `explicit_root_never_gets_control_grant`, `symlinked_store_fails_closed`, `foreign_owned_store_fails_closed` (skip with a logged reason if the test cannot create another owner), `store_inside_workspace_fails_closed`, `unreadable_store_fails_closed`.
- [ ] Red (`omp-driver`), implement, green, clippy, fmt. Commit `feat(driver): admit control capabilities only with an operator grant`.

### Task 4: omp-app `omp ext grant` (after Task 1; parallel with Task 3)

**Review:** per-task — security

**Files:** `crates/app/src/ext_cli/mod.rs` (next to `trust` :1985, `ExtTrustArgs` :563).

- [ ] Failing tests: `grant_writes_record_admission_accepts` (record satisfies `grant_covers` with the admission inputs from Task 1 functions), `revoke_removes_record`, `grant_refuses_non_user_layer`, `grant_refuses_bad_store`, `grant_without_consent_refuses` (no `--yes`, no terminal).
- [ ] Red (`omp-app`), implement, green, clippy, fmt. Commit `feat(app): omp ext grant issues control grants for user extensions`.

### Task 5: End to end and docs (after Tasks 2-4)

**Files:** a new test in `crates/e2e/tests/`, gated in `justfile` (both e2e recipes) and `.github/workflows/ci.yml`; `crates/e2e/README.md`; `docs/py/12-agents.md`, `docs/py/14-deploy.md`, `docs/adr/TASKS.md`.

- [ ] Test `granted_user_extension_sets_continuation_policy`: in a temp data dir, write the record with the Task 4 writer, admit a user-layer extension with the Task 3 admission, spawn the resulting spec through the e2e harness, call `omp.agents.set_continuation_policy` over real CONTROL: succeeds. `ungranted_user_extension_gets_policy_denied`: same without the record: `omp.PolicyDenied`. If the e2e crate cannot call the driver admission, stop and report why instead of injecting `control_grants` by hand.
- [ ] Docs: how to grant, user-layer only, what voids a grant; TASKS.md: DONE row for operator-granted control capabilities; OPEN rows for DATA grants following manifest declarations in trusted workspaces, binding the code digest (residual risk), and where `omp ext install` site extensions load.
- [ ] Remote green (`omp-e2e`), clippy, fmt. Commit `test(e2e): prove operator-granted continuation authority; docs`.
