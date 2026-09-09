# `omp.hooks`

`omp.hooks` defines hook declarations, gate decisions, dispatch targets, filtering, and the fixed vocabulary used by the event catalog. Most applications import these names directly from `omp`; import `omp.hooks` when you want to make the owning module explicit.

```python
import omp

@omp.hook("tool_call", phase=omp.HookPhase.PRECHECK)
def gate(event: omp.ToolCallEvent, ctx: omp.Context) -> omp.HookDecision:
    return omp.Defer()
```

See the [hooks guide](../guides/hooks.md) for the phase procedure and recipes. Event payloads and catalog inspection live in [`omp.events`](omp.events.md).

## Declaration

### `omp.hooks.hook`

```python
def hook(
    event: str,
    *,
    phase: HookPhase | None = None,
    order: int = 0,
    on_failure: OnFailure | None = None,
    timeout: Duration | None = None,
    coalesce: Duration | None = None,
    when: When | None = None,
    provider: str | None = None,
    concurrency: int = 1,
    threadsafe: bool = False,
    name: str | None = None,
) -> Callable[[_HookFn], _HookFn]
```

Declares a subscription during module import without performing host I/O.

Gateable events require a phase. Observation events accept only `OBSERVE` or `None`; domain events reject a phase. `sandbox_profile` specifically requires `TRANSFORM`. The returned decorator preserves the original callable and adds its frozen declaration to `__omp_hooks__`.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `event` | `str` | Catalog event name. |
| `phase` | `HookPhase \| None` | Decision phase; required for a gate and inferred as `OBSERVE` for notifications. |
| `order` | `int` | Ascending transform order; must be zero outside `TRANSFORM`. |
| `on_failure` | `OnFailure \| None` | Per-subscription failure policy; cannot weaken a fail-closed catalog row. |
| `timeout` | `Duration \| None` | Positive handler deadline, bounded by the event ceiling. |
| `coalesce` | `Duration \| None` | Required stream window of at least 16 ms; forbidden for non-stream events. |
| `when` | `When \| None` | Host-side pre-filter. |
| `provider` | `str \| None` | Convenience provider filter; mutually exclusive with `when.provider`. |
| `concurrency` | `int` | Positive maximum callback concurrency; defaults to `1`. |
| `threadsafe` | `bool` | Declares that concurrent callback entry is safe. |
| `name` | `str \| None` | Stable subscription name; defaults to the callback's module-qualified name. |

**Returns**

A decorator that registers and returns the supplied callable.

**Raises**

| Exception | Condition |
|---|---|
| `UnknownEvent` | `event` is absent from the frozen catalog. |
| `LateRegistration` | Registration has already been sealed. |
| `HookContractError` | A phase, ordering, failure, timeout, coalescing, or filtering rule is violated. |
| `TypeError` or `ValueError` | An option has the wrong type or invalid positive range. |

```python
@omp.hook(
    "tool_call",
    phase=omp.HookPhase.REVIEW,
    timeout=omp.Duration("10s"),
    when=omp.When(name={"bash"}),
)
async def review_shell(event: omp.ToolCallEvent, ctx: omp.Context) -> omp.HookDecision:
    return omp.Allow("reviewed")
```

### `omp.hooks.dispatch_hook`

```python
async def dispatch_hook(event: str, payload: object = None) -> HookDecision
```

Runs one gateable event through Core's composed CONTROL procedure.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `event` | `str` | Gateable catalog event. |
| `payload` | `object` | Payload encoded for the event contract. |

**Returns**

The composed `HookDecision` returned by Core.

**Raises**

| Exception | Condition |
|---|---|
| `NotWiredError` | No CONTROL backend is connected. |
| `UnknownEvent` | The event name is unknown. |
| `HookContractError` | The event is notification-only or the response violates the decision codec. |
| `TypeError` | `event` is not a string. |

```python
result = await omp.hooks.dispatch_hook("user_input", {"text": "continue"})
```

## Decisions

### `omp.hooks.HookDecision`

```python
HookDecision: TypeAlias = Allow | Deny | Modify | Defer | RequireApproval
```

Names the closed result vocabulary for gateable hooks. Legal arms depend on `HookPhase`; returning `None` from a gate callback is normalized to `Defer()`.

### `omp.hooks.Allow`

```python
Allow(reason: str | None = None)
```

Records an affirmative vote without skipping later phases.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reason` | `str \| None` | `None` | Optional audit explanation. |

### `omp.hooks.Deny`

```python
Deny(reason: str, fatal: bool = False, code: str | None = None)
```

Rejects the current gate and prevents later phases from running.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reason` | `str` | required | Human-readable refusal reason. |
| `fatal` | `bool` | `False` | Requests a fatal enclosing outcome; illegal for call-latency hooks. |
| `code` | `str \| None` | `None` | Stable machine-readable refusal code. |

### `omp.hooks.Modify`

```python
Modify(
    target: CallTarget | None = None,
    args: Mapping[str, Any] | None = None,
    patch: Mapping[str, Any] | None = None,
    env_overrides: Mapping[str, str | None] | None = None,
    reason: str | None = None,
)
```

Changes catalog-declared mutable payload fields during `TRANSFORM`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `target` | `CallTarget \| None` | `None` | Replacement dispatch target. |
| `args` | `Mapping[str, Any] \| None` | `None` | Complete replacement argument mapping. |
| `patch` | `Mapping[str, Any] \| None` | `None` | Shallow field patch; a value of `UNSET` removes a mapping key. |
| `env_overrides` | `Mapping[str, str \| None] \| None` | `None` | Environment delta; `None` values remove variables. |
| `reason` | `str \| None` | `None` | Optional audit explanation. |

`args` cannot be combined with `patch` or `env_overrides`. A patch cannot also contain `env_overrides` when the dedicated field is set.

```python
return omp.Modify(
    patch={"deadline": omp.Duration("30s"), "legacy": omp.UNSET},
    reason="apply workspace policy",
)
```

### `omp.hooks.Defer`

```python
Defer(note: str | None = None)
```

Abstains without changing the current payload or recording an affirmative vote.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `note` | `str \| None` | `None` | Optional diagnostic note. |

### `omp.hooks.RequireApproval`

```python
RequireApproval(spec: ApprovalSpec)
```

Asks Core to file or merge a durable approval ticket. This arm is legal only in `APPROVAL`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `spec` | `ApprovalSpec` | required | Ticket content and resolution policy. |

### `omp.hooks.ApprovalSpec`

```python
ApprovalSpec(
    title: str,
    body: str,
    subject: str,
    kind: ApprovalKind = ApprovalKind.EXEC,
    scopes: tuple[PolicyScope, ...] = (PolicyScope.ONCE, PolicyScope.SESSION),
    default: bool | None = None,
    route: ApprovalRoute = ApprovalRoute.AUTO,
    approver: str | None = None,
    timeout: Duration = APPROVAL_DEADLINE,
    unreachable: Unreachable = Unreachable.FAIL_CLOSED,
    require_human: bool = False,
    pattern: str | None = None,
    evidence: tuple[str, ...] = (),
)
```

Describes one reason for a durable approval ticket.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | `str` | required | Short ticket heading. |
| `body` | `str` | required | Explanation shown to the approver. |
| `subject` | `str` | required | Stable identifier for the operation being approved. |
| `kind` | `ApprovalKind` | `EXEC` | Approval category. |
| `scopes` | `tuple[PolicyScope, ...]` | `(ONCE, SESSION)` | Grant lifetimes the approver may choose. |
| `default` | `bool \| None` | `None` | Optional default resolution. |
| `route` | `ApprovalRoute` | `AUTO` | Destination for the ticket. |
| `approver` | `str \| None` | `None` | Optional named approver. |
| `timeout` | `Duration` | `APPROVAL_DEADLINE` | Wall-clock resolution deadline. |
| `unreachable` | `Unreachable` | `FAIL_CLOSED` | Behavior when the route cannot answer. |
| `require_human` | `bool` | `False` | Disallows non-human resolution when true. |
| `pattern` | `str \| None` | `None` | Optional reusable policy pattern. |
| `evidence` | `tuple[str, ...]` | `()` | Supporting audit references. |

```python
return omp.RequireApproval(
    omp.ApprovalSpec(
        title="Approve network access",
        body="Allow this call to contact the package registry?",
        subject=event.call_id,
        kind=omp.ApprovalKind.NETWORK,
    )
)
```

### `omp.hooks.UNSET`

```python
UNSET: Final[object]
```

Sentinel placed in `Modify.patch` to remove a mapping key. It is invalid anywhere else on the CONTROL boundary.

## Targets and filters

### `omp.hooks.CallTarget`

```python
CallTarget: TypeAlias = CoreTool | DeviceCall | McpCall
```

Names the three supported logical dispatch targets.

### `omp.hooks.CoreTool`

```python
CoreTool(name: str, rev: str, args: Mapping[str, Any])
```

Identifies a built-in harness tool call.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `ClassVar[TargetKind]` | `TargetKind.CORE` | Wire discriminator. |
| `name` | `str` | required | Tool name. |
| `rev` | `str` | required | Resolved revision. |
| `args` | `Mapping[str, Any]` | required | Canonical arguments. |

### `omp.hooks.DeviceCall`

```python
DeviceCall(name: str, family: str, rev: str, args: Mapping[str, Any])
```

Identifies a call to an extension or mounted device.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `ClassVar[TargetKind]` | `TargetKind.DEVICE` | Wire discriminator. |
| `name` | `str` | required | Device call name. |
| `family` | `str` | required | Device family. |
| `rev` | `str` | required | Resolved family revision. |
| `args` | `Mapping[str, Any]` | required | Canonical arguments. |

### `omp.hooks.McpCall`

```python
McpCall(server: str, tool: str, args: Mapping[str, Any])
```

Identifies a tool on a mounted MCP server.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `ClassVar[TargetKind]` | `TargetKind.MCP` | Wire discriminator. |
| `server` | `str` | required | Mounted server name. |
| `tool` | `str` | required | Server tool name. |
| `args` | `Mapping[str, Any]` | required | Canonical arguments. |

### `omp.hooks.When`

```python
When(
    target: frozenset[TargetKind] | None = None,
    name: frozenset[str] | None = None,
    server: frozenset[str] | None = None,
    rev: frozenset[str] | None = None,
    path_globs: tuple[str, ...] = (),
    method_globs: tuple[str, ...] = (),
    origin: frozenset[CallOrigin] | None = None,
    reason: frozenset[str] | None = None,
    provider: frozenset[str] | None = None,
    once: bool = False,
    after_gap: Duration | None = None,
)
```

Declares a pre-filter evaluated before payload construction. Set-like and tuple-like inputs are normalized to `frozenset` and `tuple`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `target` | `frozenset[TargetKind] \| None` | `None` | Accepted target kinds. |
| `name` | `frozenset[str] \| None` | `None` | Accepted tool, device, command, or resource names. |
| `server` | `frozenset[str] \| None` | `None` | Accepted MCP server names. |
| `rev` | `frozenset[str] \| None` | `None` | Accepted revisions. |
| `path_globs` | `tuple[str, ...]` | `()` | Path glob filters. |
| `method_globs` | `tuple[str, ...]` | `()` | MCP method glob filters. |
| `origin` | `frozenset[CallOrigin] \| None` | `None` | Accepted call origins. |
| `reason` | `frozenset[str] \| None` | `None` | Accepted event reasons. |
| `provider` | `frozenset[str] \| None` | `None` | Accepted provider identifiers. |
| `once` | `bool` | `False` | Deliver only the first match. |
| `after_gap` | `Duration \| None` | `None` | Require a quiet interval before delivery. |

## Phase and catalog vocabulary

### `omp.hooks.HookPhase`

```python
class HookPhase(StrEnum)
```

Selects a callback's place in the decision procedure.

| Member | Wire value | Meaning |
|---|---|---|
| `PRECHECK` | `"precheck"` | Parallel deny-only screening. |
| `TRANSFORM` | `"transform"` | Totally ordered payload mutation. |
| `REVIEW` | `"review"` | Parallel allow, deny, or abstain review. |
| `APPROVAL` | `"approval"` | Approval requirements and final policy votes. |
| `OBSERVE` | `"observe"` | Notification with no decision result. |

### `omp.hooks.CallOrigin`

```python
class CallOrigin(StrEnum)
```

Identifies who issued a logical call.

| Member | Wire value | Meaning |
|---|---|---|
| `MODEL` | `"model"` | Current model output. |
| `USER` | `"user"` | Direct user action. |
| `SUBAGENT` | `"subagent"` | Child-agent action. |
| `REPLAY` | `"replay"` | Replayed durable work. |

### `omp.hooks.TargetKind`

```python
class TargetKind(StrEnum)
```

Discriminates dispatch target families.

| Member | Wire value | Meaning |
|---|---|---|
| `CORE` | `"core"` | Built-in harness tool. |
| `DEVICE` | `"device"` | Extension or mounted device. |
| `MCP` | `"mcp"` | Mounted MCP server tool. |

### `omp.hooks.Composition`

```python
class Composition(StrEnum)
```

Defines how ordered modifications combine for one mutable event field.

| Member | Wire value | Meaning |
|---|---|---|
| `REPLACE` | `"replace"` | Later accepted value replaces the earlier value. |
| `APPEND` | `"append"` | Adds new sequence entries. |
| `INTERSECT` | `"intersect"` | Narrows a set to common entries. |

### `omp.hooks.OnFailure`

```python
class OnFailure(StrEnum)
```

Chooses behavior when a handler cannot return a valid result.

| Member | Wire value | Meaning |
|---|---|---|
| `DEFER` | `"defer"` | Fail open by abstaining. |
| `DENY` | `"deny"` | Fail closed by rejecting the gate. |

### `omp.hooks.LatencyClass`

```python
class LatencyClass(StrEnum)
```

Classifies how frequently an event can delay harness progress.

| Member | Wire value | Meaning |
|---|---|---|
| `SESSION` | `"session"` | Session lifecycle seam. |
| `SUBMISSION` | `"submission"` | Caller-submission seam. |
| `TURN` | `"turn"` | Model-turn seam. |
| `CALL` | `"call"` | Per-tool-call seam. |
| `INPUT` | `"input"` | Direct input seam. |
| `STREAM` | `"stream"` | Coalesced streaming seam. |
| `ASYNC` | `"async"` | Off-critical-path notification. |

### `omp.hooks.Channel`

```python
class Channel(StrEnum)
```

Identifies the transport carrying hook dispatches.

| Member | Wire value | Meaning |
|---|---|---|
| `CONTROL` | `"control"` | Multiplexed CONTROL channel. |

### `omp.hooks.ApprovalKind`

```python
class ApprovalKind(StrEnum)
```

Categorizes an approval for presentation and policy lookup.

| Member | Wire value | Meaning |
|---|---|---|
| `EXEC` | `"exec"` | Program or command execution. |
| `WRITE` | `"write"` | Data or workspace mutation. |
| `READ` | `"read"` | Data access. |
| `NETWORK` | `"network"` | Network access. |
| `PRIVILEGE` | `"privilege"` | Privilege elevation. |
| `DEVICE` | `"device"` | Device invocation. |
| `SPAWN` | `"spawn"` | Agent or worker creation. |

### `omp.hooks.PolicyScope`

```python
class PolicyScope(StrEnum)
```

Bounds the lifetime of a decision or approval grant.

| Member | Wire value | Meaning |
|---|---|---|
| `ONCE` | `"once"` | This single decision. |
| `CALL` | `"call"` | Current call. |
| `TURN` | `"turn"` | Current turn. |
| `SESSION` | `"session"` | Current session. |
| `PERSIST` | `"persist"` | Durable future policy. |

### `omp.hooks.ApprovalRoute`

```python
class ApprovalRoute(StrEnum)
```

Selects where Core sends a durable approval ticket.

| Member | Wire value | Meaning |
|---|---|---|
| `AUTO` | `"auto"` | Choose an available route. |
| `LOCAL` | `"local"` | Local interactive surface. |
| `PARENT` | `"parent"` | Parent agent or session. |
| `EXTERNAL` | `"external"` | Configured external approver. |
| `NONE` | `"none"` | Do not route interactively. |

### `omp.hooks.Unreachable`

```python
class Unreachable(StrEnum)
```

Defines how an approval resolves when its selected route cannot answer.

| Member | Wire value | Meaning |
|---|---|---|
| `FAIL_CLOSED` | `"fail_closed"` | Reject the operation. |
| `ESCALATE_LOCAL` | `"escalate_local"` | Try the local route. |
| `FAIL_OPEN_AUDITED` | `"fail_open_audited"` | Permit while recording the exceptional resolution. |

## Deadlines

### `omp.hooks.DEFAULT_HOOK_TIMEOUT`

```python
DEFAULT_HOOK_TIMEOUT: Final[Duration] = Duration("5s")
```

Provides the host fallback deadline when no catalog-specific timeout applies.

### `omp.hooks.APPROVAL_DEADLINE`

```python
APPROVAL_DEADLINE: Final[Duration] = Duration("5m")
```

Provides the default wall-clock deadline stored in an `ApprovalSpec`.

## Exceptions

### `omp.hooks.UnknownEvent`

```python
class UnknownEvent(OmpError, ValueError)
```

Raised when a declaration or catalog lookup names no frozen event.

### `omp.hooks.HookContractError`

```python
class HookContractError(OmpError, ValueError)
```

Raised when registration, payload encoding, or a returned decision violates the hook contract.

### `omp.hooks.LateRegistration`

```python
class LateRegistration(OmpError, RuntimeError)
```

Raised when a decorator attempts to register after declarations are sealed.

### `omp.hooks.ReentrancyError`

```python
class ReentrancyError(OmpError)
```

Raised when nested hook work exceeds `omp.limits.REENTRANCY_DEPTH`.

### `omp.hooks.PhaseConflict`

```python
class PhaseConflict(OmpError)
```

Raised when a callback awaits a CONTROL operation blocked by its active loop phase.

### `omp.hooks.HostShuttingDown`

```python
class HostShuttingDown(OmpError)
```

Raised when hook work is attempted after session shutdown begins.
