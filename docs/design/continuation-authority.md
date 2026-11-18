# Manifest-gated continuation authority

Status: design, awaiting owner approval (2026-11-17). Base: `omp2` at `0ce64b0ba1`.

## Intent

An extension may set its own continuation policy (`omp.agents.set_continuation_policy`) only if the operator granted it continuation authority. Today any extension can, because `ContinuationAwareAgentsAuthority::authorize` (`crates/envd/src/tools/continuation.rs:368-385`) returns `Ok(())` for both continuation operations after only the stale-connection check. The spec (`docs/py/12-agents.md:840-842`) says the call is fail-closed and raises `PolicyDenied` when the manifest did not grant continuation authority. `docs/adr/TASKS.md:191` lists this as remaining work.

## Owner decisions (2026-11-17)

1. The grant is named `agents.continuation`, dotted like `policy.write` and `approvals.decide` (`crates/envd/src/policy.rs:288-290`).
2. Only `omp.agents.set_continuation_policy` is gated. `omp.agents.continuations()` (a read) stays open to every extension. A `Continue` returned from an `agent_settled` hook is not gated; the core cap of 8 still bounds it.
3. A denial uses code `PolicyDenied`, with details `{"reason": ..., "code": "capability_denied", "decision_id": "", "rules": []}`. Python's existing mapping (`crates/py/python/omp/agents.py:266`) then raises `omp.PolicyDenied` with that reason and code.
4. A policy declared in the manifest and applied at load is out of scope; it stays OPEN in `TASKS.md`.

## Non-goals

- No change to how grants are issued, stored or pinned. Grants already arrive as `ControlConnectionIdentity.capabilities` (`crates/envd/src/exthost/control.rs`), operator-issued and digest-pinned (`docs/py/14-deploy.md:430-431`).
- No change to `continuations()`, to `Continue` handling, or to the ledger.
- No new manifest field, stored format or convar.

## Design

- Add `pub const CONTINUATION_CAPABILITY: &str = "agents.continuation";` in `crates/envd/src/tools/continuation.rs`, with a doc comment naming the operation it guards.
- In `authorize`, after the stale-connection check: for `omp.agents.set_continuation_policy`, if `context.connection.capabilities` does not contain `CONTINUATION_CAPABILITY`, return `ControlProtocolError::new("PolicyDenied", <message>).with_details(<details above>)`. The message and `reason` say that continuation authority (`agents.continuation`) is not granted to this extension. `omp.agents.continuations` keeps returning `Ok(())`.
- `request` already calls `authorize` first, so a denied call never reaches the ledger. The ledger is unchanged.
- The check reads the grant from `context.connection`, which `authorize` has already proven equal to the bound identity, so the two cannot disagree.

## Tests (written first, failing on `omp2`)

In the test module of `crates/envd/src/tools/continuation.rs`, through `ContinuationAwareAgentsFactory::bind` with a stub inner factory:

1. `set_policy_without_grant_is_policy_denied`: an identity without `agents.continuation` calling `set_continuation_policy` gets code `PolicyDenied`, details `code == "capability_denied"`, and the ledger policy for that extension stays the default.
2. `set_policy_with_grant_is_applied`: with the grant, the same call returns `Ok(null)` and the policy is stored.
3. `reading_continuations_needs_no_grant`: `continuations` without the grant returns the snapshot.

Python: in `crates/py/tests/agents_runtime_contract.rs`, the fake CONTROL server answers `set_continuation_policy` with a `PolicyDenied` error carrying those details; assert that `omp.agents.set_continuation_policy(...)` raises `omp.PolicyDenied` with `code == "capability_denied"`.

## Docs

- `docs/py/12-agents.md:840-842`: name the grant (`agents.continuation`) and the `capability_denied` code.
- `docs/py/14-deploy.md`: add `agents.continuation` where manifest capabilities are listed, if such a list exists; otherwise one sentence next to the `capabilities = [...]` example.
- `docs/adr/TASKS.md:191`: drop "manifest-gated continuation authority" from the PARTIAL row's remaining list, and add a DONE row naming the grant and the tests. Manifest-declared policy at load stays listed as remaining.

## Risk

Existing extensions that call `set_continuation_policy` without the grant start getting `PolicyDenied`. That is the intended fail-closed behaviour from the spec. Their `Continue` replies keep working under the core cap and default policy.

## Revision (2026-11-17): control grants come only from operator grant records

### Why

The security review of the gate found that a CONTROL identity's capabilities are copied from `spec.data_grants` (`crates/envd/src/worker.rs:1118`), which native admission fills from the manifest's *declared* capabilities filtered to the DATA list (`crates/driver/src/discovery/native.rs:604`, `crates/envd/src/policy.rs:37-80`). So `agents.continuation` never reaches an identity, and the gate denies every extension. Copying control grants from the manifest would be worse: any extension in a trusted workspace's `.omp/extensions` could declare `agents.continuation`, `policy.write` or `approvals.decide` and receive it, breaking `docs/py/14-deploy.md:430-431` (declared is not granted) and `:138` (grants come from the operator, never the repository).

### Owner decisions (2026-11-17)

1. A control capability reaches an extension only if its manifest declares it **and** an operator grant record covers it.
2. Include a way to issue that grant for native path extensions.
3. DATA grants keep their current behaviour; record the gap as OPEN in `TASKS.md`.

### Design

- **Control list.** `CONTROL_CAPABILITIES = ["agents.continuation", "approvals.decide", "policy.write"]` in `crates/envd/src/policy.rs`, next to the DATA `CAPABILITIES`. `CONTINUATION_CAPABILITY`, `POLICY_WRITE_CAPABILITY` and `APPROVAL_DECIDE_CAPABILITY` stay the names the checks use.
- **One identity function, shared.** The native publisher synthesis (`unsigned:path:<blake3(root)>`, now inline at `native.rs:577`) moves to a `pub fn` in `omp-ext` next to `grant_covers`, so admission and the issuing command compute the same publisher. The capability digest is the manifest projection's existing `capability_digest` (`crates/ext/src/config.rs:1821`), which covers the whole declared set, so any change to the declared capabilities voids the grant.
- **Admission check** (`native.rs`, next to `spec.data_grants`). Let `wanted` = declared capabilities that are in `CONTROL_CAPABILITIES`. If `wanted` is empty, do nothing. Otherwise read `GrantsFile::read(grants_path(data_dir))` (`crates/ext/src/trust.rs:38`, `:468`; a missing file means no grants) and call `grant_covers(grants, id, publisher, layer, workspace, capability_digest, TrustTier::Sandboxed, "path")` (`:341`). Layer is Client for explicit and user roots, Workspace (with the project's `WorkspaceUri`) for `.omp/extensions`. If it covers, `spec.control_grants = wanted`; otherwise empty. A grants file that cannot be read gives empty control grants and a `tracing::warn!` naming the extension and the path; never an error that stops admission.
- **Identity.** `ExtHostSpec` gets `control_grants` (default empty). `control_connection_identity` (`worker.rs:1118`) sets `capabilities` to `data_grants` plus `control_grants`. The DATA uses of `data_grants` (`worker.rs:1084`, `:1818`, `crates/envd/src/lib.rs:1612`) are unchanged, so DATA authority never sees control names.
- **Issuing: `omp ext grant <DIR>`.** Loads the manifest at DIR, computes id, publisher and digest with the shared functions, picks the layer from DIR (Workspace if under the current project's `.omp/extensions`, else Client), prints the declared capabilities with the control ones marked, and asks for explicit consent (`--yes` skips the prompt). Writes `Grant { scope: Exact, duration: Persistent, tier: Sandboxed, ship: "path", granted_by: "explicit-grant", ... }` through `GrantsFile::try_update` (the locked, atomic writer, `trust.rs:510-540`), replacing any grant with the same key. `--revoke` removes it.

### Non-goals

- DATA grants (OPEN in `TASKS.md`).
- Grants for signed index installs (the existing `omp ext install` flow is unchanged).
- Where `omp ext install`'d extensions in `<state>/ext/sites/` are loaded at runtime: not found during this work; recorded as an open question.

### Tests

- `omp-ext`: the shared publisher function is stable for one root and differs for another.
- `omp-driver` (native admission): declared `agents.continuation` with no grant gives empty control grants; with a matching grant gives `{agents.continuation}`; with a grant for a different digest (manifest changed) or a different root gives empty; an unreadable grants file gives empty.
- `omp-envd`: an identity built from a spec with `control_grants` carries them; DATA authority registration still gets only `data_grants`.
- `omp-app`: `omp ext grant DIR --yes` writes a grant that `grant_covers` accepts with the admission's inputs; `--revoke` removes it; without `--yes` and without a terminal it refuses.
- `omp-e2e`: a harness extension whose spec carries `control_grants = {agents.continuation}` can call `omp.agents.set_continuation_policy` through real CONTROL; without it, `omp.PolicyDenied`.

### Calls made by the author

- `--revoke` is included, because an operator must be able to undo a security grant.
- `ship = "path"` for native path extensions.
- An unreadable grants file fails closed with a warning instead of stopping the session.


## Revision 2 (2026-11-17): after the Codex security review

The first revision was reviewed by Codex (CONCERNS: one blocker, five major). The owner chose the fixes below. Where this section and "Revision (2026-11-17)" disagree, this section wins.

### Findings and decisions

1. **Forgeable digest (blocker).** `capability_digest` joins entries with newlines and capability names are not validated (`crates/ext/src/trust.rs:1130-1141`, `crates/ext/src/config.rs:1699-1821`), so `["approvals.decide\nzz"]` hashes like two entries. Decision: reject capability names outside `[a-z0-9._-]+` (non-empty) in `DeploymentManifest::validate` (`config.rs:1699`), and give path grants their own length-prefixed digest. The digest used by signed installs is unchanged, so existing install grants keep working.
2. **An extension's own commands can rewrite `grants.toml` (major).** `env.exec` is self-declared, and the exec sandbox only carves out `.git`, `.omp` and `.agents` under each writable root (`crates/envd/src/exec_sandbox.rs:37`, `:1385-1398`); Off mode makes `/` writable (`:1400-1401`). Decision: the sandbox always denies writes to the canonical `<data>/ext`, in every mode that builds a sandbox spec, including Off. This PR.
3. **Unchecked store location (major).** `OMP_DATA_DIR`, `XDG_DATA_HOME` and `--data-dir` accept any path (`crates/core/src/dirs.rs:40-52`, `:244-257`), and `GrantsFile::read` follows symlinks without an owner check (`trust.rs:468-482`). Decision: no control grants, with a warning, if `<data>/ext` or `grants.toml` resolves inside the workspace root or any configured writable root, either is a symlink, or either is not owned by the effective user.
4. **Path is a weak identity (major) and 5. layer rules conflict (major).** Decision: only **user-layer** extensions (`<config>/agent/extensions`, `RootOrigin::User`, `crates/driver/src/discovery/native.rs:219`, `:283`) can receive control grants. Workspace and explicit-root extensions never do. The grant binds the canonical root path and the manifest digest. This removes the layer conflict and the workspace self-grant path.
6. **Tests miss real failures (major).** Decision: add the forged-digest, extension-writes-store, symlinked store and root, and layer cases, and one end-to-end test through the real flow: write the grant, admit the extension, call over CONTROL.

### Design (replaces the corresponding parts of the first revision)

- **Names.** `DeploymentManifest::validate` rejects any base or feature capability name that is empty or contains a character outside `[a-z0-9._-]`, with `ExtensionError::new(ExtensionCode::EManifestParse, ...)` naming the capability. A manifest that fails this no longer loads.
- **Path-grant digest.** `pub fn path_grant_digest(capabilities: impl IntoIterator<Item = Str>, manifest_digest: &[u8; 32]) -> Str` in `crates/ext/src/trust.rs`: BLAKE3 over the domain tag `omp.path-grant.v1`, then each sorted, deduplicated capability as an 8-byte little-endian length followed by its bytes, then the 32-byte manifest digest; rendered `b3:<hex>`. The manifest digest is BLAKE3 of the manifest text (`native.rs:576`), so any manifest edit voids the grant.
- **Publisher.** `pub fn native_path_publisher(canonical_root: &Path) -> Str` in `trust.rs`, returning today's exact value (`native.rs:577`), called by both admission and the grant command. The root passed in is always canonical.
- **Admission** (`native.rs`, next to `spec.data_grants`). Only for `RootOrigin::User`. Let `wanted` = declared capabilities in `CONTROL_CAPABILITIES`. If `wanted` is empty, nothing. Otherwise: run the store checks; on any failure, empty control grants plus `tracing::warn!` naming the extension, the path and the reason. Else read `GrantsFile` and call `grant_covers(grants, id, publisher, Layer::Client, None, path_grant_digest(declared, manifest_digest), TrustTier::Sandboxed, "path")`. If covered, `spec.control_grants = wanted`.
- **Store checks** (in omp-driver, which has `libc`): `<data>/ext` and `grants.toml` (if present) must not be symlinks (`symlink_metadata`), must be owned by `libc::geteuid()` (`MetadataExt::uid`), and their canonical paths must not start with the canonical workspace root or any configured writable root. A missing `grants.toml` means no grants (not an error).
- **Sandbox.** The exec sandbox spec gets an absolute protected-path list holding canonical `<data>/ext`, applied with the same `record_write_deny` machinery as the carve-outs, in every mode including Off.
- **Identity.** Unchanged from the first revision: `ExtHostSpec.control_grants` (default empty), unioned into the CONTROL identity at `worker.rs:1118`; DATA uses of `data_grants` untouched.
- **Issuing.** `omp ext grant <NAME>` (and `--revoke`) accepts only an extension installed under `<config>/agent/extensions`; anything else is refused with a message saying control grants are user-layer only. It runs the same store checks before writing and refuses on failure. It writes through `GrantsFile::try_update` with `scope Exact`, `duration Persistent`, `tier Sandboxed`, `ship "path"`, `granted_by "explicit-grant"`, `layer Client`, `workspace None`.

### Residual risk

Replacing the extension's code at the same user-layer path while keeping the manifest byte-identical keeps the grant. Writing to `<config>/agent/extensions` already requires the operator's account, and the sandbox does not make that directory writable to extensions unless it lies under a writable root; the store checks do not cover the extension directory itself. Recorded in `TASKS.md` as OPEN (bind the code digest too).


### Amendments after the second Codex review (approved 2026-11-17)

- **Off mode.** With the exec sandbox mode `off`, `compile` builds no filesystem sandbox (`crates/envd/src/exec_sandbox.rs:357-364`), so nothing can protect the store. Admission gives **no control grants** when the session's exec sandbox mode is Off, and logs a warning saying why. Off keeps its current meaning.
- **Extension root.** `OMP_CONFIG_DIR` can place `<config>/agent/extensions` anywhere (`crates/core/src/dirs.rs:95-98`). The store checks (not inside the workspace or an exec-writable root, not a symlink, owned by the effective user) apply to the user extension root as well as to `<data>/ext`, and the exec sandbox denies writes to both. Any failure gives no control grants. This replaces the "Residual risk" paragraph above, which was wrong.
- **Declared set.** The path-grant digest covers the full declared capability set (`projection.capabilities`); only its control subset is granted.
- **Exec-writable roots.** One shared function computes what the session's exec sandbox can write: the workspace, the configured writable roots, `TMPDIR` and `/tmp`. Admission and `omp ext grant` both call it.
- **Passing paths to envd.** The driver passes the canonical `<data>/ext` and user extension root into envd's exec sandbox configuration. A path that does not exist yet is denied lexically (`deny_write_lexical`, `exec_sandbox.rs:1521-1523`). A remote envd runs commands on another machine and cannot write these local files.


### Amendments 2 (after the Task 1 and Task 2 security reviews, 2026-11-17)

- **Hashes.** `Hash32::sum` is SHA-256 (`crates/core/src/hash32.rs`). The native publisher (`unsigned:path:<hex>`, `native.rs:577`) and the manifest digest (`native.rs:576`) are SHA-256, and `native_path_publisher` keeps that exact value. Only `path_grant_digest` uses BLAKE3, so its `b3:` prefix is accurate. Earlier text saying "blake3(root)" or "BLAKE3 of the manifest text" is wrong.
- **Name rule (owner decision).** Capability names are non-empty and use only `[a-z0-9._:-]`, and must not start with `tools.hard:`. The colon is allowed because `schedules:project` is an existing capability (bundled extensions, the Python SDK, the conformance script).
- **Admission also withholds control grants when** (ruling, extending the owner's fail-closed decisions): a protected location *contains* an exec-writable root (the sandbox cannot deny it without denying the workspace), or no kernel-enforced exec sandbox is running (mode Off, or no sandbox backend on the host).
- **Daemon policy digest.** The new protected-paths sandbox setting is skipped when empty, so daemon policy digests are unchanged for sessions without protected paths.


### Amendments 3 (after the Task 3+4 security review, 2026-11-18)

- **Daemon policy digest (supersedes the Amendments 2 bullet of the same name).** `SandboxSettings::from_con` (`crates/envd/src/exec_settings/sandbox.rs`) derives the host-protected paths, `<data>/ext` and `<config>/agent/extensions`, for every local session, so the protected-paths setting is no longer empty and session digests change versus pre-change builds. The Amendments 2 statement that digests are unchanged now holds only for settings built without host paths (`SandboxSettings::default()`, or a host whose data directory does not resolve). There is no `DOMAIN` bump: the socket name is the build generation plus the keyed digest, and stale owners are retired.
