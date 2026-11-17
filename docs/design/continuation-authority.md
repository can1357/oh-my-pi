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

