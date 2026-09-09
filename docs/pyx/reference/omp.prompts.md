# `omp.prompts`

Use `omp.prompts` to add deterministic sections to omp's assembled prompt and to expire a cached contribution when its backing state changes. A prompt-slot callback is synchronous; it receives an immutable description of the render and returns the contribution text.

```python
import omp
from omp.prompts import PromptContext, SlotClass

@omp.prompt_slot("status", priority=20, cls=SlotClass.VOLATILE)
def project_status(ctx: PromptContext) -> str:
    return f"Project root: {ctx.roots[0]}" if ctx.roots else "No project root"
```

For template-backed contributions, see [`omp.scribe`](omp.scribe.md). For prompt placement and cache policy in context, see [Regimes and policy](../guides/regimes-and-policy.md).

## Writable slots

| Slot | Default stability class |
| --- | --- |
| `runtime` | `FROZEN` |
| `policy` | `STABLE` |
| `workflow` | `FROZEN` |
| `skills` | `STABLE` |
| `rules` | `STABLE` |
| `guidance` | `STABLE` |
| `workspace` | `STABLE` |
| `memory` | `EPOCHAL` |
| `standing` | `EPOCHAL` |
| `recall` | `VOLATILE` |
| `status` | `VOLATILE` |

You may request the slot's default class or a stricter class. You cannot make a slot less stable than its catalog definition.

## Reference

### `omp.prompts.SlotClass`

```python
class SlotClass(StrEnum):
    FROZEN = "frozen"
    STABLE = "stable"
    EPOCHAL = "epochal"
    VOLATILE = "volatile"
```

Classifies how long a prompt contribution may remain in the cached prompt prefix.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `FROZEN` | `"frozen"` | Fixed for the lifetime of its frozen prompt head; explicit invalidation is forbidden. |
| `STABLE` | `"stable"` | Intended for long-lived material that changes deliberately. |
| `EPOCHAL` | `"epochal"` | Scoped to a prompt epoch and replaceable between epochs. |
| `VOLATILE` | `"volatile"` | Recomputed for rapidly changing, tail-position material. |

### `omp.prompts.PromptContext`

```python
PromptContext(
    session_id: str,
    model: str,
    provider: str,
    context_window: int,
    epoch: int,
    cwd: str,
    roots: tuple[str, ...],
    vcs_branch: str | None,
    vcs_commit: str | None,
    is_subagent: bool,
    agent_kind: str | None,
    slot: str,
    cls: SlotClass,
    budget_bytes: int,
)
```

Carries the immutable inputs for one prompt-slot render.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `session_id` | `str` | required | Current session identity. |
| `model` | `str` | required | Selected model name. |
| `provider` | `str` | required | Selected provider name. |
| `context_window` | `int` | required | Model context capacity in tokens. |
| `epoch` | `int` | required | Current prompt epoch. |
| `cwd` | `str` | required | Session working directory. |
| `roots` | `tuple[str, ...]` | required | Workspace roots visible to the session. |
| `vcs_branch` | `str | None` | required | Current version-control branch, when known. |
| `vcs_commit` | `str | None` | required | Current version-control commit, when known. |
| `is_subagent` | `bool` | required | Whether the session belongs to a subagent. |
| `agent_kind` | `str | None` | required | Subagent kind, or `None` for an untyped/root session. |
| `slot` | `str` | required | Slot currently being rendered. |
| `cls` | [`SlotClass`](#omppromptsslotclass) | required | Effective stability class. |
| `budget_bytes` | `int` | required | Maximum byte budget supplied for this contribution. |

The dataclass is frozen and uses slots. Treat every field as render input rather than consulting mutable process state.

### `omp.prompts.UnknownSlot`

```python
class UnknownSlot(OmpError, ValueError):
    ...
```

Raised when a declaration or invalidation names a slot outside the writable catalog.

### `omp.prompts.SlotClassConflict`

```python
class SlotClassConflict(OmpError, ValueError):
    ...
```

Raised when a declaration weakens a slot's catalog stability, or when you try to invalidate a frozen slot.

### `omp.prompts.VolatilePrompt`

```python
class VolatilePrompt(OmpError):
    ...
```

Reports a prompt callback that produced different bytes when the harness checked it twice with the same inputs.

Keep a slot function deterministic: derive its output from `PromptContext` and stable extension state, and render templates with [`omp.scribe`](omp.scribe.md).

### `omp.prompts.prompt_slot`

```python
def prompt_slot(slot: str, *, priority: int = 0, cls: SlotClass | None = None):
    ...
```

Declares a synchronous callback for a writable prompt slot.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `slot` | `str` | One name from the [writable slot table](#writable-slots). |
| `priority` | `int` | Ordering priority for this contribution; defaults to `0`. |
| `cls` | [`SlotClass | None`](#omppromptsslotclass) | Requested stability class. `None` selects the slot's catalog class. |

**Returns**

A decorator that returns the callback unchanged after recording its declaration. The callback is called with a [`PromptContext`](#omppromptspromptcontext).

**Raises**

| Exception | Condition |
| --- | --- |
| [`UnknownSlot`](#omppromptsunknownslot) | `slot` is not writable. |
| [`SlotClassConflict`](#omppromptsslotclassconflict) | `cls` is looser than the slot permits. |
| `ValueError` | `cls` is not a valid `SlotClass` value. |
| `TypeError` | `priority` is not an integer, or the decorated object is not callable. |

```python
from omp.prompts import PromptContext, SlotClass, prompt_slot

@prompt_slot("memory", priority=5, cls=SlotClass.STABLE)
def durable_memory(ctx: PromptContext) -> str:
    return "Remember the repository's public compatibility policy."
```

### `omp.prompts.invalidate`

```python
async def invalidate(slot: str) -> int:
    ...
```

Expires this extension's cached contribution for one non-frozen slot through the active CONTROL host.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `slot` | `str` | Writable slot whose contribution should be invalidated. |

**Returns**

The non-negative integer generation returned by the prompt-head owner.

**Raises**

| Exception | Condition |
| --- | --- |
| [`UnknownSlot`](#omppromptsunknownslot) | `slot` is not writable. |
| [`SlotClassConflict`](#omppromptsslotclassconflict) | `slot` has the `FROZEN` class. |
| `omp.NotWiredError` | No CONTROL backend is installed. |
| `TypeError` | The host response is not an integer generation. |
| `ValueError` | The host returns a negative generation. |

```python
from omp.prompts import invalidate

new_generation = await invalidate("memory")
```
