# agent_settled dispatch to Python hooks: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Python `agent_settled` hooks run when the agent settles, the first `Continue` keeps the agent going with its prompt as context, and the core stops after 8 consecutive continuations.

**Architecture:** envd attaches a `NativeHookHost` for `agent_settled` to each session's admission gate. On settle it calls the session's Python rows in order through the provider-domain callback path and returns the first Continue as `HookContext`. The agent loop counts continuations per submission, reports the count in the payload, and refuses further continuation at 8.

**Tech Stack:** Rust (omp-contract, omp-agent, omp-envd), tokio. No Python or wire change.

**Spec:** docs/design/agent-settled-dispatch.md

## Global Constraints

- No wire-format, schema or revision change; `AgentSettledEvent::REV` stays 2.
- No change to crates/driver/src/plugin_hooks.rs.
- No new configuration, convar or stored format.
- Cap value: 8, equal to `SETTLE_CONTINUATION_CAP` in crates/py/python/omp/limits.py:58.
- Not in this slice: `role`, `visible`, `collapse_prior`, veto, `ContinuationPolicy`.
- Compile and test remotely only (skill remote-build-verification): `OMP_REMOTE_KEYCHAIN_SERVICE=buildbuddy-omp2-trial just remote remote-plain-test <crate>`. Formatting: `cargo fmt --all -- --check`.

## Review Focus

1. A hook returns `Continue(prompt="")`: treated as Settle, not an empty context (Task 2, `empty_prompt_is_settle`).
2. An extension reloads mid-session: rows of the old session generation are not called (Task 2, `rows_of_another_generation_are_skipped`).
3. A hook hangs: its timeout counts as Settle and the next hook still runs (Task 2, `failed_call_counts_as_settle_and_the_next_hook_runs`).
4. No Python hook subscribes: the host returns Defer and plugin Stop hooks behave exactly as before (Task 3, `no_python_rows_defers`).
5. The turn is cancelled while a hook runs: the settle path ends with the cancellation, as provider domain hooks do; no new test, the reviewer checks Task 3 adds no task that outlives the turn.

---

### Task 1: Core continuation cap in the agent loop

**Files:**
- Modify: `crates/contract/src/hooks.rs` (constant next to `AgentSettledEvent`, :327-337; test in its test module)
- Modify: `crates/agent/src/loop.rs:2052-2071`
- Test: `crates/agent/tests/lifecycle_hooks.rs`

**Interfaces:**
- Produces: `pub const SETTLE_CONTINUATION_CAP: u32 = 8;` in omp-contract (re-export through omp-agent where `AgentSettledEvent` is re-exported).

- [ ] **Step 1: Write the failing tests**

In crates/contract/src/hooks.rs tests:
```rust
#[test]
fn settle_cap_matches_the_python_limit() {
    let limits = include_str!("../../py/python/omp/limits.py");
    assert_eq!(SETTLE_CONTINUATION_CAP, 8);
    assert!(limits.contains("SETTLE_CONTINUATION_CAP: Final[int] = 8"));
}
```
In crates/agent/tests/lifecycle_hooks.rs, with a native host attached for `agent_settled` that always returns `NativeVerdict::Continue` with one `HookContext` and records each payload (follow `StartHost`, :1151):
- `settle_cap_stops_continuation_after_eight`: one submission ends settled; the host was called exactly 8 times.
- `continuations_used_counts_up_from_zero`: the recorded `continuations_used` values are `[0, 1, 2, 3, 4, 5, 6, 7]`.
- `a_new_submission_starts_the_count_again`: a second submission's first payload has `continuations_used` 0.

- [ ] **Step 2: Run them; they fail** (`settle_cap_matches_the_python_limit` does not compile; the loop never stops continuing).

`OMP_REMOTE_KEYCHAIN_SERVICE=buildbuddy-omp2-trial just remote remote-plain-test omp-agent` and `... omp-contract`.

- [ ] **Step 3: Implement.** Add the constant. In the loop, keep a `u32` counter per submission: pass it as `continuations_used`; when it equals `SETTLE_CONTINUATION_CAP`, settle without calling `agent_settled`; increment on each Continue.

- [ ] **Step 4: Run the tests; they pass.** Same commands; then `cargo fmt --all -- --check`.

- [ ] **Step 5: Commit** `feat(agent): cap consecutive agent_settled continuations at 8`.

### Task 2: Settled reply decoding, row selection and first-Continue fold

**Files:**
- Create: `crates/envd/src/tools/settled.rs` (declared from crates/envd/src/tools/mod.rs)
- Test: unit tests in the same file

**Interfaces:**
- Produces:
  - `pub(crate) struct SettledContinue { pub prompt: Str, pub label: Option<Str> }`
  - `pub(crate) fn decode_settled_reply(reply: &JsonValue) -> Option<SettledContinue>`: `Some` only for an object whose `prompt` is a non-empty string; `label` when it is a string.
  - `pub(crate) fn settled_rows(rows: &[HookSubscription], session: &str, session_generation: u64) -> Vec<HookSubscription>`: keeps `event == "agent_settled"`, `phase == "domain"`, matching `session` and `identity.session_generation`; sorted by `(identity.layer, identity.extension, order, name)`.
  - `pub(crate) async fn first_continue<F, Fut>(rows: &[HookSubscription], call: F) -> NativeReply where F: FnMut(&HookSubscription) -> Fut, Fut: Future<Output = Option<JsonValue>>`: calls rows in order; `None` (error, timeout, skipped) or a non-Continue reply moves on; the first Continue returns `NativeVerdict::Continue` with `HookContext { source: label or identity.extension, body: prompt }`; none returns `NativeVerdict::Defer` with no context.

- [ ] **Step 1: Write the failing tests**
- `continue_object_decodes`: `{"prompt":"go on","label":"lint","visible":false,"role":"system","collapse_prior":true}` gives prompt `go on`, label `lint`.
- `settle_none_and_junk_decode_as_settle`: `{}`, `null`, `{"prompt":3}`, `"continue"` give `None`.
- `empty_prompt_is_settle`: `{"prompt":""}` gives `None`.
- `rows_are_ordered_and_filtered`: rows for two extensions (`b-ext` order 0, `a-ext` order 1 and 0), another event, another phase and another session come back as `a-ext/0`, `a-ext/1`, `b-ext/0` only.
- `rows_of_another_generation_are_skipped`.
- `first_continue_wins`: replies Settle, Continue("x"), Continue("y") give context body `x`; the third row is never called.
- `failed_call_counts_as_settle_and_the_next_hook_runs`: `None` then Continue("z") gives `z`.
- `no_continue_defers`.

- [ ] **Step 2: Run; they fail** (module does not exist). `... remote-plain-test omp-envd`.
- [ ] **Step 3: Implement the four items.**
- [ ] **Step 4: Run; they pass.** Then `cargo fmt --all -- --check`.
- [ ] **Step 5: Commit** `feat(envd): decode and order agent_settled hook replies`.

### Task 3: The envd host, attached to each session gate

**Review:** per-task — concurrency

**Files:**
- Modify: `crates/envd/src/tools/hooks.rs` (method on `HookControlFactory`, next to `dispatch_provider_domain`, :784)
- Modify: `crates/envd/src/tools/settled.rs` (host type)
- Modify: `crates/envd/src/server/session.rs` (attach where the admission gate is taken, :432; and at :719 if that path builds a separate session)
- Test: `crates/envd/src/tools/hooks.rs` test module

**Interfaces:**
- Consumes: Task 2's `settled_rows`, `first_continue`, `decode_settled_reply`.
- Produces:
  - `impl HookControlFactory { pub(crate) async fn dispatch_agent_settled(&self, session: &Str, session_generation: u64, payload: &JsonValue) -> NativeReply }`: takes the rows from `self.subscriptions`, applies `check_hook_event_revision` with `AgentSettledEvent::REV` (a rejected row is skipped), and calls each through `self.callbacks.dispatch_provider_hook` exactly as `dispatch_provider_domain` does (same context, `phase: "domain"`, timeout `row.timeout.unwrap_or(row.event_policy.timeout)`); an `Err` becomes `None`.
  - `pub(crate) struct AgentSettledHost` implementing `NativeHookHost`: `decide` calls `dispatch_agent_settled` for `agent_settled` and returns `Defer` for any other event.

- [ ] **Step 1: Write the failing tests**
- `no_python_rows_defers`: with no rows, `dispatch_agent_settled` returns `Defer` and no callback runs.
- `stale_revision_row_is_skipped`: a row whose policy declares revision 1 is not called.
- `session_gate_has_the_settled_host`: after a session is set up as in session.rs, `LifecycleHooks::agent_settled` reaches `AgentSettledHost` (assert through a row whose callback replies Continue("x") and the returned context body `x`). If the test module cannot stand up the callbacks, move this assertion to Task 4's end-to-end test and say so in the commit message.

- [ ] **Step 2: Run; they fail.** `... remote-plain-test omp-envd`.
- [ ] **Step 3: Implement** the method and host, and attach the host once per session gate with `attach_native(host, &[agent_settled event id])`.
- [ ] **Step 4: Run; they pass**, and `... remote-plain-test omp-agent` still passes. Then `cargo fmt --all -- --check`.
- [ ] **Step 5: Commit** `feat(envd): dispatch agent_settled to Python extension hooks`.

### Task 4: End-to-end proof and documentation

**Files:**
- Test: `crates/e2e/tests/p9_extension_control.rs` (or a sibling file in the same style)
- Modify: `docs/adr/TASKS.md`, `docs/py/05-hooks.md`, `docs/py/12-agents.md`

- [ ] **Step 1: Check the harness.** Read p9_extension_control.rs. If it can host a Python extension and drive a turn to settle, write `python_agent_settled_continue_runs_one_more_turn`: an extension whose `agent_settled` hook returns `Continue(prompt="one more")` once and then `Settle()`; assert the agent ran one extra turn and the context `one more` was appended. If it cannot, write no test and add a TASKS.md row saying the end-to-end proof is open and why.
- [ ] **Step 2: Run** `... remote-plain-test omp-e2e` (when the test exists); it passes.
- [ ] **Step 3: Docs.** TASKS.md: replace the "not dispatched" entry with what is now honored, and add open rows for `role`/`visible`/`collapse_prior`, veto, `ContinuationPolicy`, and the hook-order divergence (envd orders by `(layer, extension, order, name)`; docs say `(layer, publisher, extension_id)`). In 05-hooks.md and 12-agents.md, mark those fields and the veto as not yet honored.
- [ ] **Step 4: Commit** `docs: record agent_settled dispatch and its open parts`.
