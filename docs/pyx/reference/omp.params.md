# `omp.params`

`omp.params` defines the declaration metadata, linear argument cursors, repair records, interrupts, and structured validation failures used by the invocation argument protocol. Use `@omp.params` to declare a frozen argument shape. Host integrations use `IncomingParams` when consuming an arriving argument document.

All public names below are also available from `omp` unless shown as attributes on the `omp.params` decorator namespace.

## Minimal example

```python
from typing import Annotated

import omp


@omp.params
class SearchParams:
    query: Annotated[
        str,
        omp.Field(
            "Text to find.",
            alias=("q",),
            coerce=(omp.Coerce.STRING, omp.Coerce.STRIP),
            example="DeviceInfo",
        ),
    ]
    limit: Annotated[
        int,
        omp.Field(coerce=(omp.Coerce.INTEGER,), example="20"),
    ] = 20
```

## Declaring a shape

### `omp.params.params`

```python
def params(
    cls: type[Any] | None = None,
) -> type[Any] | Callable[[type[Any]], type[Any]]
```

Freezes a parameter class as a slotted dataclass and compiles its field metadata once.

Use it with or without parentheses:

```python
@omp.params
class First:
    value: int


@omp.params()
class Second:
    value: int
```

If the target is already a dataclass, it must be frozen and slotted. The decorator sets `__omp_params__` and an immutable `__omp_param_fields__` registry on the resulting class.

**Parameters**

- `cls` (`type[Any] | None`) — class to decorate, or `None` when called as a decorator factory.

**Returns**

The decorated class, or a class decorator.

**Raises**

- `TypeError` for a non-class target, a mutable or unslotted existing dataclass, multiple `Field` values on one field, or invalid metadata.
- `ValueError` when two fields claim the same canonical or alias spelling, or one field repeats an alias.

### `omp.params.Alias`

```python
Alias(*names: str)
```

Declares additional accepted spellings for one canonical field key.

| Field | Type | Meaning |
|---|---|---|
| `names` | `tuple[str, ...]` | Non-empty unique aliases in declaration order. |

`@omp.params` lowers `Alias` metadata into the field's `Field.alias` tuple.

**Raises**

- `TypeError` when no names are supplied or a name is not a non-empty string.
- `ValueError` when a name is repeated.

```python
@omp.params
class MoveParams:
    destination: Annotated[str, omp.Alias("dest", "to")]
```

## Related top-level schema metadata

`Field` and `Coerce` live at the `omp` package root rather than in `params.py`, but they are the metadata vocabulary consumed by `@omp.params`.

### `omp.Field`

```python
Field(
    description: str | None = None,
    *,
    additional_properties: bool = False,
    alias: tuple[str, ...] = (),
    coerce: tuple[Coerce, ...] = (),
    expected: str | None = None,
    example: str | None = None,
)
```

Carries declarative metadata for an `Annotated` argument field.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `description` | `str | None` | `None` | Schema-facing description. |
| `additional_properties` | `bool` | `False` | Allow enumeration and retention of undeclared object members. |
| `alias` | `tuple[str, ...]` | `()` | Accepted alternate key spellings. |
| `coerce` | `tuple[Coerce, ...]` | `()` | Ordered declared coercions. |
| `expected` | `str | None` | `None` | Human-readable expected shape. |
| `example` | `str | None` | `None` | Example included in an argument issue. |

Construction freezes alias and coercion sequences and validates their members.

### `omp.Coerce`

```python
class Coerce(StrEnum)
```

Names an ordered, journaled argument coercion.

| Member | Wire value | Applied conversion |
|---|---|---|
| `LOOSE_BOOL` | `"loose_bool"` | `"true"`, `"yes"`, `"1"`, or numeric `1` to `True`; corresponding false forms to `False`. |
| `INTEGER` | `"integer"` | Integer text or an in-range integral float to an integer. |
| `NUMBER` | `"number"` | Finite numeric text to a number. |
| `STRING` | `"string"` | A non-string JSON value to its string spelling; lossy object/array conversion is blocked in union branches. |
| `SINGLETON` | `"singleton"` | A non-array value to a one-item array; lossy conversion is blocked in union branches. |
| `JSON_STRING` | `"json_string"` | Parse a string's content as tolerant JSON. |
| `STRIP` | `"strip"` | Trim surrounding whitespace from a string. |
| `CSV` | `"csv"` | Split a comma-containing string and trim each item. |
| `NULL_ELISION` | `"null_elision"` | Elide `null`, `"null"`, or an empty string. |

Coercions run in declaration order. A coercion that does not apply leaves the value unchanged and lets the next coercion run. Each applied step produces a `Repair`; `NULL_ELISION` produces `RepairKind.ELISION`, and the others produce `RepairKind.COERCION`.

## Repairs

### `omp.params.RepairKind`

```python
class RepairKind(StrEnum)
```

Classifies a charitable argument repair.

| Member | Wire value | Meaning |
|---|---|---|
| `ALIAS` | `"alias"` | An alternate key was mapped to its canonical key. |
| `COERCION` | `"coercion"` | A declared value coercion changed the value. |
| `TOLERANCE` | `"tolerance"` | The tolerant parser accepted non-canonical syntax. |
| `ELISION` | `"elision"` | A field or value was omitted during canonicalization. |

### `omp.params.Repair`

```python
Repair(
    path: tuple[str | int, ...],
    kind: RepairKind,
    detail: str,
)
```

Records one exact path-addressed repair.

| Field | Type | Meaning |
|---|---|---|
| `path` | `tuple[str | int, ...]` | Canonical object keys and non-negative array indexes. |
| `kind` | `RepairKind` | Repair category. |
| `detail` | `str` | Non-empty description of the transformation. |

**Raises**

- `TypeError` for invalid path parts, kind, or detail.

## Argument issues

### `omp.params.ArgIssueKind`

```python
class ArgIssueKind(StrEnum)
```

Classifies a stable finalization or pull failure.

| Member | Wire value | Meaning |
|---|---|---|
| `MISSING` | `"missing"` | A required path is absent. |
| `INCOMPLETE` | `"incomplete"` | Input ended before the selected value completed. |
| `ABORTED` | `"aborted"` | The input feed was abandoned. |
| `MALFORMED` | `"malformed"` | Complete input could not be parsed or decoded. |
| `TYPE_MISMATCH` | `"type_mismatch"` | The observed JSON shape differs from the requested shape. |
| `AMBIGUOUS` | `"ambiguous"` | Multiple source keys select one canonical field. |
| `PROTOCOL` | `"protocol"` | Invocation framing violated the cursor protocol. |

### `omp.params.ArgIssue`

```python
ArgIssue(
    path: tuple[str | int, ...],
    expected: str,
    kind: ArgIssueKind,
    example: str | None = None,
    found: str | None = None,
)
```

Describes a validation failure without choosing model-facing wording.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | `tuple[str | int, ...]` | required | Canonical keys and array indexes. |
| `expected` | `str` | required | Non-empty expected-shape description. |
| `kind` | `ArgIssueKind` | required | Stable issue category. |
| `example` | `str | None` | `None` | Optional valid example. |
| `found` | `str | None` | `None` | Observed shape description. |

**Raises**

- `TypeError` for invalid path parts or field types.

### `omp.params.ArgFault`

```python
ArgFault(
    issue_or_path: ArgIssue | tuple[str | int, ...],
    kind: ArgIssueKind | None = None,
    detail: str | None = None,
    example: str | None = None,
)
```

Raises one structured `ArgIssue` from a pull or finalization. It derives from both `ValueError` and `OmpError`.

Pass either an existing issue with no other payload fields, or a path plus `kind` and a non-empty `detail`. The exception exposes `issue`, `path`, `kind`, `detail`, and `example`.

**Raises**

- `TypeError` for a mixed constructor form or incomplete path form.

```python
raise omp.ArgFault(
    ("limit",),
    omp.ArgIssueKind.TYPE_MISMATCH,
    "expected an integer",
    "20",
)
```

### `omp.params.Args`

```python
Args(issue: ArgIssue)
```

Terminal streaming event carrying one structured pulled-argument failure.

| Field | Type | Meaning |
|---|---|---|
| `issue` | `ArgIssue` | Failure to settle as an argument rejection. |

**Raises**

- `TypeError` unless `issue` is an `ArgIssue`.

## Linear cursors

### `omp.params.IncomingParams`

```python
IncomingParams(
    *,
    name: str,
    rev: Rev,
    invocation_id: str,
    owner: str | None = None,
    phase: InvocationPhase = InvocationPhase.OPEN,
    deadline: Duration | None = None,
    shape: type[Any] | None = None,
)
```

Represents one host-owned, linear argument document. Host code constructs it with an active control backend; ordinary `@omp.device` bodies receive finalized mappings instead.

**Parameters**

- `name` (`str`) — non-empty device name.
- `rev` (`Rev`) — typed argument revision.
- `invocation_id` (`str`) — non-empty host correlation identifier.
- `owner` (`str | None`) — optional owner identifier.
- `phase` (`InvocationPhase`) — initial monotonic phase.
- `deadline` (`Duration | None`) — optional invocation deadline.
- `shape` (`type[Any] | None`) — default typed decode target.

**Raises**

- `TypeError` for an invalid constructor field.

#### `IncomingParams.phase`

```python
@property
def phase(self) -> InvocationPhase
```

Returns the latest observed invocation phase.

#### `IncomingParams.is_authorized`

```python
@property
def is_authorized(self) -> bool
```

Returns whether the phase has reached `EFFECTS_AUTHORIZED`.

#### `IncomingParams.arg`

```python
def arg(
    self,
    name: str,
    *,
    alias: tuple[str, ...] = (),
    coerce: object | tuple[object, ...] | None = None,
    example: str | None = None,
) -> Arg
```

Binds a cheap, one-shot cursor to one canonical top-level argument. Metadata declared on `shape` is combined with explicit aliases; explicit `coerce` and `example` replace their declared defaults when supplied.

#### `IncomingParams.args`

```python
async def args(self, shape: type[Any] | None = None) -> Any
```

Waits for strict finalization, then decodes the canonical argument value. A dataclass target is constructed from a mapping; another class is called with the value.

**Raises**

- `TypeError` if `shape` is not a type or `None`.
- `ArgFault` if finalization or typed construction fails.
- `ParamsProtocol` for an invalid host response.

#### `IncomingParams.raw`

```python
async def raw(self) -> str
```

Returns the exact completed provider emission before repairs.

#### `IncomingParams.committed`

```python
async def committed(self) -> str
```

Waits for effect authorization, advances the local phase, and returns canonical effective argument text.

**Raises**

- `CommitAborted` if the assistant item disappeared.
- `ParamsProtocol` if the host returns a non-string result.

#### `IncomingParams.interruptable`

```python
def interruptable(self) -> InterruptibleParams
```

Returns an interrupt-observing view over this same cursor. The API intentionally uses the source spelling `interruptable`.

#### `IncomingParams.take_interrupt`

```python
def take_interrupt(self) -> Interrupt | None
```

Removes and returns the oldest queued interrupt without waiting.

#### `IncomingParams.next_interrupt`

```python
async def next_interrupt(self) -> Interrupt
```

Waits for and consumes the next structured interrupt.

**Raises**

- `InterruptClosed` when the owner closes the interrupt stream.
- `ParamsProtocol` for an invalid host value.

#### `IncomingParams.repairs`

```python
def repairs(self) -> list[Repair]
```

Returns a new list containing repairs observed so far.

### `omp.params.Arg`

```python
Arg(
    params: IncomingParams,
    path: tuple[str | int, ...],
    *,
    aliases: tuple[str, ...] = (),
    coercions: tuple[object, ...] = (),
    example: str | None = None,
    declared: object = Any,
    additional_properties: bool = False,
    interruptible: bool = False,
)
```

Represents one one-shot JSON value. You normally obtain it from `IncomingParams.arg`, `ArgObject.key`, or a container iterator.

Awaiting an `Arg` pulls a value using its declared expected shape:

```python
value = await params.arg("query")
```

Every consumption method claims the cursor. Reusing it raises `ParamsMisuse`.

#### Scalar pulls

```python
async def text(self) -> str
async def number(self) -> float
async def integer(self) -> int
async def boolean(self) -> bool
async def null(self) -> None
async def value(self) -> str | int | float | bool | None | list[Any] | dict[str, Any]
async def typed(self, target: type[Any]) -> Any
async def raw(self) -> str
```

`text`, `number`, `integer`, `boolean`, and `null` enforce the named JSON shape. `integer` accepts an integral float and returns `int`; booleans are never numbers. `value` accepts any JSON value. `typed` decodes with the requested class. `raw` returns exact argument text.

**Raises**

- `ArgFault(TYPE_MISMATCH)` when a scalar has the wrong shape.
- `TypeError` if `typed` receives a non-type.
- `ParamsMisuse` when the cursor is consumed twice.
- `ParamsProtocol` for non-JSON or wrongly framed host results.

#### Streaming and containers

```python
def chunks(self) -> AsyncIterator[str]
def lines(self) -> AsyncIterator[str]
def array(self) -> ArgArray
def object(self) -> ArgObject
async def optional(self, default: Any) -> Any
```

`chunks` and `lines` yield string fragments until the host returns `None`. `array` and `object` transfer ownership to a container cursor. `optional` returns `default` only for `ArgIssueKind.MISSING`; every other `ArgFault` propagates.

### `omp.params.ArgArray`

```python
ArgArray(arg: Arg)
```

Consumes one array linearly.

#### `ArgArray.index`

```python
@property
def index(self) -> int
```

Returns the number of element cursors handed out so far.

#### `ArgArray.__aiter__`

```python
def __aiter__(self) -> AsyncIterator[Arg]
```

Iterates element cursors. Finish each element before advancing.

#### `ArgArray.next`

```python
async def next(self) -> Arg | None
```

Returns the next element cursor or `None` after the array closes.

#### `ArgArray.collect`

```python
async def collect(self) -> list[Any]
```

Waits for and returns the entire array.

**Raises**

- `ParamsMisuse` if iteration and collection are mixed or the active element has not finished.
- `ArgFault(TYPE_MISMATCH)` if collection does not produce an array.

### `omp.params.ArgObject`

```python
ArgObject(arg: Arg, *, additional_properties: bool)
```

Consumes one object through declared keys, whole collection, or explicit open-map enumeration.

#### `ArgObject.key`

```python
def key(
    self,
    name: str,
    *,
    alias: tuple[str, ...] = (),
    coerce: object | tuple[object, ...] | None = None,
    example: str | None = None,
) -> Arg
```

Binds a child cursor to one canonical member.

#### `ArgObject.collect`

```python
async def collect(self) -> dict[str, Any]
```

Returns the completed string-keyed object.

#### `ArgObject.keys`

```python
def keys(self) -> AsyncIterator[tuple[str, Arg]]
```

Enumerates member name and cursor pairs for a field declared with `additional_properties=True`.

**Raises**

- `ParamsMisuse` when the object was already consumed or open-map enumeration was not declared.
- `ArgFault(TYPE_MISMATCH)` if collection does not produce a string-keyed object.
- `ParamsProtocol` if the host returns an invalid member key.

### `omp.params.InterruptibleParams`

```python
InterruptibleParams(params: IncomingParams)
```

Wraps the same linear cursor and makes waits observe queued interrupts.

#### `InterruptibleParams.arg`

```python
def arg(
    self,
    name: str,
    *,
    alias: tuple[str, ...] = (),
    coerce: object | tuple[object, ...] | None = None,
    example: str | None = None,
) -> Arg
```

Returns an interruptible `Arg` with the same metadata rules as `IncomingParams.arg`.

#### Interruptible whole-document operations

```python
async def args(self, shape: type[Any] | None = None) -> Any
async def raw(self) -> str
async def committed(self) -> str
```

These mirror the corresponding `IncomingParams` operations but may raise `Interrupted` before completion.

## Interrupts and invocation termination

### `omp.params.Interrupt`

```python
Interrupt(kind: str, reason: str)
```

Carries one cooperative interrupt.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `str` | Non-empty stable interrupt class. |
| `reason` | `str` | Human-readable cause or steering text. |

| Class constant | Value | Meaning |
|---|---|---|
| `STEERING` | `"steering"` | New steering input arrived. |
| `ESCAPE` | `"escape"` | Explicit cancellation. |
| `DEADLINE` | `"deadline"` | Invocation deadline elapsed. |
| `SHUTDOWN` | `"shutdown"` | Invocation owner is shutting down. |

Treat `kind` as open to future values.

### `omp.params.InvocationEnded`

```python
class InvocationEnded(OmpError)
```

Base exception for clean invocation termination while a device is running.

### `omp.params.CommitAborted`

```python
CommitAborted(detail: str = "assistant item was not committed")
```

Signals that the assistant item disappeared before effects could be authorized. The `detail` attribute retains the supplied text.

### `omp.params.Interrupted`

```python
Interrupted(interrupt: Interrupt)
```

Signals that an interruptible operation observed an `Interrupt`. Exposes `interrupt`, `kind`, and `reason`.

**Raises**

- `TypeError` unless passed an `Interrupt`.

### `omp.params.InterruptClosed`

```python
InterruptClosed(detail: str = "interrupt stream closed")
```

Signals that the invocation owner disappeared before another interrupt arrived.

### `omp.params.ParamsMisuse`

```python
class ParamsMisuse(OmpError)
```

Signals a local violation of linear cursor ownership, such as concurrent pulls, cursor reuse, or advancing a container before consuming its active child.

### `omp.params.ParamsProtocol`

```python
ParamsProtocol(detail: str)
```

Signals invalid host or transport framing. Exposes `detail`.

**Raises**

- `TypeError` if `detail` is empty or not a string.

## Abort events

### `omp.params.Abort`

```python
Abort(kind: str, detail: str | None = None)
```

Describes why an invocation produced no normal device result.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `str` | required | One of the five declared abort kinds. |
| `detail` | `str | None` | `None` | Optional explanation. |

| Constant | Value |
|---|---|
| `SKIPPED` | `"skipped"` |
| `INTERRUPTED` | `"interrupted"` |
| `EFFECTS_UNKNOWN` | `"effects_unknown"` |
| `INPUT_DROPPED` | `"input_dropped"` |
| `MISSING_OUTCOME` | `"missing_outcome"` |

**Raises**

- `ValueError` for an unknown kind.
- `TypeError` for an invalid detail.

#### Abort constructors

```python
@classmethod
def skipped(cls, reason: str) -> Abort

@classmethod
def interrupted(cls, reason: str) -> Abort

@classmethod
def effects_unknown(cls, reason: str) -> Abort

@classmethod
def input_dropped(cls) -> Abort

@classmethod
def missing_outcome(cls) -> Abort
```

The first three require a non-empty reason. `input_dropped` and `missing_outcome` carry no detail.

## Event type

### `omp.params.Ev`

```python
Ev: TypeAlias = Update[Any] | Args | Aborted | Done[Any] | Detached
```

Union of streaming progress and terminal event types. `Update` is progress; `Args`, `Aborted`, `Done`, and `Detached` are terminal event vocabulary. See [Verdicts](verdicts.md) for their durable shapes.

## Constants

### `omp.params.MAX_NESTING_DEPTH`

```python
MAX_NESTING_DEPTH: int = 128
```

Maximum declared argument nesting depth.

### `omp.params.INTERRUPT_GRACE`

```python
INTERRUPT_GRACE: Duration = Duration("150ms")
```

Courtesy interval for cooperative interrupt handling.

### `omp.params.MAX_PENDING_PULLS`

```python
MAX_PENDING_PULLS: int = 1
```

Maximum simultaneous pending pulls on one `IncomingParams` cursor.

These constants are also attached to the decorator object as `omp.params.MAX_NESTING_DEPTH`, `omp.params.INTERRUPT_GRACE`, and `omp.params.MAX_PENDING_PULLS`.

## Validation model

Finalization produces one canonical JSON value. It rejects competing keys that select the same canonical field, malformed completed input, and values that cannot satisfy their requested shapes. Accepted aliases, coercions, tolerant syntax, and elisions are recorded as `Repair` values rather than hidden.

Cursor errors have two origins:

- `ArgFault` means the argument itself could not satisfy a requested contract.
- `ParamsMisuse` means extension or adapter code broke linear ownership.
- `ParamsProtocol` means the host or transport returned invalid framing.

Do not collapse these into one catch-all validation message; callers can retry an `ArgFault`, while misuse and protocol failures indicate code or harness defects.
