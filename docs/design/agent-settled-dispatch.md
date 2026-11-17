# Dispatching `agent_settled` to Python extension hooks

Status: design, awaiting owner approval (2026-11-16). Base: `omp2` at `1a32fad0df`.

## Intent

A Python extension can subscribe to `agent_settled` and, by returning `Continue(prompt=...)`, keep the agent working after it would otherwise stop (docs/py/12-agents.md:744-790, docs/py/05-hooks.md:1398-1430). Today no Python `agent_settled` hook ever runs. The event is marked as subscribed, receives nothing, and the gate settles. PR #667 fixed the event's revision stamp and recorded this gap in docs/adr/TASKS.md; this design closes it.

## Why it fails today

- `LifecycleHooks::agent_settled` (crates/contract/src/hooks.rs:969) asks native hosts first; the first `NativeVerdict::Continue` wins and its `HookContext` reaches the model. Otherwise it calls `HookGate::gate_domain`.
- `HookGate::gate_domain` (hooks.rs:1554) loops only over subscriptions registered locally with `HookGate::subscribe` (hooks.rs:1248). Unlike `HookGate::gate` (hooks.rs:1382), it has no delegated path (`gate_delegated`, hooks.rs:1452) that hands the event to envd.
- envd never registers local subscriptions on the agent's gate. It only publishes masks (`replace_masks`, crates/envd/src/tools/hooks.rs:641). So `gate_domain` finds no subscriber and the gate's fail-open default, Settle, wins.

## Goals

1. A Python hook subscribed to `agent_settled` is called when the agent settles, with the revision-2 payload.
2. Hooks run in documented order, (layer, publisher, extension_id), and the first `Continue` wins. Its `prompt` reaches the model as hook context, with `label` (or the extension id) as the context's source.
3. A hook that raises or times out counts as `Settle` (fail-open), as documented.
4. The core refuses continuation after 8 consecutive continuations in one submission (`omp.limits.SETTLE_CONTINUATION_CAP`), whatever their source.
5. The payload's `continuations_used` reports the real count instead of the hard-coded `0` (crates/agent/src/loop.rs:2062).

## Non-goals (later slices, documented as not yet honored)

- `Continue` fields `role`, `visible` and `collapse_prior`.
- Veto: later hooks seeing `ctx.pending_continuation` and returning `Settle()`.
- Per-extension `ContinuationPolicy` and the continuation ledger.
- A delegated path in `gate_domain` for other domain events.

## Anti-goals

- No wire-format or schema change: `AgentSettled`'s domain return stays `continue`/`settle` bytes; no new revision.
- No change to Claude-style plugin hooks (crates/driver/src/plugin_hooks.rs), including their own cap of 8 (`STOP_CONTINUATION_CAP`, :110).
- No new configuration, convar or stored format.

## Approaches considered

- **A, chosen by the owner:** envd attaches a `NativeHookHost` for `agent_settled` to the agent's gate, the same way plugin hooks do (`attach_native`, hooks.rs:1282; plugin_hooks.rs:310 and :682-717). The host selects the subscribed Python rows and calls them the way `dispatch_provider_domain` (envd tools/hooks.rs:784-877) calls provider domain hooks. Its `NativeReply` carries the prompt as `HookContext`, so no wire change is needed.
- **B, rejected:** give `gate_domain` a delegated path and have envd answer `GateDecision::Domain`. It is more general, but the domain reply is only `continue`/`settle` bytes, so carrying the prompt would need a wire change.

## Decided design

**envd host.** A new `NativeHookHost` in envd, owned by `HookControlFactory` (crates/envd/src/tools/hooks.rs):
- It is attached to the session's admission gate for `HookEventId` of `agent_settled` only, at the point where envd publishes the session's masks, and only when at least one Python row subscribes to `agent_settled`. It is re-attached or detached whenever the masks are replaced, so it follows extension reloads.
- On `agent_settled`, it selects rows with event `agent_settled` and phase `domain`, sorted by `(layer, extension, order, name)`: provider domain dispatch's order without the trust tier, because envd has no publisher (see Answers from the code). The divergence from the documented `(layer, publisher, extension_id)` order is recorded in docs/adr/TASKS.md.
- It calls the hooks one at a time in that order through the same worker callback path `dispatch_provider_domain` uses, with the payload the loop built, and applies `check_hook_event_revision` (envd tools/hooks.rs) so a row declaring the wrong revision is skipped with the existing warning. It keeps only rows of the current session generation, as `compose` does.
- The first reply that decodes as `Continue` wins: the host returns `NativeVerdict::Continue` with one `HookContext { source: label or extension id, body: prompt }`. `Settle`, `None`, a raise, a timeout or an undecodable reply counts as `Settle`, and the host moves on. If no hook continues, it returns `Defer`, so the gate's existing path decides.

**Core cap.** The agent loop (crates/agent/src/loop.rs:2052-2071) counts consecutive `Continue` outcomes for the current submission. It passes the count as `continuations_used` and, when the count reaches 8, does not call `agent_settled` at all and settles. The count resets when a new user submission starts. The limit is a named constant equal to `omp.limits.SETTLE_CONTINUATION_CAP`, with a test that pins the two together.

## Tests (written first, failing on `omp2`)

1. envd: a Python-style row subscribed to `agent_settled` that replies `Continue(prompt="x")` makes `LifecycleHooks::agent_settled` return Continue with context body `x`. Fails today because nothing dispatches.
2. envd: with two rows, the first returns `Settle` and the second `Continue`; the second's prompt wins. With the first raising, the second still runs.
3. envd: a row that times out counts as `Settle`.
4. agent loop: after 8 consecutive continuations the loop settles without calling `agent_settled`, and the payload reports `continuations_used` 0 through 7.
5. Contract: the Rust cap constant equals the Python `SETTLE_CONTINUATION_CAP`.
6. End to end, if the harness allows: a real Python extension returning `Continue` keeps the agent going for one more turn.

## Answers from the code (builder check, 2026-11-16)

- **Reply encoding; Rust only.** A Python domain hook's return value is encoded by `_wire_value` (crates/py/python/omp/hooks.py:889-922, called from `_dispatch_hook_callback`, :1034-1101). Dataclasses become objects of their public fields. `Continue` (crates/py/python/omp/agents.py:387) arrives as `{"prompt", "visible", "role", "label", "collapse_prior"}`, `Settle` as `{}`, `None` as `null`, and a raise as an `Err` from `dispatch_provider_hook`. Decode rule: an object whose `prompt` is a non-empty string is Continue, with `label` used when it is a string; anything else is Settle. No Python or wire change is needed.
- **Process.** The agent loop's gate is envd's admission gate (crates/envd/src/server/session.rs:407, :432, :719, :744; worker.rs:1754, :1971), in the same process. Provider domain hooks are already awaited from inside a turn through the same callbacks, so awaiting them from the settle path follows an existing pattern.
- **Interfaces.** `NativeHookHost::decide(&self, event: HookEventId, payload: &JsonValue) -> BoxFut<'_, NativeReply>` (crates/contract/src/hooks.rs:769); `NativeReply { verdict, context }`; `HookContext { source: Str, body: Str }` (:530-555). `HookGate::attach_native` (:1282) has no detach, so the host is attached once per gate and reads the current rows on every call; with no rows it returns `Defer`.
- **Session generation.** `compose` (envd tools/hooks.rs:935) keeps only rows whose `identity.session_generation` matches the session's; provider domain dispatch does not. The settled host must apply the same filter as `compose`.
- **Timeout.** Per hook: `row.timeout`, else `row.event_policy.timeout`, exactly as provider domain dispatch uses. A timeout counts as Settle. A row skipped for a wrong revision counts as Settle and logs the existing warning.
- **Order.** The docs order hooks by `(layer, publisher, extension_id)` (`SourceRef`, contract hooks.rs:166-175). envd's rows carry no publisher: `ControlConnectionIdentity` (crates/envd/src/exthost/control.rs:1062) has `layer`, `tier` (the trust tier, not the publisher) and `extension`. Provider domain dispatch sorts by `(layer, tier, extension, name)`.
- **Cap reset.** A submission is one run of the agent loop for one user prompt. The counter starts at 0 for each submission and counts every Continue in it; a steering message does not reset it. With plugin hooks alone nothing changes, because the plugin host's own counter stops at the same 8 (crates/driver/src/plugin_hooks.rs:682-717). With plugin and Python hooks together, the core cap bounds the total, as the docs say.
- **End-to-end test.** crates/e2e/tests/p9_extension_control.rs hosts real extensions. Whether it can drive `agent_settled` is checked in the plan's last task; if it cannot, that test is recorded as open in docs/adr/TASKS.md instead of built here.

## Left to the builder

- Updating docs/py/05-hooks.md, docs/py/12-agents.md and docs/adr/TASKS.md to say what this slice honors and what it does not yet.

## Calls made by the author, not the owner

- The cap lives in the agent loop and counts continuations from every source (plugin hosts and Python), because the docs say the core refuses further continuation.
- `continuations_used` reports the real count.
- The document and its plan live in `docs/design/`, following this repo, rather than `docs/specs/` and `docs/plans/`.
- Hook order is `(layer, extension, order, name)`, not the documented order, because envd has no publisher. Adding a publisher to `ControlConnectionIdentity` touches every place that builds one (crates/envd/src/exthost/control.rs, worker.rs, crates/app, tests) and is left to a later slice.
- A wrong-revision row and a timeout count as Settle.
