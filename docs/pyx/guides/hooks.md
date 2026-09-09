# Hooks

Hooks let your extension join a named seam in the agent loop. Use a **gate** when you must reject, rewrite, review, or request approval for an operation. Use a **notification** when you only need to react after the harness has fixed an outcome.

A hook handles one event payload at a time. The callback receives the payload and the current [`Context`](../reference/omp.context.md), and may be synchronous or asynchronous.

## Declare your first hook

Declare the subscription in `omp.toml` so the host knows about it before importing your code:

```toml
id = "acme.workspace-policy"
entry = "workspace_policy"
version = "1.0.0"

[[hooks]]
event = "tool_call"
phase = "precheck"
module = "workspace_policy"
```

Register the matching callback when the module is imported:

```python
import omp

@omp.hook(
    "tool_call",
    phase=omp.HookPhase.PRECHECK,
    on_failure=omp.OnFailure.DENY,
    when=omp.When(name={"bash"}),
)
def reject_secret_reads(
    event: omp.ToolCallEvent,
    ctx: omp.Context,
) -> omp.HookDecision:
    command = event.args.get("command")
    if isinstance(command, str) and ".env" in command:
        return omp.Deny("shell commands may not read .env files", code="secret_read")
    return omp.Defer()
```

The manifest declaration and decorator declaration must agree. Decorators run during module import; registering after the declaration table is sealed raises `LateRegistration`.

> **Note** `When` filters are evaluated before the event payload is built. Prefer a filter to opening every event and returning `Defer()`.

## Understand the phase model

Gateable events require an explicit phase. The phase determines both legal return values and evaluation order.

| Phase | Legal results | Use it for |
|---|---|---|
| `PRECHECK` | `Deny`, `Defer` | Cheap deterministic rejection before any rewrite or review |
| `TRANSFORM` | `Modify`, `Defer` | Ordered changes to catalog-declared mutable fields |
| `REVIEW` | `Allow`, `Deny`, `Defer` | Independent review and policy classification |
| `APPROVAL` | `RequireApproval`, `Allow`, `Deny`, `Defer` | Durable user or external approval requirements |
| `OBSERVE` | `None` | Notification delivery after the relevant outcome is fixed |

`None` is treated as `Defer()` in a gate phase. In `OBSERVE`, the callback must return `None`; notification-only events also reject an explicitly non-`None` return annotation during registration. You may subscribe to a gateable seam in `OBSERVE`, but you must still state that phase in the decorator.

A gate proceeds through `PRECHECK`, `TRANSFORM`, `REVIEW`, then `APPROVAL`. A denial prevents later phases from running. Transforms run sequentially by ascending `order`, and each transform receives the payload produced by its predecessors. `order` is illegal outside `TRANSFORM`. Parallel phases are combined by the harness rather than by extension discovery order.

Across extensions, equal transform orders are resolved deterministically by extension placement and identity. Do not depend on installation or filesystem enumeration order; give transforms distinct `order` values when their sequence is semantically important.

Some catalog entries are **domain events** rather than phase gates. For example, `agent_settled`, `compaction`, and provider callbacks return their own domain types and reject a `phase` argument. Consult [`omp.events.spec()`](../reference/omp.events.md#ompeventsspec) before registering a generic integration.

## Return a gate decision

The decision vocabulary is closed:

- `Allow(reason=None)` records an affirmative vote without skipping later phases.
- `Deny(reason, fatal=False, code=None)` rejects the operation. `fatal=True` is not legal for call-latency hooks.
- `Modify(...)` changes mutable payload fields during `TRANSFORM`.
- `Defer(note=None)` abstains.
- `RequireApproval(spec)` asks Core to create or merge a durable approval ticket.

Use `Modify(args=...)` to replace an argument mapping, or `Modify(patch=...)` for a shallow field patch. These forms are mutually exclusive. Put `UNSET` in a patch to remove a mapping key. `env_overrides` is a dedicated mapping whose `None` values unset variables.

The event catalog defines which fields can change and how multiple transforms compose. Inspect it with:

```python
from omp.events import field_composition, spec

row = spec("tool_call")
print(row.gateable, row.on_failure, row.default_timeout)
print(field_composition("tool_call"))
```

## Observe notifications

Notification-only events always use `OBSERVE`; omitting the phase selects it automatically. They cannot declare `on_failure` and cannot change the operation they describe.

```toml
[[hooks]]
event = "tool_execution_end"
phase = "observe"
module = "workspace_policy"
```

```python
@omp.hook("tool_execution_end")
async def record_duration(
    event: omp.ToolExecutionEndEvent,
    ctx: omp.Context,
) -> None:
    print(f"{event.call_id}: {event.duration}")
```

Observation events include lifecycle notifications, stream updates, execution milestones, job settlement, and extension-host changes. Their complete payload types are listed in the [`omp.events` reference](../reference/omp.events.md).

## Filter and throttle delivery

`When` can filter targets, names, servers, revisions, paths, MCP methods, call origins, reasons, and providers. It also supports one-shot and quiet-period delivery:

```python
@omp.hook(
    "mcp_notification",
    when=omp.When(
        server={"project-index"},
        method_globs=("resources/**",),
        once=True,
        after_gap=omp.Duration("2s"),
    ),
)
def first_resource_notice(event: omp.McpNotificationEvent, ctx: omp.Context) -> None:
    print(f"{event.server}: {event.method}")
```

`mcp_notification` requires a non-empty server filter or method glob.

Stream events (`message_start`, `message_update`, `message_end`, `call_open`, and `tool_update`) require `coalesce=Duration(...)`. The window must be at least 16 ms. Non-stream events reject `coalesce`.

```python
@omp.hook("message_update", coalesce=omp.Duration("50ms"))
def count_output(event: omp.MessageUpdateEvent, ctx: omp.Context) -> None:
    print(f"assistant characters: {event.total_chars}")
```

A hook-specific `timeout` must be positive and cannot exceed the event catalog's `ceiling_timeout`. If omitted, the event's `default_timeout` applies. `OnFailure.DENY` makes an unavailable gate fail closed; `OnFailure.DEFER` makes it abstain. You may tighten a catalog's policy from defer to deny, but cannot weaken a fail-closed event.

## Recipes

### Deny a dangerous tool argument

Use `PRECHECK` for a quick blocklist that does not need to rewrite anything:

```python
@omp.hook(
    "tool_call",
    phase=omp.HookPhase.PRECHECK,
    on_failure=omp.OnFailure.DENY,
    when=omp.When(name={"bash"}),
)
def block_recursive_root_delete(event: omp.ToolCallEvent, ctx: omp.Context) -> omp.HookDecision:
    command = event.args.get("command")
    if isinstance(command, str) and "rm -rf /" in command:
        return omp.Deny("recursive deletion of the filesystem root is forbidden")
    return omp.Defer()
```

### Transform a submitted prompt

`before_agent_start.text` is mutable with replacement composition. Return a field patch from `TRANSFORM`:

```python
@omp.hook("before_agent_start", phase=omp.HookPhase.TRANSFORM, order=20)
def add_workspace_constraint(
    event: omp.BeforeAgentStartEvent,
    ctx: omp.Context,
) -> omp.HookDecision:
    suffix = "\n\nWork only inside the current workspace."
    if event.text.endswith(suffix):
        return omp.Defer()
    return omp.Modify(patch={"text": event.text + suffix})
```

### Require approval for a write

Return immediately with an `ApprovalSpec`; do not open UI from the callback. Core owns the ticket, merges compatible requirements, and applies its deadline and routing policy.

```python
@omp.hook(
    "tool_call",
    phase=omp.HookPhase.APPROVAL,
    when=omp.When(name={"write", "edit"}),
)
def approve_workspace_write(
    event: omp.ToolCallEvent,
    ctx: omp.Context,
) -> omp.HookDecision:
    return omp.RequireApproval(
        omp.ApprovalSpec(
            title="Approve workspace change",
            body="Allow the requested tool call to modify workspace files?",
            subject=event.call_id,
            kind=omp.ApprovalKind.WRITE,
            scopes=(omp.PolicyScope.ONCE, omp.PolicyScope.SESSION),
            route=omp.ApprovalRoute.AUTO,
        )
    )
```

See [`omp.hooks`](../reference/omp.hooks.md) for declaration and decision details, and [`regimes and policy`](regimes-and-policy.md) for longer-lived policy state.
