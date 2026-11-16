# Stream B — Native hooks vs Bub/Pluggy-style middleware

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff` (2026-11-16 UTC).  
Auditor: [Audit native hook phases](bc-b23abcf8-04e3-5e16-81ab-9f251fa0c60e).  
Tests cited were inventoried from source; they were **not** re-run in this audit.

## Study

Can OMP2’s existing hook architecture already provide the useful composability of Bub/Pluggy without a second lifecycle framework?

## Inventory (production owners)

| Owner | Role |
|---|---|
| `crates/contract/src/hooks.rs` | `HookPhase`, `HookDecision`, `Subscription`, `HookGate`, `LifecycleHooks`, `NativeHookHost` |
| `crates/contract/src/hook_catalog.rs` | Stable `HOOK_EVENTS` descriptors (ADR 0046) |
| `crates/envd/src/tools/hooks.rs` | Production composer: delegated gate + Python CONTROL callbacks |
| `crates/driver/src/plugin_hooks.rs` | Claude-plugin `NativeHookHost` on the same gate |
| `crates/ai/src/layer/hook.rs` (+ provider hooks) | Inference cold-path / provider domain — not a second catalog |
| `docs/py/05-hooks.md`, `crates/py/python/omp/hooks.py` | Spec + `@omp.hook` |

Wiring: envd builds a **delegated** `HookGate`; driver `attach_native` for plugins; kernel shares the gate via `with_hook_gate`.

### Phase legality (enforced)

| Phase | Legal decisions | Notes |
|---|---|---|
| Precheck | Deny, Defer | Deny-only checks |
| Transform | Modify, Defer | `MODIFY_ROUNDS = 1`; Replace/Append/Intersect fields |
| Review | Allow, Deny, Defer | Budgeted review |
| Approval | Allow, Deny, Defer, RequireApproval | Merges into ApprovalBook |
| Observe | Defer only | Async/lossy; does not change outcome; cap 64 |

Ordering: native hosts before extensions; transform by `(order, host, id)`; deny short-circuits; timeouts per event (tool_call configurable; session_shutdown 1500 ms); `OnFailure::{Defer,Deny}`.

**Docs vs code:** `05-hooks.md` claims Precheck/Review are parallel; Rust `dispatch_phase` / envd `compose` are **sequential**. Observe is separate from `gate()`.

## Lifecycle boundaries → hooks

| Boundary | Status | Notes |
|---|---|---|
| Tool admission (`tool_call`) | **IV** | Live delegated compose |
| Native tool policy + ApprovalBook | **IV** | Parallel to hooks |
| `before_agent_start` / `agent_start` | **IV** | Live prompt/submission seam |
| `user_input` / `user_bash` / `user_eval` / `command_invoke` | **PD/A** | Catalogued; no Rust emit found |
| Model observe / provider before_request | **IV** | No separate “model admit” gate |
| `thread_projection`, `turn_start` | **IV** | Live |
| Tool lifecycle observes + `tool_result` | **IV** | Mostly observe |
| Turn/session lifecycle | **IV** | Live |
| `retry_tool_tail` replay | **II** | Intentionally skips re-admission for journal fidelity |

## vs Pluggy/Bub (conceptual)

Typical middleware needs (ordered chain, multi-subscriber, short-circuit, timeout, error policy, lifecycle points) are already covered **plus** typed phases, approval tickets, domain returns, dual native/extension hosts, and bitmap fast-path.

Genuine gaps relative to that *shape* (not missing frameworks):

1. No single linear middleware list — phased multi-channel by design.  
2. Prompt family gates catalog-only (`user_input` et al.).  
3. Replay skips tool_call re-admission (intentional).  
4. Documented parallel Precheck/Review not implemented.  
5. Observe deliberately decoupled from outcome.

## Recommendations

| Action | Target |
|---|---|
| **REUSE** | `HookGate`, `LifecycleHooks`, `HookControlFactory::compose`, phase legality, `OnFailure`, Composition, approval merge |
| **REUSE** | `NativeHookHost` / plugin adapter pattern |
| **REUSE** | AI Tower hook as cold-path seam — do not fork the catalog |
| **EXTEND** | Emit `user_input` family **only** if product needs that seam vs `before_agent_start` |
| **EXTEND** | Optional re-admission on `retry_tool_tail` **only** if policy must re-gate recovered effects |
| **EXTEND** | Parallel Precheck/Review only with measured need (optional optimization) |
| **EXTEND** | Resolve `agent_settled` catalog rev 2 vs payload rev 1 before schema work |
| **REJECT** | Parallel Pluggy-style linear middleware stack / second decision orchestrator |

## Non-goals

- Do not widen authority via hooks.  
- Do not replace Directors, ApprovalBook, or envd admission with a generic hook bus.  
