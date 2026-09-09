# Verdicts and projections

A verdict is the durable, typed outcome of a device call. The implementation lives in `omp._verdicts`, but its public vocabulary is re-exported at the `omp` package root. This is the canonical reference page: write `omp.Payload`, `omp.Done`, and `omp.dumps`, not imports from the private `_verdicts` module.

Use these types to separate durable truth from its model-facing projection. A device returns a success payload or a typed `omp.Fault`; streaming devices wrap a terminal value in `Done`. The host records one `CallOutcome` and projects it later under explicit limits.

## Minimal example

```python
import dataclasses
import omp


@dataclasses.dataclass(frozen=True, slots=True)
class Counted(omp.Payload):
    count: int


value = Counted(count=3)
encoded = omp.dumps(value)
assert omp.loads(encoded, Counted) == value
```

`omp.Fault` is the corresponding top-level marker for expected failure values. It is defined by the package root and follows the same frozen-dataclass and codec rules as `Payload`.

## Durable success and failure

### `omp.Payload`

```python
Payload(*, terminate: bool = False)
```

Marker base for a device's durable success value. Do not instantiate `Payload` itself; subclass it with a frozen, slotted dataclass.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `terminate` | `bool` | `False` | Terminal-control hint omitted from durable serialization. |

Subclass annotations are validated when the subclass is created. Unsupported field types raise `VerdictSchemaError`.

```python
@dataclasses.dataclass(frozen=True, slots=True)
class SearchResult(omp.Payload):
    paths: list[str]
    total: int
```

#### `Payload.useless`

```python
def useless(self) -> bool
```

Returns whether compaction may omit this value's prompt projection. The default is `False`; override it with a cheap, deterministic predicate.

### `omp.Fault`

```python
Fault(*, terminate: bool = False)
```

Marker base for a device's durable, expected failure value. `Fault` is defined at the `omp` package root rather than in `_verdicts`, but this page owns its verdict semantics.

Like `Payload`, the base itself cannot be instantiated. Define a frozen, slotted dataclass subclass and return an instance as a value; do not raise it as an exception.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `terminate` | `bool` | `False` | Terminal-control hint omitted from durable serialization. |

```python
@dataclasses.dataclass(frozen=True, slots=True)
class SearchFault(omp.Fault):
    code: str
    detail: str
```

#### `Fault.useless`

```python
def useless(self) -> bool
```

Returns whether compaction may omit this fault's prompt projection. The default is `False`.

### `omp.Ok`

```python
Ok(payload: _P)
```

Represents a settled successful call.

| Field | Type | Meaning |
|---|---|---|
| `payload` | `_P` | Durable `Payload` value. |

### `omp.Faulted`

```python
Faulted(fault: _F)
```

Represents a settled expected failure.

| Field | Type | Meaning |
|---|---|---|
| `fault` | `_F` | Durable typed fault value. |

A device normally returns the `omp.Fault` value itself. The worker lowers it to `Faulted`; construct `Faulted` directly when working with projections or recorded outcomes.

### `omp.ArgsRejected`

```python
ArgsRejected(issue: object)
```

Records a harness-owned structured argument rejection.

| Field | Type | Meaning |
|---|---|---|
| `issue` | `object` | Usually an [`ArgIssue`](omp.params.md#ompparamsargissue). |

### `omp.AbortKind`

```python
class AbortKind(StrEnum)
```

Classifies a call that settled without a normal device result.

| Member | Wire value | Meaning |
|---|---|---|
| `CANCELLED` | `"cancelled"` | Dispatched work did not finish normally. |
| `SKIPPED` | `"skipped"` | Work was not dispatched. |
| `POLICY_DENIED` | `"policy_denied"` | Admission policy denied the call. |

### `omp.Aborted`

```python
Aborted(
    abort: object,
    kind: AbortKind | None = None,
    policy: object | None = None,
)
```

Records an abnormal harness- or core-owned settlement.

| Field | Type | Meaning |
|---|---|---|
| `abort` | `object` | Fine-grained abort reason. |
| `kind` | `AbortKind` | Coarse durable category. |
| `policy` | `object | None` | Policy payload for `POLICY_DENIED` only. |

When `kind` is omitted, the constructor derives `SKIPPED` from an abort whose `.kind` is `"skipped"`. It derives `CANCELLED` from `"interrupted"`, `"effects_unknown"`, `"input_dropped"`, or `"missing_outcome"`.

**Raises**

- `ValueError` if `kind` cannot be derived, or if `policy` is present for a non-policy abort or absent for `POLICY_DENIED`.
- `TypeError` unless `kind` is an `AbortKind`.

```python
outcome = omp.Aborted(omp.Abort.interrupted("user cancelled"))
assert outcome.kind is omp.AbortKind.CANCELLED
```

### `omp.CallOutcome`

```python
CallOutcome = Ok[_P] | Faulted[_F] | ArgsRejected | Aborted
```

Closed union of the four durable settlement arms. Device code produces success and expected-failure values; the host constructs the final wrapper and owns argument rejection and abnormal settlement.

## Postconditions

### `omp.PostconditionStatus`

```python
class PostconditionStatus(StrEnum)
```

Classifies a finding attached after a call settles.

| Member | Wire value | Meaning |
|---|---|---|
| `PASSED` | `"passed"` | Downstream verification passed. |
| `REJECTED` | `"rejected"` | Downstream verification found a problem. |

### `omp.Postcondition`

```python
Postcondition(
    status: PostconditionStatus,
    reason: str,
    code: str | None,
    decision_id: str,
    rules: tuple[RuleRef, ...] = (),
)
```

Records a durable policy finding beside a settled outcome without rewriting that outcome.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `status` | `PostconditionStatus` | required | Passed or rejected finding. |
| `reason` | `str` | required | Human-readable explanation. |
| `code` | `str | None` | required | Optional stable classifier. |
| `decision_id` | `str` | required | Durable policy decision identifier. |
| `rules` | `tuple[RuleRef, ...]` | `()` | Referenced policy rules. |

See [policy](omp.policy.md) for `RuleRef` and admission semantics.

## Streaming events and detached jobs

### `omp.Update`

```python
Update(
    payload: _U | object = _UPDATE_MISSING,
    /,
    **fields: object,
)
```

Carries one ephemeral progress payload. Supply either one positional payload or keyword fields. With no positional payload, the keyword dictionary becomes `payload`; calling `Update()` therefore produces an empty dictionary payload.

| Field | Type | Meaning |
|---|---|---|
| `payload` | `_U` | Progress value consumed by live views and renderers. |

**Raises**

- `TypeError` when a positional payload and keyword fields are supplied together.

```python
yield omp.Update(stage="indexing", completed=40)
yield omp.Update({"stage": "indexing", "completed": 80})
```

`_UPDATE_MISSING` is an internal sentinel shown here only because it is part of the implementation signature; callers do not import it.

### `omp.Done`

```python
Done(result: _R | None = None, useless: bool = False)
```

Terminates a streaming device or finished operation.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `result` | `_R | None` | `None` | Terminal result. |
| `useless` | `bool` | `False` | Whether its prompt projection may be omitted during compaction. |

```python
yield omp.Done(SearchResult(paths=[], total=0), useless=True)
```

### `omp.JobRef`

```python
JobRef(
    id: str,
    owner_kind: str,
    owner_name: str,
    owner_generation: int,
    description: str,
    media_type: str | None,
    lifetime: str,
)
```

Names detached Environment-owned work and its expected artifact.

| Field | Type | Meaning |
|---|---|---|
| `id` | `str` | Stable job identifier. |
| `owner_kind` | `str` | Owner category. |
| `owner_name` | `str` | Owner name. |
| `owner_generation` | `int` | Generation fence. |
| `description` | `str` | Human-readable work description. |
| `media_type` | `str | None` | Expected artifact media type. |
| `lifetime` | `str` | Requested job lifetime. |

### `omp.Detached`

```python
Detached(job: JobRef)
```

Terminates the current turn while supervised work continues.

| Field | Type | Meaning |
|---|---|---|
| `job` | `JobRef` | Registered detached job. |

### `omp.jobs`

```python
jobs: _Jobs
```

Host-backed detached-job registration namespace.

#### `jobs.register`

```python
async def register(
    self,
    frames: AsyncIterator[Update[Any] | Done[Any]],
    ctx: Context,
) -> JobRef
```

Registers an environment-placed device stream as supervised detached work.

**Parameters**

- `frames` (`AsyncIterator[Update[Any] | Done[Any]]`) — progress and terminal frames.
- `ctx` (`Context`) — active invocation context.

**Returns**

The registered `JobRef` returned by the host.

**Raises**

- `NotWiredError` without an active control backend.

## Canonical serialization

### `omp.dumps`

```python
def dumps(value: object) -> bytes
```

Serializes a verdict value to deterministic UTF-8 JSON bytes. Object keys are sorted, whitespace is omitted, and non-finite floats are rejected.

Supported durable shapes include `None`, booleans, integers, finite floats, strings, bytes, enums, `datetime.datetime`, `Duration`, dataclass instances, string-keyed mappings, lists, and tuples. Bytes, datetimes, and durations use tagged JSON objects. Fields marked as terminal control, including `Payload.terminate`, are omitted.

**Parameters**

- `value` (`object`) — serializable verdict value.

**Returns**

Canonical UTF-8 JSON bytes.

**Raises**

- `TypeError` for unsupported values, cycles, non-string mapping keys, invalid strings, non-finite floats, or JSON serialization failure.

### `omp.loads`

```python
def loads(data: bytes, shape: type[_R]) -> _R
```

Decodes canonical UTF-8 JSON against one explicit, exact shape.

The decoder validates sorted unique object keys, finite numbers, exact dataclass field sets, enum values, tagged values, union selection, and container element shapes. `Any` and `object` permit dynamic canonical JSON.

**Parameters**

- `data` (`bytes`) — canonical verdict bytes.
- `shape` (`type[_R]`) — requested result shape.

**Returns**

A decoded instance of `shape`.

**Raises**

- `VerdictShapeError` when `data` is not bytes, is not valid canonical UTF-8 JSON, or does not select the requested shape exactly.

### `omp.VerdictSchemaError`

```python
VerdictSchemaError(shape: object, field: str, detail: str)
```

Reports an unsupported annotation in durable verdict truth.

The exception exposes `shape`, `field`, and `detail`.

### `omp.VerdictShapeError`

```python
VerdictShapeError(shape: object, detail: str)
```

Reports canonical bytes that do not match a requested shape.

The exception exposes `shape` and `detail`.

## Revisions and identity

### `omp.Rev`

```python
Rev(family: str, n: int)
```

Identifies one argument and projection dialect revision.

| Field | Type | Meaning |
|---|---|---|
| `family` | `str` | Empty or non-empty dotless revision family. |
| `n` | `int` | Unsigned 16-bit revision number. |

`str(rev)` renders `family.n`, or only the number when the family is empty.

**Raises**

- `ValueError` for a dotted or otherwise invalid family, a boolean revision, or a number outside 0–65535.

#### `Rev.parse`

```python
@classmethod
def parse(cls, value: str) -> Rev
```

Parses `"family.n"` or a bare decimal revision.

**Raises**

- `RevError` for an empty, non-string, non-decimal, dotted-family, or out-of-range value.

```python
assert str(omp.Rev.parse("search.3")) == "search.3"
assert omp.Rev.parse("7") == omp.Rev("", 7)
```

### `omp.RevError`

```python
RevError(
    value: object,
    detail: str = "expected family.n or a bare u16",
)
```

Reports malformed revision text. Exposes `value` and `detail`.

### `omp.ToolIdentity`

```python
ToolIdentity(name: str, rev: Rev)
```

Combines a durable device name and semantic revision.

| Field | Type | Meaning |
|---|---|---|
| `name` | `str` | Device name. |
| `rev` | `Rev` | Typed revision. |

`str(identity)` renders `name@rev`.

## Prompt projection

### `omp.Dialect`

```python
class Dialect(StrEnum)
```

Names the argument dialect used by a model-facing projection.

| Member | Wire value | Meaning |
|---|---|---|
| `HASHLINE` | `"hl"` | Hashline dialect. |
| `REPLACE` | `"rep"` | Replacement dialect. |
| `PATCH` | `"patch"` | Patch dialect. |
| `NATIVE` | `"native"` | Native provider dialect. |

### `omp.ModelClass`

```python
class ModelClass(IntEnum)
```

Provides a coarse capability band for projection sizing.

| Member | Value |
|---|---:|
| `TINY` | `0` |
| `SMALL` | `1` |
| `STANDARD` | `2` |
| `FRONTIER` | `3` |

### `omp.PromptCaps`

```python
PromptCaps(
    maximum_parts: int,
    maximum_text_bytes: int,
    media: bool,
    dialect: Dialect,
    model_class: ModelClass,
)
```

Carries deterministic limits for one model-facing projection.

| Field | Type | Meaning |
|---|---|---|
| `maximum_parts` | `int` | Maximum part count. |
| `maximum_text_bytes` | `int` | UTF-8 byte budget for text and JSON parts. |
| `media` | `bool` | Whether blob parts are permitted. |
| `dialect` | `Dialect` | Selected argument dialect. |
| `model_class` | `ModelClass` | Model capability band. |

**Raises**

- `ValueError` unless both maximums are non-negative integers; booleans are rejected.

#### `PromptCaps.fits`

```python
def fits(self, text: str) -> bool
```

Returns true when at least one part is available and the UTF-8 text fits the byte budget.

### `omp.TextPart`

```python
TextPart(text: str)
```

Stores UTF-8 text exposed to the model.

| Field | Type | Meaning |
|---|---|---|
| `text` | `str` | Text content. |

### `omp.JsonPart`

```python
JsonPart(json: bytes)
```

Stores canonical JSON bytes exposed as structured model content.

| Field | Type | Meaning |
|---|---|---|
| `json` | `bytes` | Canonical JSON bytes. |

### `omp.BlobPart`

```python
BlobPart(blob: Any, alt: str | None = None)
```

Stores a blob-backed media part and deterministic fallback text.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `blob` | `Any` | required | Blob reference. |
| `alt` | `str | None` | `None` | Fallback text. |

### `omp.Part`

```python
Part()
```

Validated factory namespace for projection parts. It carries no instance state; call its static methods.

#### `Part.text`

```python
@staticmethod
def text(text: str) -> TextPart
```

Constructs a text part.

**Raises**

- `TypeError` unless `text` is a string.

#### `Part.json`

```python
@staticmethod
def json(value: object) -> JsonPart
```

Canonicalizes `value` with `dumps` and constructs a JSON part.

#### `Part.blob`

```python
@staticmethod
def blob(ref: Any, alt: str | None = None) -> BlobPart
```

Constructs a media part.

**Raises**

- `TypeError` unless `alt` is a string or `None`.

### `omp.Budget`

```python
Budget(caps: PromptCaps)
```

Accumulates whole projection fragments under one `PromptCaps` budget.

**Parameters**

- `caps` (`PromptCaps`) — immutable part and byte limits.

**Raises**

- `TypeError` unless `caps` is a `PromptCaps`.

#### `Budget.remaining`

```python
@property
def remaining(self) -> int
```

Returns the unconsumed text-byte budget.

#### `Budget.push`

```python
def push(self, fragment: str) -> bool
```

Appends a whole text fragment when it fits. Consecutive text is merged into the last `TextPart`. Returns `False` and marks truncation when it cannot fit.

**Raises**

- `BudgetError` if `fragment` is not a string or the budget is sealed.

#### `Budget.push_json`

```python
def push_json(self, value: object) -> bool
```

Appends one canonical JSON part when both part and byte limits allow it.

**Raises**

- `BudgetError` if the budget is sealed.
- `TypeError` if `value` cannot be encoded by the verdict codec.

#### `Budget.push_blob`

```python
def push_blob(self, ref: Any, alt: str) -> bool
```

Appends a blob when media is enabled. Otherwise, it attempts to append `alt` as text.

**Raises**

- `BudgetError` if `alt` is not a string or the budget is sealed.

#### `Budget.finish`

```python
def finish(self) -> list[TextPart | JsonPart | BlobPart]
```

Seals the budget and returns a new list of accepted parts. If an earlier fragment was rejected and the marker fits, `"\n[truncated]"` is appended.

After `finish`, every mutation and a second `finish` raise `BudgetError`.

```python
caps = omp.PromptCaps(
    maximum_parts=2,
    maximum_text_bytes=80,
    media=False,
    dialect=omp.Dialect.NATIVE,
    model_class=omp.ModelClass.STANDARD,
)
budget = omp.Budget(caps)
budget.push("3 matches")
budget.push_json({"paths": ["a.py", "b.py"]})
parts = budget.finish()
```

### `omp.BudgetError`

```python
class BudgetError(OmpError, ValueError)
```

Reports invalid fragment content or use of a sealed projection budget.

### `omp.View`

```python
View(
    identity: ToolIdentity,
    call_id: str,
    updates: tuple[_U, ...],
    state: object | None,
    verdict: CallOutcome[_P, _F] | None,
    elapsed: Duration,
    phase: InvocationPhase,
    presentation: Mapping[str, object] = MappingProxyType({}),
)
```

Carries immutable live or settled renderer-fold input.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `identity` | `ToolIdentity` | required | Device and revision. |
| `call_id` | `str` | required | Invocation identifier. |
| `updates` | `tuple[_U, ...]` | required | Progress values observed so far. |
| `state` | `object | None` | required | Fold state. |
| `verdict` | `CallOutcome[_P, _F] | None` | required | Final outcome, or `None` while live. |
| `elapsed` | `Duration` | required | Elapsed duration. |
| `phase` | `InvocationPhase` | required | Current phase. |
| `presentation` | `Mapping[str, object]` | empty mapping | Host materialized presentation snapshot. |

Construction copies and freezes a supplied `presentation` mapping.

### `omp.prompt`

```python
def prompt(
    view: Ok[Any] | Faulted[Any],
    caps: PromptCaps,
) -> list[TextPart | JsonPart | BlobPart]
```

Finds the sole registered device whose declared `Payload` or `Fault` shape exactly owns the supplied value, then runs that device's synchronous prompt projector.

**Parameters**

- `view` (`Ok[Any] | Faulted[Any]`) — settled device-owned outcome arm.
- `caps` (`PromptCaps`) — projection limits.

**Returns**

Validated model-facing parts.

**Raises**

- `TypeError` for an invalid view or caps value, projector result, or part type.
- `LookupError` when no registered owner or multiple owners match, or the selected device has no projector.
- `BudgetError` when a projector exceeds part, byte, or media limits.

```python
parts = omp.prompt(omp.Ok(SearchResult(paths=["a.py"], total=1)), caps)
```

## Historical lifting

### `omp.RecordedCall`

```python
RecordedCall(
    identity: ToolIdentity,
    raw_args: bytes,
    verdict: bytes,
)
```

Carries a byte-exact historical call to a lift step.

| Field | Type | Meaning |
|---|---|---|
| `identity` | `ToolIdentity` | Original device identity. |
| `raw_args` | `bytes` | Original argument bytes. |
| `verdict` | `bytes` | Original canonical verdict bytes. |

### `omp.LiftedCall`

```python
LiftedCall(raw_args: bytes, verdict: bytes)
```

Carries historical arguments and verdict re-expressed at a destination revision.

| Field | Type | Meaning |
|---|---|---|
| `raw_args` | `bytes` | Lifted canonical argument bytes. |
| `verdict` | `bytes` | Lifted canonical verdict bytes. |

#### `LiftedCall.of`

```python
@classmethod
def of(cls, args: object, verdict: object) -> LiftedCall
```

Canonicalizes both values with the verdict codec and returns a `LiftedCall`.

## Artifacts and spilling

### `omp.ArtifactRef`

```python
ArtifactRef(
    id: str,
    hash: str,
    media_type: str,
    byte_len: int,
)
```

References durable bytes in the session artifact namespace.

| Field | Type | Meaning |
|---|---|---|
| `id` | `str` | Artifact identifier. |
| `hash` | `str` | Content hash. |
| `media_type` | `str` | MIME media type. |
| `byte_len` | `int` | Stored byte length. |

#### `ArtifactRef.url`

```python
@property
def url(self) -> ArtifactUrl
```

Returns the typed `artifact://{id}` address.

### `omp.ArtifactLifetime`

```python
class ArtifactLifetime(StrEnum)
```

Selects minimum retention for a spilled verdict artifact.

| Member | Wire value | Meaning |
|---|---|---|
| `EPHEMERAL` | `"ephemeral"` | Short-lived retention. |
| `SESSION` | `"session"` | Retain for the session. |
| `DURABLE` | `"durable"` | Request durable retention. |

### `omp.SPILL_INLINE_LIMIT`

```python
SPILL_INLINE_LIMIT: int = 16 * 1024
```

Default maximum canonical verdict size retained inline.

### `omp.SpillBudget`

```python
SpillBudget(
    inline_limit: int = SPILL_INLINE_LIMIT,
    media_type: str = "application/json",
    lifetime: ArtifactLifetime = ArtifactLifetime.SESSION,
    always: bool = False,
)
```

Controls central artifactization of a large verdict.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `inline_limit` | `int` | `16 * 1024` | Maximum inline canonical byte length. |
| `media_type` | `str` | `"application/json"` | Media type for spilled bytes. |
| `lifetime` | `ArtifactLifetime` | `SESSION` | Requested retention. |
| `always` | `bool` | `False` | Spill regardless of byte length. |
