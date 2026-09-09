# `omp.context`

Use `omp.context` to inspect the current model-facing projection, fetch selected message bodies, contribute bounded projection patches, protect important items, and request compaction. A `ContextView` is a frozen snapshot: fetch another view when you need current state.

```python
import omp

view = await omp.context.view()
print(view.model, view.usage.total_tokens)
for turn_id, messages in view.by_turn():
    print(turn_id, sum(message.tokens for message in messages))
```

See [Agents and sessions](../guides/agents-and-sessions.md), [`omp.journal`](omp.journal.md), and [`omp.hooks`](omp.hooks.md).

## Projection types

### `omp.context.MessageKind`

```python
class MessageKind(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    COMPACTION = "compaction"
    BRANCH_SUMMARY = "branch_summary"
    NOTICE = "notice"
    CUSTOM = "custom"
```

Classification of an item in the live context projection.

### `omp.context.ToolRef`

```python
@dataclass(frozen=True, slots=True)
class ToolRef:
    name: str
    family: str
    rev: int

    def __str__(self) -> str
```

Identifies the tool revision associated with a context item. String form is `<name>@<family>.<rev>`.

### `omp.context.MessageRef`

```python
@dataclass(frozen=True, slots=True)
class MessageRef:
    id: str
    event: int
    seq: int
    kind: MessageKind
    role: str
    turn_id: str | None
    created_at_ms: int
    tokens: int
    byte_len: int
    part_count: int
    media_count: int
    tool: ToolRef | None
    is_error: bool
    useless: bool
    pinned: bool
    elided: bool
    superseded_by: str | None
    artifacts: tuple[ArtifactUrl, ...]
    preview: str

    async def parts(self) -> list[Part]
    async def verdict(self) -> Payload | Fault
    async def raw_args(self) -> bytes | None
```

Immutable, body-free handle to one live thread item.

- `parts()` pulls model-facing `TextPart`, `JsonPart`, and `BlobPart` values.
- `verdict()` pulls a tool result's durable structured verdict.
- `raw_args()` pulls a tool call's uncorrected argument bytes, or `None` when absent.

**Raises**: `ContextGone` when the item no longer belongs to the live chain; `NoVerdict` when no structured verdict exists; `TypeError` when a host payload cannot be decoded.

```python
view = await omp.context.view()
for message in view.messages:
    if message.kind is omp.context.MessageKind.TOOL_RESULT:
        verdict = await message.verdict()
        break
```

### `omp.context.ContextUsage`

```python
@dataclass(frozen=True, slots=True)
class ContextUsage:
    total_tokens: int
    context_window: int
    reserve_tokens: int
    usable_tokens: int
    fraction: float
    prompt_head_tokens: int
    device_catalog_tokens: int
    message_tokens: int
    catalog_notice_tokens: int
    media_tokens: int
    compaction_epoch: int
    threshold_fraction: float
    in_flight: bool
```

Token usage and compaction pressure for the live context.

| Field | Meaning |
|---|---|
| `total_tokens` / `context_window` | Current total and model window size. |
| `reserve_tokens` / `usable_tokens` | Reserved capacity and usable budget. |
| `fraction` | Current context utilization. |
| `prompt_head_tokens` | Stable prompt-head contribution. |
| `device_catalog_tokens` | Device catalog contribution. |
| `message_tokens` | Conversation-item contribution. |
| `catalog_notice_tokens` | Catalog-change notices. |
| `media_tokens` | Media contribution. |
| `compaction_epoch` | Durable compaction epoch. |
| `threshold_fraction` | Configured compaction threshold. |
| `in_flight` | Whether model work is currently in flight. |

### `omp.context.ContextView`

```python
@dataclass(frozen=True, slots=True)
class ContextView:
    session_id: str
    turn_id: str
    model: str
    provider: str
    epoch: int
    messages: tuple[MessageRef, ...]
    usage: ContextUsage
    prompt_hash: str
    reset_event: int | None

    def since(self, turn_id: str) -> Iterator[MessageRef]
    def by_turn(self) -> Iterator[tuple[str | None, tuple[MessageRef, ...]]]
    def tokens_of(self, ids: Iterable[str]) -> int
```

Immutable projection of the current model context.

- `since()` yields projected items beginning with the first item whose `turn_id` matches; it yields nothing if none matches.
- `by_turn()` groups consecutive items by turn id without reordering them.
- `tokens_of()` sums token counts for matching item ids; unknown ids contribute zero.

### `omp.context.view`

```python
async def view() -> ContextView
```

Fetches the current context projection from the host.

**Returns**: A frozen `ContextView` whose message bodies remain lazy.

### `omp.context.usage`

```python
async def usage() -> ContextUsage
```

Fetches current usage without building a message projection.

### `omp.context.epoch`

```python
async def epoch() -> int
```

Fetches the current durable context compaction epoch.

## Projection patches

Patch values describe operations for a thread-projection handler. Constructing them does not mutate durable journal history.

### `omp.context.Prune`

```python
@dataclass(frozen=True, slots=True)
class Prune:
    ids: tuple[str, ...]
    reason: str = ""
    keep_placeholder: bool = True
```

Removes named items from one turn's working context copy, optionally leaving a placeholder.

### `omp.context.DropParts`

```python
@dataclass(frozen=True, slots=True)
class DropParts:
    ids: tuple[str, ...]
    reason: str = ""
```

Drops model-facing parts while retaining typed verdict and journal data.

### `omp.context.Replace`

```python
@dataclass(frozen=True, slots=True)
class Replace:
    ids: tuple[str, ...]
    parts: tuple[Part, ...]
    role: str = "user"
    label: str = ""
    inherit_position: str = "first"
```

Replaces named context items with one synthetic item.

### `omp.context.Anchor`

```python
@dataclass(frozen=True, slots=True)
class Anchor:
    relation: str
    id: str | None = None

    @staticmethod
    def before(id: str) -> Anchor
    @staticmethod
    def after(id: str) -> Anchor
    @staticmethod
    def head() -> Anchor
    @staticmethod
    def tail() -> Anchor
```

Locates an inserted synthetic item relative to the live context.

| Constructor | Placement |
|---|---|
| `before(id)` | Immediately before the named item. |
| `after(id)` | Immediately after the named item. |
| `head()` | After the prompt head and before conversation items. |
| `tail()` | Immediately before the pending user turn. |

**Raises**: `ValueError` when `before`/`after` lacks an id, `head`/`tail` has one, or `relation` is unknown.

### `omp.context.Insert`

```python
@dataclass(frozen=True, slots=True)
class Insert:
    parts: tuple[Part, ...]
    anchor: Anchor
    role: str = "user"
    ephemeral: bool = True
    dedupe_key: str | None = None
```

Inserts one synthetic item into a turn's working context copy. `dedupe_key` lets the host identify repeated contributions.

### `omp.context.Reorder`

```python
@dataclass(frozen=True, slots=True)
class Reorder:
    ids: tuple[str, ...]
    before: str
```

Moves named context items before another item while preserving their order.

### `omp.context.ContextPatch`

```python
@dataclass(slots=True)
class ContextPatch:
    prune: list[Prune] = field(default_factory=list)
    drop_parts: list[DropParts] = field(default_factory=list)
    replace: list[Replace] = field(default_factory=list)
    insert: list[Insert] = field(default_factory=list)
    reorder: list[Reorder] = field(default_factory=list)
    note: str = ""

    def is_empty(self) -> bool
    def merge(self, other: ContextPatch) -> ContextPatch
```

Mutable collection of context projection operations contributed by one handler.

`is_empty()` checks only operation lists; a note by itself is still empty. `merge()` returns a new patch containing this patch's operations followed by the other's, and joins non-empty notes with `"; "`.

```python
patch = omp.context.ContextPatch(
    insert=[
        omp.context.Insert(
            parts=(omp.Part.text("Repository policy: generated files are read-only."),),
            anchor=omp.context.Anchor.head(),
            role="system",
            dedupe_key="repo-policy",
        )
    ],
    note="project policy",
)
```

## Pins and auxiliary lanes

### `omp.context.pin`

```python
async def pin(ids: Iterable[str], *, reason: str) -> int
```

Durably protects context items from patches and compaction.

**Parameters**: `ids` must be an iterable of non-empty strings, not a single string; `reason` must be text.

**Returns**: The host-reported pin count.

**Raises**: `TypeError` for malformed ids/reason; `PinBudgetExceeded` when the request exceeds the configured budget.

### `omp.context.unpin`

```python
async def unpin(ids: Iterable[str]) -> int
```

Releases pins owned by the calling extension and returns the host-reported unpin count.

### `omp.context.lane`

```python
@asynccontextmanager
async def lane(*, strict_epoch: bool = False) -> AsyncIterator[None]
```

Marks an async block as deprioritized auxiliary context work. With `strict_epoch=True`, the lane captures the current epoch; journal mutations made through this module's fence are rejected if that epoch changes.

**Raises**: `TypeError` when `strict_epoch` is not boolean; `StaleEpoch` when a fenced write reaches a newer epoch.

```python
from dataclasses import dataclass

@omp.entry_kind("com.example.summary", rev="1")
@dataclass(frozen=True, slots=True)
class MySummary:
    text: str

async with omp.context.lane(strict_epoch=True):
    summary = await omp.agents.completion("Summarize the current thread", context="thread")
    await omp.journal.append(MySummary(summary.text))
```

## Compaction

### `omp.context.CompactionTier`

```python
class CompactionTier(StrEnum):
    PRUNE = "prune"
    DROP_MEDIA = "drop_media"
    ELIDE = "elide"
    LOCAL = "local"
    REMOTE = "remote"
    HANDOFF = "handoff"
```

One rung of the context compaction ladder.

### `omp.context.CompactionEvent`

```python
@dataclass(frozen=True, slots=True)
class CompactionEvent:
    preparation_id: str
    tier: CompactionTier
    reason: str
    epoch: int
    tokens_before: int
    target_tokens: int
    suggested_first_kept: str
    to_summarize: tuple[MessageRef, ...]
    to_retain: tuple[MessageRef, ...]
    split_turn: bool
    previous_summary: str | None
    previous_preserve: dict | None
    custom_instructions: str | None
    deadline: Duration
```

Describes one pending compaction tier for a compaction-domain hook.

### `omp.context.CancelCompaction`

```python
@dataclass(frozen=True, slots=True)
class CancelCompaction:
    reason: str
    suppress_for_turns: int = 0
```

Skips one compaction tier and optionally suppresses later ladders for a number of turns.

### `omp.context.CustomSummary`

```python
@dataclass(frozen=True, slots=True)
class CustomSummary:
    summary: str
    first_kept_id: str
    short: str | None = None
    warning: str | None = None
    details: dict | None = None
    preserve: dict | None = None
```

Replaces a compaction tier with an extension-authored summary and explicit first retained item.

### `omp.context.DelegateCompaction`

```python
@dataclass(frozen=True, slots=True)
class DelegateCompaction:
    extra_instructions: str = ""
    focus_ids: tuple[str, ...] = ()
    role: str | None = None
    keep_recent_tokens: int | None = None
```

Runs the default tier with extension-supplied instructions, focus items, role, or recent-token target.

### `omp.context.CompactionVerdict`

```python
CompactionVerdict: TypeAlias = CancelCompaction | CustomSummary | DelegateCompaction
```

Typed return accepted from a compaction-domain hook.

### `omp.context.CompactionOutcome`

```python
@dataclass(frozen=True, slots=True)
class CompactionOutcome:
    preparation_id: str
    tiers_run: tuple[CompactionTier, ...]
    from_extension: str | None
    tokens_before: int
    tokens_after: int
    first_kept_id: str
    epoch: int
    summary_bytes: int
    warning: str | None
```

Durable result of a completed compaction request.

### `omp.context.ContextResetEvent`

```python
@dataclass(frozen=True, slots=True)
class ContextResetEvent:
    reset_event: int
    epoch: int
    kind: str
    tokens_discarded: int
    last_turn_id: str | None
```

Describes a reset boundary that replaced the live context chain.

### `omp.context.compact`

```python
async def compact(
    *, tier: CompactionTier | None = None, focus: str = ""
) -> CompactionOutcome
```

Requests out-of-band compaction from the host.

**Parameters**: `tier` optionally selects the starting rung; `focus` supplies a textual focus.

**Returns**: A `CompactionOutcome`.

**Raises**: `TypeError` for invalid arguments or responses, `CompactionBusy` when another request is active, `CompactionRefused` for an invalid cancellation of required rescue compaction, and `PatchRejected` for structurally invalid output.

## Errors

### `omp.context.CompactionBusy`

```python
class CompactionBusy(OmpError)
```

Raised when compaction is requested while another compaction is running.

### `omp.context.CompactionRefused`

```python
class CompactionRefused(OmpError)
```

Raised when a verdict tries to cancel an unavoidable rescue handoff.

### `omp.context.PatchRejected`

```python
class PatchRejected(OmpError)
```

Raised when a context patch or compaction verdict violates a structural rule.

### `omp.context.ContextGone`

```python
class ContextGone(OmpError)
```

Raised when a message handle names an item no longer in the live chain.

### `omp.context.NoVerdict`

```python
class NoVerdict(OmpError)
```

Raised when a message has no durable structured verdict.

### `omp.context.PinBudgetExceeded`

```python
class PinBudgetExceeded(OmpError)
```

Raised when a pin request would exceed the configured context-window budget.

### `omp.context.StaleEpoch`

```python
class StaleEpoch(OmpError)
```

Raised when a strict context lane attempts a write after its captured epoch changed.
## Data model field index

| Dataclass | Fields |
|---|---|
| `ToolRef` | `name`, `family`, `rev` |
| `MessageRef` | `id`, `event`, `seq`, `kind`, `role`, `turn_id`, `created_at_ms`, `tokens`, `byte_len`, `part_count`, `media_count`, `tool`, `is_error`, `useless`, `pinned`, `elided`, `superseded_by`, `artifacts`, `preview` |
| `ContextUsage` | `total_tokens`, `context_window`, `reserve_tokens`, `usable_tokens`, `fraction`, `prompt_head_tokens`, `device_catalog_tokens`, `message_tokens`, `catalog_notice_tokens`, `media_tokens`, `compaction_epoch`, `threshold_fraction`, `in_flight` |
| `ContextView` | `session_id`, `turn_id`, `model`, `provider`, `epoch`, `messages`, `usage`, `prompt_hash`, `reset_event` |
| `Prune` | `ids`, `reason=""`, `keep_placeholder=True` |
| `DropParts` | `ids`, `reason=""` |
| `Replace` | `ids`, `parts`, `role="user"`, `label=""`, `inherit_position="first"` |
| `Anchor` | `relation`, `id=None` |
| `Insert` | `parts`, `anchor`, `role="user"`, `ephemeral=True`, `dedupe_key=None` |
| `Reorder` | `ids`, `before` |
| `ContextPatch` | `prune`, `drop_parts`, `replace`, `insert`, and `reorder` each use a fresh empty list, `note=""` |
| `CompactionEvent` | `preparation_id`, `tier`, `reason`, `epoch`, `tokens_before`, `target_tokens`, `suggested_first_kept`, `to_summarize`, `to_retain`, `split_turn`, `previous_summary`, `previous_preserve`, `custom_instructions`, `deadline` |
| `CancelCompaction` | `reason`, `suppress_for_turns=0` |
| `CustomSummary` | `summary`, `first_kept_id`, `short=None`, `warning=None`, `details=None`, `preserve=None` |
| `DelegateCompaction` | `extra_instructions=""`, `focus_ids=()`, `role=None`, `keep_recent_tokens=None` |
| `CompactionOutcome` | `preparation_id`, `tiers_run`, `from_extension`, `tokens_before`, `tokens_after`, `first_kept_id`, `epoch`, `summary_bytes`, `warning` |
| `ContextResetEvent` | `reset_event`, `epoch`, `kind`, `tokens_discarded`, `last_turn_id` |

## Enum member index

| Enum | Member | Wire value | Meaning |
|---|---|---|---|
| `MessageKind` | `SYSTEM` | `"system"` | System instruction item. |
| `MessageKind` | `USER` | `"user"` | User item. |
| `MessageKind` | `ASSISTANT` | `"assistant"` | Assistant item. |
| `MessageKind` | `TOOL_CALL` | `"tool_call"` | Tool-call item. |
| `MessageKind` | `TOOL_RESULT` | `"tool_result"` | Tool-result item. |
| `MessageKind` | `COMPACTION` | `"compaction"` | Compaction item. |
| `MessageKind` | `BRANCH_SUMMARY` | `"branch_summary"` | Branch-summary item. |
| `MessageKind` | `NOTICE` | `"notice"` | Notice item. |
| `MessageKind` | `CUSTOM` | `"custom"` | Extension-defined custom item. |
| `CompactionTier` | `PRUNE` | `"prune"` | Prune context items. |
| `CompactionTier` | `DROP_MEDIA` | `"drop_media"` | Drop media content. |
| `CompactionTier` | `ELIDE` | `"elide"` | Elide retained content. |
| `CompactionTier` | `LOCAL` | `"local"` | Run local summarization. |
| `CompactionTier` | `REMOTE` | `"remote"` | Run remote summarization. |
| `CompactionTier` | `HANDOFF` | `"handoff"` | Perform rescue handoff. |
