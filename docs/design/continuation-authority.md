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
