# Manifest-gated continuation authority: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `omp.agents.set_continuation_policy` raises `PolicyDenied` unless the extension holds the `agents.continuation` grant.

**Architecture:** one capability check in `ContinuationAwareAgentsAuthority::authorize`, reading the grant set envd already attaches to each CONTROL connection.

**Tech Stack:** Rust (omp-envd), the embedded Python package's contract test (omp-py).

**Spec:** docs/design/continuation-authority.md

## Global Constraints

- Grant name exactly `agents.continuation`.
- Error code exactly `PolicyDenied`; details exactly `{"reason": <str>, "code": "capability_denied", "decision_id": "", "rules": []}`.
- Only `omp.agents.set_continuation_policy` is gated.
- No manifest field, stored format or convar change.
- Use `parking_lot::Mutex`, never `std::sync::Mutex`.
- Compile and test remotely only: `OMP_REMOTE_KEYCHAIN_SERVICE=buildbuddy-omp2-trial just remote remote-plain-test <crate>`; also `just remote clippy` before the PR, because remote test runs do not run clippy. Local `cargo fmt --all -- --check` is fine.

## Review Focus

1. A grant spelled differently (`agents.continuations`, `agent.continuation`) does not authorize (Task 1, `set_policy_without_grant_is_policy_denied` uses an identity holding only `agents.continuations`).
2. A denied call leaves the ledger untouched (Task 1, same test asserts the stored policy is the default).

---

### Task 1: Gate set_continuation_policy

**Review:** per-task — security

**Files:**
- Modify: `crates/envd/src/tools/continuation.rs` (constant; `authorize` at :368-385; test module at :412)
- Modify: `crates/py/tests/agents_runtime_contract.rs` (fake server near :61-89, assertions near :218)
- Modify: `docs/py/12-agents.md`, `docs/py/14-deploy.md`, `docs/adr/TASKS.md`

**Interfaces:**
- Produces: `pub const CONTINUATION_CAPABILITY: &str = "agents.continuation";`

- [ ] **Step 1: Write the failing tests.** In the continuation test module, add a stub inner `ControlAuthorityFactory` (handles nothing) and identity/context helpers modelled on `crates/envd/src/exthost/control.rs:3857-3873`. Tests:
  - `set_policy_without_grant_is_policy_denied`: identity capabilities `{"agents.continuations"}`; `request(context, "omp.agents.set_continuation_policy", {policy: {max_consecutive: 3, ...}})` returns Err with `code == "PolicyDenied"` and `details["code"] == "capability_denied"`; `book.policy_for("dev.example.demo") == ContinuationPolicy::default()`.
  - `set_policy_with_grant_is_applied`: capabilities `{"agents.continuation"}`; returns `Ok(Value::Null)`; `book.policy_for(...).max_consecutive == 3`.
  - `reading_continuations_needs_no_grant`: no capabilities; `omp.agents.continuations` returns Ok.
  In `agents_runtime_contract.rs`: give `RecordingControl` a `deny_continuation_policy` flag; when set, `request("omp.agents.set_continuation_policy", ...)` raises `omp._host.ControlProtocolError("PolicyDenied", "continuation authority not granted", details={"reason": "continuation authority (agents.continuation) is not granted", "code": "capability_denied", "decision_id": "", "rules": []})` (constructor at `crates/py/python/omp/_host.py:66`). Assert `omp.agents.set_continuation_policy(...)` then raises `omp.PolicyDenied` with `code == "capability_denied"`. Keep the existing allowed call (`:218-219`) passing with the flag unset.
- [ ] **Step 2: Run them; the first fails** (`set_policy_without_grant_is_policy_denied` gets Ok). `... remote-plain-test omp-envd`; the Python assertion runs under `... remote-plain-test omp-py`.
- [ ] **Step 3: Implement** the constant and the check in `authorize`.
- [ ] **Step 4: Run** `omp-envd` and `omp-py` remotely, both pass; `just remote clippy`; `cargo fmt --all -- --check`.
- [ ] **Step 5: Docs** as listed in the spec's Docs section.
- [ ] **Step 6: Commit** `feat(envd): require agents.continuation to set a continuation policy`.
