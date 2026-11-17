# Operator-granted control capabilities: implementation plan (revision 2, approved 2026-11-17)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a user-layer native extension receives `agents.continuation`, `approvals.decide` or `policy.write` only when its manifest declares it and an operator grant written by `omp ext grant` covers it; nothing an extension or repository controls can create or alter that grant or the granted extension.

**Architecture:** omp-ext validates capability names and owns the path-grant identity; omp-envd carries control grants to CONTROL identities and denies exec writes to the grants store and the user extension root; omp-driver admits control grants for user-layer extensions after checking both locations and the sandbox mode; omp-app issues and revokes grants.

**Spec:** docs/design/continuation-authority.md: "Revision (2026-11-17)", "Revision 2" and its "Amendments" (later sections win on conflict).

## Global Constraints

- Control list exactly `["agents.continuation", "approvals.decide", "policy.write"]`.
- Only `RootOrigin::User` extensions can receive control grants.
- No control grants when the session's exec sandbox mode is Off.
- Protected locations: canonical `<data>/ext` (with `grants.toml`) and the canonical user extension root `<config>/agent/extensions`. Each must not be a symlink, must be owned by the effective user, and must not lie inside the workspace or any exec-writable root; the exec sandbox denies writes to both (lexically if missing).
- Capability names: non-empty, `[a-z0-9._:-]` only, and not starting with `tools.hard:`.
- Path-grant digest: BLAKE3 over `omp.path-grant.v1`, each sorted unique declared capability as u64-LE length + bytes, then the 32-byte manifest digest; `b3:<hex>`. Signed-install `capability_digest` unchanged.
- Grant values: `scope Exact`, `duration Persistent`, `tier Sandboxed`, `ship "path"`, `granted_by "explicit-grant"`, `layer Client`, `workspace None`.
- Any check failure or unreadable store: empty control grants plus `tracing::warn!`; never stop admission.
- DATA grant behaviour unchanged.
- `parking_lot::Mutex`, never `std::sync::Mutex`. No new dependencies.
- Remote only: `OMP_REMOTE_KEYCHAIN_SERVICE=buildbuddy-omp2-trial just remote remote-plain-test <crate>` and `just remote clippy`. Local `cargo fmt --all -- --check` is fine.

## Review Focus

1. `["approvals.decide\nzz"]` cannot load, and `path_grant_digest` differs for `["a","b\nc"]` vs `["a","b","c"]` (Task 1).
2. A process in the exec sandbox cannot write `<data>/ext/grants.toml` or a file under the user extension root, even when both lie under a writable root (Task 2).
3. A symlinked, foreign-owned or workspace-located store or extension root, or sandbox mode Off, yields no control grants (Task 3).
4. A workspace-layer or explicit-root extension never gets a control grant even with a matching record (Task 3).
5. The grant written by the command is exactly what admission checks (Task 5 end to end).

---

### Task 1: omp-ext names, digest, publisher

**Review:** per-task — security

**Files:** `crates/ext/src/config.rs` (`DeploymentManifest::validate` :1699; capabilities :1174), `crates/ext/src/trust.rs` (new fns next to `capability_digest` :1130).

**Produces:** `pub fn path_grant_digest(capabilities: impl IntoIterator<Item = Str>, manifest_digest: &[u8; 32]) -> Str`; `pub fn native_path_publisher(canonical_root: &Path) -> Str`.

- [ ] Failing tests: `capability_name_with_newline_is_rejected`, `capability_name_with_uppercase_or_space_is_rejected`, `valid_capability_names_load`; `path_grant_digest_separates_entries`, `path_grant_digest_binds_manifest`, `path_grant_digest_ignores_order_and_duplicates`; `native_path_publisher_matches_admission_format` (equals `unsigned:path:<blake3 hex of the path text>`, as `native.rs:577` builds it today).
- [ ] Red (`omp-ext`), implement, green, clippy, fmt. Commit `feat(ext): validate capability names; path-grant identity`.

### Task 2: omp-envd control grants and protected paths (parallel with Task 1)

**Review:** per-task — security

**Files:** `crates/envd/src/policy.rs` (`CONTROL_CAPABILITIES`), `crates/envd/src/worker.rs` (:176-206 `control_grants`, :1118 union), `crates/envd/src/exec_sandbox.rs` (absolute protected paths next to `CARVE_OUTS` :37, applied like :1385-1398 via `record_write_deny`; lexical deny :1521-1523 when missing).

**Produces:** `pub const CONTROL_CAPABILITIES: &[&str]`; `pub control_grants: BTreeSet<Str>` on `ExtHostSpec`; a settings field for absolute protected write-deny paths in the exec sandbox (builder picks the name), set by whoever configures the envd exec sandbox.

- [ ] Failing tests: `identity_carries_control_grants`, `data_authority_never_sees_control_grants`, `sandbox_denies_write_to_protected_paths` (both a protected file under a writable root and a protected dir that does not exist yet).
- [ ] Red (`omp-envd`), implement, green, clippy, fmt. Commit `feat(envd): carry control grants; deny exec writes to protected paths`.

### Task 3: omp-driver admission (after Tasks 1 and 2)

**Review:** per-task — security

**Files:** `crates/driver/src/discovery/native.rs` (:219 `RootOrigin`, :576-577, :600-605); plumbing giving admission the data dir, user extension root, workspace root, exec sandbox mode and the exec-writable roots (callers `crates/driver/src/headless/kernel.rs:2490`, `crates/app/src/ext_cli/config.rs:176`); passing the two protected paths into the envd exec sandbox settings.

**Produces:** one shared `fn exec_writable_roots(...) -> Vec<PathBuf>` (workspace, configured writable roots, `TMPDIR`, `/tmp`) and one shared `fn check_protected_location(path, writable_roots) -> Result<(), ProtectedLocationError>` (symlink, owner via `MetadataExt::uid` vs `libc::geteuid`, containment), both `pub` in omp-driver for Task 4.

- [ ] Failing tests: `user_layer_declared_without_grant_gets_none`, `user_layer_matching_grant_yields_control_grant`, `changed_manifest_voids_grant`, `grant_for_other_root_does_not_cover`, `workspace_layer_never_gets_control_grant`, `explicit_root_never_gets_control_grant`, `sandbox_off_yields_no_control_grants`, `no_sandbox_backend_yields_no_control_grants`, `writable_root_inside_protected_location_fails_closed`, `symlinked_store_fails_closed`, `store_inside_workspace_fails_closed`, `extension_root_inside_writable_root_fails_closed`, `symlinked_extension_root_fails_closed`, `foreign_owned_store_fails_closed` (skip with a logged reason if another owner cannot be created), `unreadable_store_fails_closed`.
- [ ] Switch `native.rs:577` to call `native_path_publisher` (Task 1) so admission and issuance share it.
- [ ] Red (`omp-driver`), implement, green, clippy, fmt. Commit `feat(driver): admit control capabilities only with an operator grant`.

### Task 4: omp-app `omp ext grant` (after Task 3's shared fns)

**Review:** per-task — security

**Files:** `crates/app/src/ext_cli/mod.rs` (next to `trust` :1985, `ExtTrustArgs` :563).

- [ ] Failing tests: `grant_writes_record_admission_accepts`, `revoke_removes_record`, `grant_refuses_non_user_layer`, `grant_refuses_bad_store`, `grant_refuses_bad_extension_root`, `grant_without_consent_refuses` (no `--yes`, no terminal).
- [ ] Red (`omp-app`), implement, green, clippy, fmt. Commit `feat(app): omp ext grant issues control grants for user extensions`.

### Task 5: End to end and docs (after Tasks 2-4)

**Files:** a new test in `crates/e2e/tests/`, gated in `justfile` (both e2e recipes) and `.github/workflows/ci.yml`; `crates/e2e/README.md`; `docs/py/12-agents.md`, `docs/py/14-deploy.md`, `docs/adr/TASKS.md`.

- [ ] `granted_user_extension_sets_continuation_policy` and `ungranted_user_extension_gets_policy_denied` through the real flow (Task 4 writer, Task 3 admission, e2e harness spawn, real CONTROL). If the e2e crate cannot call the driver admission, stop and report why instead of injecting `control_grants` by hand.
- [ ] Docs: how to grant, user-layer only, Off mode gives none, what voids a grant; TASKS.md: DONE row; OPEN rows for DATA grants following manifest declarations in trusted workspaces, and where `omp ext install` site extensions load.
- [ ] Remote green (`omp-e2e`), clippy, fmt. Commit `test(e2e): prove operator-granted continuation authority; docs`.
