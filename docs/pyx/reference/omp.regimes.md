# `omp.regimes`

`omp.regimes` declares durable middleware for fixed agent-loop points and manages its activations. Reach for it when behavior must retain typed state or scoped settings across callbacks.

```python
import omp


@omp.regime("retry-on-empty", on=omp.SETTLE, max_steps=2)
def retry_on_empty(ctx, next_):
    if ctx.event.empty_output:
        ctx.context.append(omp.user_text("Try again with a non-empty answer."))
        return next_.retry()
```

See [Regimes and policy](../guides/regimes-and-policy.md) for lifecycle and resolution guidance.

## Points and lifetimes

### omp.regimes.Point

```python
class Point(StrEnum)
```

Names one fixed event in the agent loop.

| Member | Wire value | Meaning |
|---|---|---|
| `CONTEXT` | `"context"` | Provider-context projection |
| `TOOL_CHOICE` | `"tool_choice"` | Tool-choice resolution |
| `PRE_MODEL` | `"pre_model"` | Before model sampling |
| `STREAM` | `"stream"` | Active model stream |
| `ADMISSION` | `"admission"` | Tool-call admission |
| `BATCH` | `"batch"` | Active tool batch |
| `TURN_END` | `"turn_end"` | Turn boundary |
| `SETTLE` | `"settle"` | Agent settlement |
| `IDLE` | `"idle"` | Idle mailbox boundary |

### omp.regimes.CONTEXT

```python
CONTEXT: Final[Point] = Point.CONTEXT
```

Alias for the provider-context projection point.

### omp.regimes.TOOL_CHOICE

```python
TOOL_CHOICE: Final[Point] = Point.TOOL_CHOICE
```

Alias for the tool-choice resolution point.

### omp.regimes.PRE_MODEL

```python
PRE_MODEL: Final[Point] = Point.PRE_MODEL
```

Alias for the pre-sampling point.

### omp.regimes.STREAM

```python
STREAM: Final[Point] = Point.STREAM
```

Alias for the active model-stream point.

### omp.regimes.ADMISSION

```python
ADMISSION: Final[Point] = Point.ADMISSION
```

Alias for the tool-call admission point.

### omp.regimes.BATCH

```python
BATCH: Final[Point] = Point.BATCH
```

Alias for the active tool-batch point.

### omp.regimes.TURN_END

```python
TURN_END: Final[Point] = Point.TURN_END
```

Alias for the turn-boundary point.

### omp.regimes.SETTLE

```python
SETTLE: Final[Point] = Point.SETTLE
```

Alias for the agent-settlement point.

### omp.regimes.IDLE

```python
IDLE: Final[Point] = Point.IDLE
```

Alias for the idle mailbox-boundary point.

### omp.regimes.RegimeLifetime

```python
class RegimeLifetime(StrEnum)
```

Bounds one activation's lifetime.

| Member | Wire value | Meaning |
|---|---|---|
| `TURN` | `"turn"` | Current turn |
| `RUN` | `"run"` | Current run; decorator default |
| `SESSION` | `"session"` | Current session |

## Handler interface

### omp.regimes.RegimeEvent

```python
RegimeEvent(point: Point, payload: Mapping[str, object]) -> None
```

Provides the current point and an immutable event payload.

`event.point` is a `Point`. Mapping access (`event["name"]`) and attribute access (`event.name`) read the same copied payload. A missing item raises `KeyError` through mapping access and `AttributeError` through attribute access.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `point` | `Point` | Current fixed point |
| `payload` | `Mapping[str, object]` | Event facts to freeze |

### omp.regimes.RegimeContext

```python
RegimeContext(
    point: Point,
    event: Mapping[str, object],
    state: object | None,
    state_schema: _StateSchema | None,
    draft: _Draft,
) -> None
```

Exposes event facts and transaction-scoped effect writers.

Runtime code constructs this object for you. Its public attributes are:

| Attribute | Meaning |
|---|---|
| `event` | `RegimeEvent` for the current boundary |
| `context` | Writer with `append(*items) -> None` and `rewrite(patch) -> None` |
| `tool` | Writer with `require(name: str) -> None` |
| `settings` | Writer with `set(name: str, value: object) -> None` |
| `state` | Writer with `.value` and `replace(value: object) -> None` |

All writes are staged. `context.append()` requires at least one canonical thread item; `tool.require()` and `settings.set()` require non-empty names; `state.replace()` requires the exact declared state type.

### omp.regimes.Next

```python
Next(point: Point, draft: _Draft) -> None
```

Selects at most one control for the current point.

Runtime code supplies `next_`. The first control seals it; another call raises `RegimeContractError`.

#### Next.retry

```python
def retry(self) -> None
```

Requests another model turn. Available only at `SETTLE`.

#### Next.wait

```python
def wait(self, ticket: object) -> None
```

Parks progress behind a durable ticket. Available at `PRE_MODEL` and `ADMISSION`.

The ticket may be a mapping or object, but it must expose a non-empty string `id`, a non-negative integer `deadline_ms`, and a non-empty string `reason`.

**Raises**

- `ValueError` — the ticket or one of its required fields is invalid.
- `RegimeContractError` — `wait` is unavailable at the current point or another control was already selected.

#### Next.reject

```python
def reject(self, reason: str) -> None
```

Rejects pending work for a non-empty durable reason. Available at `ADMISSION` and `BATCH`.

#### Next.cancel

```python
def cancel(self, reason: str) -> None
```

Cancels work already in flight for a non-empty durable reason. Available at `STREAM` and `BATCH`.

#### Next.complete

```python
def complete(self) -> None
```

Completes this activation successfully. Available only at `SETTLE`.

#### Next.fail

```python
def fail(self, error: object) -> None
```

Finishes this activation with a typed terminal error. Available only at `SETTLE`.

Exceptions are encoded with their qualified type, message, and arguments. Other non-`None` values are encoded directly.

## Declaration and activation

### omp.regimes.regime

```python
def regime(
    id: str,
    *,
    on: Point | Sequence[Point],
    lifetime: RegimeLifetime | str = RegimeLifetime.RUN,
    state: type | None = None,
    when: object | None = None,
    max_steps: int | None = None,
    on_limit: Callable[..., object] | None = None,
    owns: Sequence[str] = (),
    sets: Mapping[str, object] | None = None,
    minimum_duration: Duration | None = None,
    on_failure: OnFailure | str = OnFailure.DEFER,
) -> Callable[[_RegimeTarget], _RegimeTarget]
```

Declares an isolated regime handler without host I/O.

The decorator accepts a function `(ctx, next_)` or a class whose callable `apply(self, ctx, next_)` method has that shape. It records a `RegimeDeclaration` on the target's `__omp_regimes__` tuple and in the extension registry.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `id` | `str` | Non-empty declaration identity |
| `on` | `Point | Sequence[Point]` | One or more unique fixed points |
| `lifetime` | `RegimeLifetime | str` | Activation lifetime |
| `state` | `type | None` | Dataclass type for durable state |
| `when` | `object | None` | Data-only activation condition |
| `max_steps` | `int | None` | Committed-step limit, from `1` through `4294967295` |
| `on_limit` | `Callable[..., object] | None` | `(ctx, next_)` handler used at the limit |
| `owns` | `Sequence[str]` | Unique, non-empty resource names |
| `sets` | `Mapping[str, object] | None` | Settings scoped to the activation |
| `minimum_duration` | `Duration | None` | Non-negative minimum activation duration |
| `on_failure` | `OnFailure | str` | Failure behavior; default `DEFER` |

**Returns**

The decorator, which returns the original target unchanged.

**Raises**

- `LateRegistration` — declarations are already sealed.
- `TypeError` or `ValueError` — an argument has the wrong shape or range.
- `RegimeContractError` — points, lifetime, handler, limit, or failure behavior violates the contract.

### omp.regimes.start

```python
async def start(
    regime: str,
    *,
    state: object | None = None,
    queue: bool = False,
) -> RegimeHandle
```

Starts one declared regime, optionally waiting for owned resources.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `regime` | `str` | Registered regime id |
| `state` | `object | None` | Initial instance of the declared state dataclass |
| `queue` | `bool` | Queue on an ownership conflict when true |

**Returns**

A `RegimeHandle` for the active or queued activation.

**Raises**

- `LookupError` — the declaration is not registered.
- `RegimeContractError` — state is supplied to a stateless regime.
- `TypeError` — state does not match its declared type or `queue` is not `bool`.

```python
handle = await omp.regimes.start("bounded-batches", state=BatchBudget(), queue=True)
```

### omp.regimes.active

```python
async def active(*, extension: str | None = None) -> tuple[RegimeRecord, ...]
```

Lists activations owned by this extension, or by another extension when authorized with `regimes.read`.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `extension` | `str | None` | Extension id; `None` selects the caller |

**Returns**

Records in the order returned by Core.

**Raises**

- `ValueError` — `extension` is not `None` or a non-empty string.
- `StateDecodeError` — the host response has an invalid shape.

### omp.regimes.stop

```python
async def stop(activation_id: str) -> bool
```

Stops an activation owned by the calling extension.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `activation_id` | `str` | Non-empty activation identity |

**Returns**

`True` or `False` as returned by the host.

**Raises**

- `ValueError` — `activation_id` is empty or not a string.
- `TypeError` — the host returns a non-boolean result.

### omp.regimes.RegimeHandle

```python
RegimeHandle(id: str, regime: str, extension: str, status: str)
```

References an activation returned by `start()`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | required | Activation id |
| `regime` | `str` | required | Declaration id |
| `extension` | `str` | required | Owning extension id |
| `status` | `str` | required | `"active"` or `"queued"` |

#### RegimeHandle.stop

```python
async def stop(self) -> bool
```

Stops this activation through host CONTROL authority and returns the host's boolean result.

### omp.regimes.RegimeRecord

```python
RegimeRecord(id: str, regime: str, extension: str, status: str)
```

Projects one active or resource-queued activation.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | required | Activation id |
| `regime` | `str` | required | Declaration id |
| `extension` | `str` | required | Owning extension id |
| `status` | `str` | required | `"active"` or `"queued"` |

## Helpers

### omp.regimes.user_text

```python
def user_text(text: str) -> Mapping[str, object]
```

Builds one canonical user-message thread item for context insertion.

The returned mapping has fixed sequence and timestamp values of zero, a `ROLE_USER` message containing the text, and empty props.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `text` | `str` | Non-empty message text |

**Returns**

An immutable mapping accepted by `ctx.context.append()`.

**Raises**

`ValueError` if `text` is empty or not a string.

```python
ctx.context.append(omp.user_text("Continue from the last verified result."))
```

### omp.regimes.when

```python
when: Final[_WhenNamespace] = _WhenNamespace()
```

Provides data-only activation-condition builders.

#### when.checkpoint_active

```python
def checkpoint_active(self) -> Mapping[str, object]
```

Builds an immutable condition that activates at `CONTEXT` while a durable checkpoint is active.

```python
@omp.regime(
    "checkpoint-reminder",
    on=omp.CONTEXT,
    when=omp.when.checkpoint_active(),
)
def checkpoint_reminder(ctx, next_):
    ctx.context.append(omp.user_text("A checkpoint is active."))
```

## Errors

### omp.regimes.RegimeContractError

```python
class RegimeContractError(OmpError, ValueError)
```

Base error for invalid regime declarations and callbacks.

### omp.regimes.StateSchemaMismatch

```python
StateSchemaMismatch(expected: int, actual: int | None) -> None
```

Reports durable state encoded with an incompatible schema revision.

| Attribute | Type | Meaning |
|---|---|---|
| `expected` | `int` | Revision required by the declaration |
| `actual` | `int | None` | Revision received from the host |

### omp.regimes.StateDecodeError

```python
class StateDecodeError(RegimeContractError)
```

Reports durable state or activation data that cannot be rebuilt into the declared shape.
