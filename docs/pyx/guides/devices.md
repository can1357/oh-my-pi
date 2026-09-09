# Build a device

A device is a callable that `omp` registers in the host catalog. Use one when you want an extension to expose a typed operation with a stable identity, documented arguments, bounded effects, and a durable result.

This guide starts with a small device and adds schema metadata, progress previews, typed failures, and operational safeguards. For the complete declaration and catalog API, see [`omp.devices`](../reference/omp.devices.md). The result types are covered in [Verdicts](../reference/verdicts.md).

## A minimal device

A declaration fixes the device name and semantic revision. The decorated name becomes a [`Device`](../reference/omp.devices.md#ompdevicesdevice) handle; its `.body` attribute retains the original callable.

```python
from collections.abc import Mapping
import dataclasses

import omp


@dataclasses.dataclass(frozen=True, slots=True)
class Greeting(omp.Payload):
    message: str


@omp.device(
    "greet",
    rev=1,
    summary="Create a greeting for one person.",
    schema={
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "required": ["name"],
        "additionalProperties": False,
    },
)
async def greet(
    args: Mapping[str, object],
    ctx: omp.Context,
) -> Greeting:
    return Greeting(message=f"Hello, {args['name']}!")
```

`name="greet"` is the catalog address. Names begin with a lowercase ASCII letter and then use lowercase letters, digits, or underscores; each path segment is at most 64 characters. `rev=1` identifies the argument and result contract. Increment it when callers need a different decoder for the new schema or durable result shape, not merely because prose changed.

The host calls a regular `@omp.device` body with the finalized argument mapping. A two-parameter body receives `(args, ctx)`; a one-parameter body receives `args`. The body starts after effects are authorized. If you prefer ordinary keyword parameters, `@omp.tool` provides that ergonomic form while using the same device registry.

## Declare an argument shape

Use `@omp.params` to freeze a slotted dataclass that describes the JSON object. Attach [`Field`](../reference/omp.params.md#ompfield) metadata through `typing.Annotated`.

```python
from typing import Annotated


@omp.params
class GreetParams:
    name: Annotated[
        str,
        omp.Field(
            "Person to greet.",
            alias=("person",),
            coerce=(omp.Coerce.STRING, omp.Coerce.STRIP),
            example="Ada",
        ),
    ]
    excited: Annotated[
        bool,
        omp.Field(
            "Add emphatic punctuation.",
            coerce=(omp.Coerce.LOOSE_BOOL,),
            example="true",
        ),
    ] = False
```

Pass the type as the declaration schema:

```python
@omp.device(
    "greet",
    rev=2,
    schema=GreetParams,
    summary="Create a normalized greeting.",
)
async def greet_v2(
    args: Mapping[str, object],
    ctx: omp.Context,
) -> Greeting:
    suffix = "!" if args.get("excited", False) else "."
    return Greeting(message=f"Hello, {args['name']}{suffix}")
```

`Field.alias` lists accepted alternate keys. A call must not contain both a canonical name and one of its aliases. `Field.coerce` is an ordered tuple of explicit repairs. Each repair is observable as an [`omp.Repair`](../reference/omp.params.md#ompparamsrepair); undeclared conversions are not applied.

Available coercions are:

| Coercion | Intended conversion |
|---|---|
| `LOOSE_BOOL` | Common string or numeric boolean spellings to `bool` |
| `INTEGER` | Integer text or an integral float to `int` |
| `NUMBER` | Numeric text to a number |
| `STRING` | A scalar value to text |
| `SINGLETON` | A non-list value to a one-item list |
| `JSON_STRING` | JSON stored inside a string to its decoded value |
| `STRIP` | Remove surrounding whitespace from text |
| `CSV` | Comma-separated text to a list |
| `NULL_ELISION` | Treat an allowed null-like placeholder as an omitted optional field |

Use coercions only when the alternate representation has one clear meaning. The finalizer rejects duplicate or competing spellings as `ArgIssueKind.AMBIGUOUS` rather than guessing.

> **Note** `omp.Alias("person")` is another accepted `Annotated` spelling. The `@omp.params` decorator lowers it into `Field.alias` when the class is declared.

## Availability is separate from identity

A declaration can remain in the catalog while temporarily unavailable. Supply a zero-argument predicate to `@omp.device`:

```python
def greeting_service_available() -> omp.Availability:
    configured = load_greeting_configuration()
    if configured:
        return omp.Availability(mounted=True)
    return omp.Availability(
        mounted=False,
        reason="greeting configuration is missing",
    )


@omp.device(
    "greet",
    rev=3,
    schema=GreetParams,
    available=greeting_service_available,
)
async def greet_v3(args: Mapping[str, object], ctx: omp.Context) -> Greeting:
    return Greeting(message=f"Hello, {args['name']}!")
```

The predicate is deferred until the host freezes the declaration set. For runtime-discovered leaves, declare a parent with `omp.devices.parent(...)`, mount [`MountSpec`](../reference/omp.devices.md#ompdevicesmountspec) values, and change reachability with `await omp.devices.set_availability(...)`. Mounting establishes a leaf's identity and schema; availability reports whether that identity is currently reachable.

Use `await omp.devices.enable(*paths)` or `disable(*paths, reason=...)` to make one batched transition. `omp.devices.list()` returns immutable [`DeviceInfo`](../reference/omp.devices.md#ompdevicesdeviceinfo) snapshots.

## Input arrival and finalization

A normal extension device does **not** receive speculative argument fragments. It receives one complete, effective argument mapping after finalization, admission, assistant-item commitment, and effect authorization. This prevents extension code from observing data for a call that policy later denies or rewrites.

[`IncomingParams`](../reference/omp.params.md#ompparamsincomingparams) is the host-constructed linear cursor used by the streaming input machinery. It is public vocabulary so host integrations can describe and test that protocol, but `@omp.device` does not inject it into third-party bodies.

The cursor model is useful when reading traces or implementing a host adapter:

```python
async def read_streamed_input(params: omp.IncomingParams) -> tuple[str, int]:
    query = await params.arg("query").text()
    limit = await params.arg("limit").optional(20)
    await params.committed()
    return query, int(limit)
```

A pull completes when its JSON value is available. Only one pull may be pending (`MAX_PENDING_PULLS == 1`), and every `Arg` is one-shot. Arrays and objects preserve that linear ownership: finish the current child before advancing to the next one.

`params.args(Shape)` waits for strict finalization and constructs `Shape` when possible. `params.raw()` returns the exact completed provider emission before repairs. `params.committed()` waits for effect authorization and returns the canonical effective argument text.

> **Warning** Do not annotate a normal device body with `IncomingParams` expecting streaming injection. The regular worker adapter supplies the finalized mapping. Input streaming and output streaming are different features.

## Emit progress and previews

A device can be an async generator. Yield [`Update`](../reference/verdicts.md#ompupdate) values while work progresses and exactly one [`Done`](../reference/verdicts.md#ompdone) terminal value. Updates are ephemeral; the `Done` result becomes durable truth.

```python
from collections.abc import AsyncIterator


async def inspect_name(name: str) -> str:
    return name.strip().title()


@omp.device(
    "greet",
    rev=4,
    schema=GreetParams,
    summary="Preview and create a normalized greeting.",
)
async def greet_v4(
    args: Mapping[str, object],
    ctx: omp.Context,
) -> AsyncIterator[omp.Update[object] | omp.Done[Greeting]]:
    normalized = await inspect_name(str(args["name"]))
    yield omp.Update(stage="preview", text=f"Hello, {normalized}!")
    yield omp.Done(Greeting(message=f"Hello, {normalized}!"))
```

`Update(payload)` accepts one typed payload. `Update(**fields)` stores the keyword fields as a dictionary. Prefer a small, stable update shape that a renderer can fold cheaply. A stream that ends without `Done` has no normal result.

## Return typed success and failure values

Subclass `omp.Payload` for success and `omp.Fault` for an expected, actionable failure. Both must be frozen dataclass values with serializable annotations.

```python
@dataclasses.dataclass(frozen=True, slots=True)
class Greeting(omp.Payload):
    message: str


@dataclasses.dataclass(frozen=True, slots=True)
class GreetingFault(omp.Fault):
    code: str
    supplied_name: str
    detail: str
```

Grow the example into a previewing device with a typed domain failure:

```python
@omp.device(
    "greet",
    rev=5,
    schema=GreetParams,
    summary="Validate, preview, and create a greeting.",
    effects=omp.Effects(
        documents=omp.DocEffects(read=True),
        inference=omp.InferenceEffects(max_requests=0, max_usd=0.0),
    ),
    deadline=omp.Duration("5s"),
)
async def greet_v5(
    args: Mapping[str, object],
    ctx: omp.Context,
) -> AsyncIterator[
    omp.Update[object]
    | omp.Done[Greeting]
    | omp.Done[GreetingFault]
]:
    supplied = str(args["name"])
    normalized = supplied.strip().title()

    yield omp.Update(stage="preview", text=f"Hello, {normalized}!")

    if not normalized:
        yield omp.Done(
            GreetingFault(
                code="empty_name",
                supplied_name=supplied,
                detail="Provide at least one visible character.",
            )
        )
        return

    yield omp.Done(Greeting(message=f"Hello, {normalized}!"))
```

Returning a `Payload` settles as `Ok(payload)`. Returning a `Fault` settles as `Faulted(fault)` and marks the result as an expected error. An arbitrary raised exception is a device bug, not a typed rejection.

### Resolve, reject, propose, and report an issue

These words have distinct roles; none is a Python verdict constructor:

- A device **resolves successfully** by returning a `Payload`, directly or through `Done`.
- A device **rejects an expected domain request** by returning a typed `Fault`. Do not raise the fault value.
- A device that stages an environment proposal returns the proposal's typed payload. The model-facing `dyn resolve "reason"` and `dyn reject "reason"` commands act on the newest pending staged proposal; they are not calls your Python body makes.
- `report_issue` is a reserved host device for recording an observed mismatch between a device's documentation and structured result. It is invoked separately with the session, device, revision, and a structured verdict; do not disguise an ordinary device fault as an issue report.

`resolve`, `reject`, `propose`, and `report_issue` are reserved declaration names. Choose an extension-owned device name instead.

## Declare effect and quota ceilings

[`Effects`](../reference/omp.devices.md#ompdeviceseffects) describes the maximum static envelope:

```python
omp.Effects(
    documents=omp.DocEffects(
        read=True,
        write_globs=("reports/**/*.json",),
    ),
    exec=omp.ExecEffects(
        commands=("git",),
        network=False,
    ),
    inference=omp.InferenceEffects(
        max_requests=1,
        max_usd=0.02,
    ),
    subagents=0,
)
```

Declare the narrowest truthful ceiling. Admission and runtime enforcement may grant less. If a hard per-extension quota is exhausted, `omp.QuotaExceeded` exposes the quota name and an optional resource receipt. Let infrastructure quota failures remain distinguishable from domain `Fault` values unless your public contract explicitly models a meaningful recovery.

Device documentation also has fixed budgets: `HARD_SLOT_BUDGET` is `8`, `EXTERNAL_SUMMARY_CAP` is `200`, and `PER_DEVICE_CAP` is `10_000`. Exceeding a documentation allowance raises `DocsBudgetError` during declaration or projection rather than silently changing the contract.

## Handle cancellation cleanly

For a normal device, cancellation is ordinary task cancellation at an `await`. Keep acquired resources inside async context managers or `try/finally`, and re-raise `asyncio.CancelledError` after local cleanup:

```python
import asyncio


async def cancellable_work(lease: object) -> Greeting:
    try:
        value = await perform_work(lease)
        return Greeting(message=value)
    except asyncio.CancelledError:
        await release_preview(lease)
        raise
```

The streaming cursor has an additional cooperative surface. `params.interruptable()` returns a view whose pulls can raise `Interrupted`; `next_interrupt()` consumes structured steering, escape, deadline, or shutdown notices. `CommitAborted` means the assistant item vanished before effects were authorized. `InterruptClosed` means the invocation owner disappeared. They all derive from `InvocationEnded` where appropriate, so a host-side streaming adapter can use one cleanup path.

```python
async def wait_interruptibly(params: omp.IncomingParams) -> str | omp.Aborted:
    try:
        return await params.interruptable().committed()
    except omp.Interrupted as exc:
        return omp.Aborted(omp.Abort.interrupted(exc.reason))
```

> **Warning** The last example illustrates cursor event conversion for a host adapter. A regular `@omp.device` body should normally allow task cancellation to propagate; it should not manufacture a cancellation verdict after effects may have landed.

## Next steps

- Browse catalog, dynamic mounting, constraints, and effect types in [`omp.devices`](../reference/omp.devices.md).
- Define aliases, coercions, cursors, repairs, and argument faults with [`omp.params`](../reference/omp.params.md).
- Define durable values, streaming events, codecs, and projections in [Verdicts](../reference/verdicts.md).
