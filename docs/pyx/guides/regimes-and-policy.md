# Regimes and policy

Use regimes when behavior must run at a fixed point in the agent loop and remain active beyond one callback. Use policy hooks and sandbox profiles when you need to inspect an operation, deny it, request approval, or describe its confinement. The two systems complement each other: regimes shape loop behavior, while policy decides which effects may proceed.

```python
from dataclasses import dataclass, replace

import omp


@dataclass(frozen=True, slots=True)
class BatchBudget:
    used: int = 0
    limit: int = 3


@omp.regime(
    "bounded-batches",
    on=omp.BATCH,
    lifetime=omp.RegimeLifetime.RUN,
    state=BatchBudget,
)
def bounded_batches(ctx: omp.RegimeContext, next_: omp.Next) -> None:
    budget = ctx.state.value

    # BATCH is observed before and after delivery.
    if not ctx.event.delivered and budget.used >= budget.limit:
        return next_.reject("tool-batch limit reached")
    if ctx.event.delivered:
        ctx.state.replace(replace(budget, used=budget.used + 1))


@omp.hook("tool_call", phase=omp.HookPhase.PRECHECK)
def deny_network(event: omp.ToolCallEvent, ctx: omp.Context) -> omp.HookDecision:
    if event.bash is not None and event.bash.net:
        return omp.Deny("network effects are disabled", code="network.denied")
    return omp.Defer()


async def enable_batch_budget() -> omp.RegimeHandle:
    return await omp.regimes.start("bounded-batches", state=BatchBudget())
```

The regime counts only delivered batches. The policy hook independently refuses shell calls whose host-analyzed [`BashIR`](../reference/omp.policy.md#omppolicybashir) contains a network reference.

## Fixed loop points

A regime subscribes to one or more members of [`Point`](../reference/omp.regimes.md#ompregimespoint). The point vocabulary is closed:

| Point | Loop boundary | Available `Next` control |
|---|---|---|
| `CONTEXT` | Provider-context projection | None |
| `TOOL_CHOICE` | Tool-choice resolution | None |
| `PRE_MODEL` | Before sampling | `wait()` |
| `STREAM` | During a model stream | `cancel()` |
| `ADMISSION` | Before one tool invocation | `wait()`, `reject()` |
| `BATCH` | During a tool batch | `reject()`, `cancel()` |
| `TURN_END` | At the turn boundary | None |
| `SETTLE` | Before agent settlement | `retry()`, `complete()`, `fail()` |
| `IDLE` | At an idle mailbox boundary | None |

`BATCH` may arrive before delivery with `ctx.event.delivered == False` and after settlement with `delivered == True`. Check that fact when an action should happen on only one side of the batch.

## Write isolated handlers

A handler accepts exactly `(ctx, next_)`. It may be synchronous or asynchronous and must return `None` or the result of a `next_` method, which is also `None`.

`ctx.event` is an immutable mapping with attribute access. `ctx.state.value` is the decoded durable state, if the declaration has one. The remaining namespaces stage effects in the callback's private draft:

| Writer | Staged effect |
|---|---|
| `ctx.context.append(*items)` | `append_context` |
| `ctx.context.rewrite(patch)` | `rewrite_context` |
| `ctx.tool.require(name)` | `require_tool` |
| `ctx.settings.set(name, value)` | `set_scoped` |
| `ctx.state.replace(value)` | `replace_state` |

Use [`user_text()`](../reference/omp.regimes.md#ompregimesuser_text) to build a canonical user-message item for `context.append()`.

A `Next` object selects no more than one control. The first selection seals it; a second raises `RegimeContractError`. `next_` does not call another regime. Each handler runs against a separate draft, and Core resolves successful drafts at the loop boundary. If a handler raises, its staged effects do not commit.

> **Warning** A control is valid only at the points shown above. For example, `retry()` is a `SETTLE` control and `reject()` is available only at `ADMISSION` and `BATCH`.

## Declare lifecycle and state

[`@regime`](../reference/omp.regimes.md#ompregimesregime) records a declaration during import. Registration is sealed when the extension freezes, so decorators must run at module import time.

Choose a lifetime that matches the behavior:

- `TURN` limits an activation to one turn.
- `RUN` keeps it for the current run and is the default.
- `SESSION` keeps it for the session.

Declare state with a dataclass type. Start the regime with an instance of that exact type, read it through `ctx.state.value`, and replace the whole value through `ctx.state.replace()`. State is encoded with schema revision `1`; a mismatched revision raises `StateSchemaMismatch`, and malformed fields raise `StateDecodeError`.

```python
handle = await omp.regimes.start("bounded-batches", state=BatchBudget())
rows = await omp.regimes.active()
await handle.stop()
```

Core owns the activation record and durable state. Active regimes can therefore be restored after a host restart before the next subscribed point. Class-based regime handlers get one activation-local instance; `dispatch_regime_start` and `dispatch_regime_stop` manage that instance internally.

Use `owns=(...)` for exclusive resources and `queue=True` at startup when an activation may wait for them. `sets={...}` installs settings scoped to the activation. `minimum_duration`, `max_steps`, and `on_limit` add lifecycle bounds without changing the handler shape. `when=omp.when.checkpoint_active()` is the public declarative activation condition currently provided by the module.

## Deny effects with policy hooks

A policy hook sees a logical call before the environment authorizes its effects. For shell execution, `event.bash` is a [`BashIR`](../reference/omp.policy.md#omppolicybashir) produced by the host analyzer. Prefer structured facts over matching the source string:

- `ir.reads` and `ir.writes` contain filesystem effects.
- `ir.net` contains all inferred network references; `ir.net_sinks()` narrows these to egress and bidirectional references.
- `ir.has_dynamic_eval` marks execution the analyzer cannot fully determine.
- `ir.is_read_only()` requires no writes, no network, no dynamic evaluation, and read-only classification for every command.

Return `omp.Deny(reason, code=...)` from the appropriate hook phase to refuse a call. A denial is distinct from a sandbox violation: admission prevents the invocation from starting, while a violation reports an attempted effect against installed confinement.

For non-shell path arguments, use [`await omp.policy.match_paths()`](../reference/omp.policy.md#omppolicymatch_paths) so resolution occurs in the environment that owns the path. Do not use host-side `os.path` calls for remote workspace paths.

## Request approval

Approval is a durable Core-owned ticket, not a suspended extension coroutine:

1. An approval-phase hook returns `omp.RequireApproval(omp.ApprovalSpec(...))`.
2. Core aggregates unresolved reasons for the invocation into one `ApprovalTicket`.
3. The invocation parks while other calls continue.
4. A user, external approver, configuration rule, timeout, or unavailable-route rule produces an `ApprovalDecision`.
5. Core resumes an approved invocation or records a structured policy denial.

`APPROVAL_DEADLINE` is `Duration("5m")` and is the default timeout used by `@omp.approver`. External approvers must be async and idempotent by `ticket.ticket_id`, because a pending ticket may be offered again after restart.

```python
@omp.approver("operations", kinds=(omp.ApprovalKind.NETWORK,))
async def operations(ticket: omp.ApprovalTicket, ctx: omp.Context):
    approved = await ask_operations_service(ticket)
    return omp.ApprovalDecision(
        approved=approved,
        scope=omp.PolicyScope.ONCE,
        source=omp.ApprovalSource.EXTERNAL,
        decided_by="operations",
        reason=None,
        audited=True,
    )
```

Use [`pending()`](../reference/omp.policy.md#omppolicypending) to reconcile outstanding tickets and [`decide()`](../reference/omp.policy.md#omppolicydecide) to submit a decision. An identical repeated decision is an idempotent no-op; a conflicting decision is rejected by Core.

## Profiles, budgets, and quotas

A [`SandboxProfile`](../reference/omp.policy.md#omppolicysandboxprofile) groups filesystem, network, executable, and process-resource policy. Profiles are immutable data. [`install()`](../reference/omp.policy.md#omppolicyinstall) installs a scoped contribution that may only narrow running confinement; [`ProfileHandle.revoke()`](../reference/omp.policy.md#omppolicyprofilehandle) removes that contribution.

`ResourceBudget` provides per-process ceilings for wall time, CPU, memory, output, child count, and disk/file usage. The host-wide constants in [`omp.limits`](../reference/omp.limits.md) set separate protocol and runtime ceilings, including frame size, child count, pending effects, reentrancy, observation capacity, and shutdown timing.

These limits serve different layers:

- A regime's `max_steps` bounds committed middleware progress.
- `ResourceBudget` bounds a confined execution session.
- `omp.limits` describes fixed host ceilings and compatibility revisions.

Do not treat a quota failure as a policy denial. Resource exhaustion is a failed execution or a `ViolationKind.RESOURCE`; a denial means policy refused authorization.

## Related reference

- [`omp.regimes`](../reference/omp.regimes.md)
- [`omp.policy`](../reference/omp.policy.md)
- [`omp.limits`](../reference/omp.limits.md)
- [Hooks guide](hooks.md)
- [Environment guide](environment.md)
