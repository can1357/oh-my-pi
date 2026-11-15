# Journal patches, sessions, and the URL namespace

`omp.journal` · `omp.sessions` · `omp.artifacts` · `omp.urls` · `omp.schemes` · `omp.state_dir`

> **Rewritten.** An earlier revision of this chapter documented an extension-owned typed
> append log: `@entry_kind`, `journal.append` / `append_many` / `append_atomic` /
> `entries` / `latest` / `fold` / `label`, `StateEntry`, `StateEntryId`,
> `EntryKindConflict`, `UnknownEntryKind`, and the `MAX_*` limits. None of those exist.
> Commit `47e02d12a6` ("added director/component decorators and revamped journal") reduced
> `omp.journal` to DOM patch builders and read-only projections, and the session tree became the
> single authority ([ADR 0003](../adr/0003-one-authoritative-session-tree.md),
> [ADR 0004](../adr/0004-lifecycle-derives-from-the-tree.md)). The removed material, the
> cross-session `state` design, and the storage-crate implementation plan that used to close
> this file are recorded under **Superseded** at the end. Statements here are checked against the
> code named beside them; where the code does not settle a question the text says **Unknown**.

## Purpose

This namespace is where an extension's facts go to survive, and the rule has changed: an extension
no longer appends entries. Session state is one materialized tree (the DOM) whose only durable
form is the journal's stream of patches. An extension contributes to it in exactly two ways, both
described in [`15-directors.md`](15-directors.md):

- a **Component** (`@omp.component`) turns a newly appended journal entry into DOM operations, which
  the engine journals as one `patch@1`;
- a **Director** (`@omp.director`) returns DOM operations from `before_inference` and durable
  `updates` from `on_yield`.

`omp.journal` is the vocabulary those callbacks speak: builders for the four DOM operations, the
read-only `JournalEntry` projection, and the error family. `omp.sessions` is the sanctioned way to
read history (other sessions, their journals, aggregate usage). `omp.artifacts` addresses large
payloads by URL instead of embedding them, and `omp.urls` is the single namespace those addresses
live in, including the typed values `omp.ArtifactUrl`, `omp.HistoryUrl`, and `omp.AgentUrl`.
`omp.state_dir` is a private, rebuildable directory in the environment.

## Concepts

### The journal is the patch stream of one tree

From ADR 0003: the session materializes as one tree; the journal stores its incremental changes;
every piece of session state must be derivable from the journal alone; and there is no API through
which an extension can hold authoritative state outside the tree. Runtime objects may cache the
tree but never become a second place where truth lives.

```xml
<meta>  <!-- persistent components, journal-derived -->
<body>  <!-- the live chain, entries as elements -->
<queues> ...
```

A patch is a list of operations against integer node handles. On the wire and in the journal each
operation is a JSON array; `omp.journal` builds them:

| Operation | Builder | Wire form |
|---|---|---|
| Insert a node | `omp.journal.insert(parent, after, tag, *, props=None, content=None)` | `["ins", parent, after, {"tag", "props", "kids", "content"?}]` |
| Remove a node | `omp.journal.remove(handle)` | `["rm", handle]` |
| Set one property | `omp.journal.set_prop(handle, prop, value)` | `["set", handle, prop, value]` |
| Move a node | `omp.journal.move(handle, parent, after=None)` | `["mv", handle, parent, after]` |

The Rust decoder accepts exactly those four opcodes (`crates/dom/src/op.rs`). Every builder is
pure and does no I/O; every handle must be a positive `int` (a `bool`, `0`, or a negative number
raises `TypeError`).

### What writes, and who

Only the engine writes the journal. `crates/journal` owns the `.oms` file and blob store,
`crates/session` appends first and then folds the exact entry into `crates/dom`, and replay uses
the same fold. Extension callbacks return operations; the host commits them:

- A Component's operations become one `patch@1` labeled `ext:<component_id>`, caused by the entry
  it reduced, and only for live appends. Replay applies the durable patch and never calls Python.
- A Director's `before_inference` operations become one `patch@1` labeled
  `extension.director.before_inference`.
- A callback that fails, times out, or returns malformed operations changes nothing.

There is no `journal.append` and no way to define a journal kind. The host control router
asserts that `journal.append`, `state.latest`, and `regimes.start` (each under the `omp.` prefix) are not handled
(`crates/envd/tests/domain_control_router.rs`).

### Where an extension's bytes live

| Place | Holds | Channel | Owner | If deleted |
|---|---|---|---|---|
| **Session tree / journal** | Session-scoped truth | engine-owned; extensions reach it through Director/Component patches | `omp-session`, `omp-journal` | Everything. |
| **Artifacts** | Payloads too large to inline | DATA (bytes) + CONTROL (`omp.artifacts.*`) | Environment blob store | The payload. |
| **Sessions index** | Historical session metadata and usage | CONTROL (`omp.sessions.*`) | Agent Core | Rebuilt from journals (**Unverified**). |
| **State dir** | Indexes, caches, embeddings | DATA (`omp.state_dir`) | Environment filesystem | Nothing: rebuildable. |

CONTROL operations are routed by prefix in `crates/envd/src/exthost/control.rs`: `omp.sessions.`
and `omp.artifacts.` go to their authorities, and `omp.urls.read` and `omp.state_dir` to the
auxiliary one. Artifact bytes and the state directory ride DATA because the Environment owns the
filesystem; when an extension is declared by a remote workspace (see
[`14-deploy.md`](14-deploy.md)), its state dir lives on the remote machine beside the files it
indexes.

### The rule of thumb

> **Tree for session-scoped truth. State dir for indexes and caches, keyed to a watermark.**

If losing a file would lose information, it belongs in the tree. If losing it would only cost a
rebuild, it belongs in the state dir. A state-dir file that is the only copy of something is a bug.
There is currently no documented home for cross-session extension state (the `state` namespace was removed; see below).

### Rules that still hold

1. **Append-only.** There is no update and no delete of history; a later patch supersedes an earlier
   one (ADR 0003).
2. **One writer.** Only the engine appends. Extensions never write journal files.
3. **No parallel source of truth.** State derivable from the journal must not also be stored as truth
   elsewhere.
4. **Replay determinism.** Replay applies committed patches; Component callbacks are not re-run, so
   replay does not depend on the extension being installed.
5. **Fail-closed reads.** A projection the caller may not read raises `omp.EntryAccessDenied`; bytes
   that are not canonical JSON raise `omp.EntryUndecodable` and are never repaired.

Idempotency and generation fencing for durable CONTROL requests (`request_id`, `idempotency_key`,
`host_generation`, `session_generation`, `omp.StaleGeneration`) are owned by
[`00-overview.md`](00-overview.md).

## Reference

### `omp.journal`

Import-time-safe and I/O-free: the module builds values and decodes bytes. Its `__all__` is
`EntryAccessDenied`, `EntryId`, `EntryTooLarge`, `EntryUndecodable`, `JournalEntry`, `JournalError`,
`JournalIndeterminate`, `decode`, `insert`, `move`, `patch`, `raw_bytes`, `remove`, and `set_prop`.
The seven classes are also re-exported at the package root (`omp.EntryId`, ...).

#### `omp.journal.insert(parent, after, tag, *, props=None, content=None) -> list[object]`

Builds one `ins` operation: a new element `tag` under `parent`, after sibling `after` (`None` means
first child). `props` is copied into the node's properties, `content` is optional text, and the node
is created with no children. Raises `TypeError` for a non-positive handle, an empty or non-string
`tag`, or a non-string `content`.

#### `omp.journal.remove(handle) -> list[object]`

Builds one `rm` operation.

#### `omp.journal.set_prop(handle, prop, value) -> list[object]`

Builds one `set` operation. `prop` must be a non-empty string; `value` is not validated here.

#### `omp.journal.move(handle, parent, after=None) -> list[object]`

Builds one `mv` operation.

#### `omp.journal.patch(*ops) -> dict[str, list[list[object]]]`

Returns `{"ops": [list(op) for op in ops]}`, the canonical Component callback result.

```python
import omp
from omp import journal

@omp.component("note-mirror", interested=("msg.user@1",))
def note_mirror(entry):
    # `parent` and `after` are node handles. How a Python callback learns them
    # is Unknown; see 15-directors.md.
    return journal.patch(
        journal.insert(parent, None, "note", props={"of": entry["id"]}, content="seen"),
    )
```

#### `omp.journal.decode(raw) -> Any`

Strict decoder for read-only projections. `raw` must be `bytes` (anything else raises `TypeError`)
holding UTF-8 JSON with no `NaN`/`Infinity`. The value is re-encoded canonically (sorted keys,
compact separators, `ensure_ascii=False`) and compared with the input; a difference raises
`omp.EntryUndecodable` with `raw` and `reason` attached. Machine-written truth is never repaired.

#### `omp.journal.raw_bytes(row) -> bytes`

Reads the canonical bytes from an engine projection row: `row["raw"]` as `bytes`, `row["raw"]` as
`str` (UTF-8 encoded), or base64-decoded `row["raw_base64"]`. Raises `TypeError` when none is
present or the base64 is invalid.

#### `omp.JournalEntry`

Frozen, read-only projection of an engine journal entry (generic in the decoded value type):

| Field | Type | Meaning |
|---|---|---|
| `id` | `omp.EntryId` | Entry identity. |
| `kind` | `str` | Journal kind name. |
| `rev` | `str` | Kind revision. |
| `ts` | `int` | Timestamp. |
| `principal` | `omp.Principal` | Authenticated principal. |
| `provenance` | `omp.Provenance` | Publisher, extension, version, digest, layer, trust tier, generation (`14-deploy.md`). |
| `value` | `T \| None` | Decoded value; `None` when it could not be decoded. |
| `raw` | `bytes` | Canonical bytes, always kept. |
| `display` | `bool` | Whether clients render it. |
| `in_context` | `bool` | Whether it enters model context. |
| `artifact` | `omp.ArtifactRef \| None` | Attached artifact, if any. |

The one producer in this package is `omp.sessions.journal` (below). Who stamps `principal` and
`provenance` on entries produced by a Component patch is **Unknown**.

#### `omp.EntryId`

Frozen, ordered value `EntryId(session: str, index: int)`. `str(entry_id)` is `"<session>:<index>"`
and `omp.EntryId.parse(text)` is its inverse; it raises `TypeError` for a non-string and
`ValueError` for a missing session, a non-decimal or zero-padded index, or a non-ASCII digit.

#### Exceptions

All derive from `omp.JournalError(omp.OmpError)`, whose `appended` attribute lists any
`omp.EntryId` values that were durably written before the failure.

| Exception | Meaning |
|---|---|
| `omp.JournalError` | Base for this namespace. |
| `omp.EntryTooLarge(actual, limit)` | A projected entry exceeds an engine-owned bound. |
| `omp.EntryAccessDenied(kind)` | The caller may not read that journal projection. |
| `omp.JournalIndeterminate(operation="journal mutation", *, appended=())` | A host-owned journal operation's durability could not be proven. |
| `omp.EntryUndecodable(raw, reason)` | Bytes are not canonical JSON (`omp.journal.decode`, and mapped from the host error code in `_host.py`). |

Which host operations raise `EntryTooLarge`, `EntryAccessDenied`, and `JournalIndeterminate` today is
**Unknown**: only `EntryUndecodable` has a producer in `omp/_host.py`.

### The removed `state` namespace

The top-level `state` object (`append`, `entries`, `latest`, `fold`, `cas_put`, `cas_get`), the
`StateScope` vocabulary, and `StateScopeDenied` no longer exist: the Python object, the native
vocabulary, and the runtime-symbol rows were deleted together. No host authority ever handled
the `state.*` requests, and the router asserts `state.latest` is not handled
(`crates/envd/tests/domain_control_router.rs`), so that assertion is kept as a negative guard.

There is no documented replacement for cross-session extension state. Extension-declared settings
ride the control plane through `omp.convars` ([`18-convars.md`](18-convars.md)); anything else
cross-session is **Unknown**.

### `omp.sessions`

The sanctioned historical read API. It exists because 16 catalogued packages glob
`~/.pi/agent/sessions/**/*.jsonl` and parse it themselves, and every one of them
breaks under any of: a remote Agent Core, a non-file backend, a private layout
change, or an actively-appending file. Lesson #4 is the reason this is not
negotiable — multiple and remote instances are first-class, so the on-disk layout
is private and reading it directly is prohibited.

`@tmustier/pi-usage-extension` is the honest measure of the cost of not having
this: a recursive directory walk, a 1024-byte prefix scanner over four hardcoded
byte patterns (`"role":"assistant"`, `"type":"compaction"`,
`"type":"branch_summary"`, `"type":"thinking_level_change"`), an allocation-free
byte parser for tool results over 64 KB, a string-interning table, a
`CACHE_VERSION = 5` on-disk cache keyed by `(size, mtimeMs)`, and a
`try { JSON.parse } catch { skip }` that silently drops the torn last line of
every live session. Every line of it is competent. All of it is a query.

#### `omp.sessions.current() -> omp.SessionInfo`

Metadata for the session this extension is running in. Cheap; served from core
state without touching storage.

**Channel** CONTROL. **Latency class** per-command. **Failure** fail-closed.

#### `async omp.sessions.list(filter=None) -> Sequence[omp.SessionInfo]`

Lists sessions the caller may see, newest activity first.

**Arguments** `filter: omp.SessionFilter | None` — `None` means every session in
the current project.

**Channel** CONTROL. **Latency class** per-command; served from the write-time
index, so it is not a directory scan. **Failure** fail-closed.

#### `async omp.sessions.get(session_id) -> omp.SessionInfo`

One session's metadata. **Raises** `omp.SessionNotFound`.

#### `async omp.sessions.journal(session_id, *, kinds=None, since=None, until=None, live=True) -> AsyncIterator[omp.JournalEntry]`

Streams another session's journal in bounded pages. Entries arrive in ascending index order as
read-only `omp.JournalEntry` projections; `omp.journal.decode(entry.raw)` reads the payload. Whether
values are lifted to a live revision is **Unknown**: the earlier revision promised it, and the
current Python decoder only builds the projection.

**Arguments**

- `kinds: Sequence[str] | None` — filter core-side. Filtering core-side is the
  point: an extension indexing a million turns should not receive them. The
  accepted spelling (`turn.receipt` versus `turn.receipt@1`) is set by the host
  and is **Unknown** here.
- `since` / `until: omp.EntryId | int | None` — bounds, exclusive lower and
  inclusive upper.
- `live: bool` — live chain only, or every physical entry.

**Channel** CONTROL, streamed. **Latency class** per-command; back-pressured, so
a slow consumer slows the scan rather than buffering it. **Failure** fail-closed.
**Cancellation** the stream is scoped to a `RunGuard`; abandoning the iterator
drops the guard and the core stops scanning. There is no orphaned scan.

```python
async for entry in omp.sessions.journal(sid, kinds=["turn.receipt"], since=mark):
    index.insert(entry)
    mark = entry.id
```

#### `async omp.sessions.usage(query) -> omp.UsageReport`

Aggregate token and cost accounting over sessions. This is a query against the
index the core maintains as it writes turn receipts — not a re-parse. Answering
"cost by model over 30 days" reads rows, never journals.

**Arguments** `query: omp.UsageQuery`.

**Channel** CONTROL. **Latency class** per-command. **Failure** fail-closed.

#### `async omp.sessions.lineage(session_id) -> Sequence[omp.SessionLink]`

The fork/handoff chain reaching a session, oldest first. Backed by
durable lineage recorded in the journal, rather than inference from filenames — which is what pi's advisor/subagent classifier had to
do, keying off `__advisor.jsonl` basenames and path layout.

#### `async omp.sessions.tree(session_id=None) -> tuple[omp.SessionNode, ...]`

Materializes the physical journal as immutable root nodes in durable order.
Each `SessionNode` has `id`, `parent`, `kind`, `ts`, `data`, resolved `label`,
and nested `children`. Rewinds form sibling branches. Broken parent references
are returned as additional roots rather than dropping durable records.

#### `async omp.sessions.branch(from_id=None) -> tuple[omp.SessionNode, ...]`

Returns one root-first path. `from_id` accepts an `EntryId` (including another
visible session) or a non-negative physical index in the current session.
Omitting it selects the current live leaf. An unknown entry returns an empty
path.

#### `omp.sessions.SessionSetup` and `async omp.sessions.create(setup=SessionSetup())`

`SessionSetup` is a frozen declarative value:

```python
setup = omp.sessions.SessionSetup(
    title="Review follow-up",
    parent=omp.sessions.current().id,
    initial_prompt="Continue from the recorded findings.",
)
created = await omp.sessions.create(setup)
```

`SessionSetup` takes `title`, `parent`, and `initial_prompt`; it has no `entries`
(seeding typed entries was removed with `@entry_kind`, and `create` now always
sends an empty entry list). `initial_prompt` is text or a tuple of visible
`omp.Part.text()` / `omp.Part.blob()` values and becomes exactly one visible
user journal item. It never submits a turn, enqueues work, starts a model
request, or encodes hidden context.

Creation is one atomic create/seed/switch transaction. Before allocating
anything, Core validates parent access, quotas, invocation phase, and UI state.
It stages the header, durable lineage, optional user title, and optional prompt
in that order. Journal
publication plus the write-time index/idempotency receipt is the durability
point; only then does the existing interactive owner switch the UI once.
`list`, `get`, `lineage`, `journal`, and `resume` immediately observe the
complete result.

Only an idle, user-initiated interactive `@omp.command` invocation at
`EFFECTS_AUTHORIZED` is admitted. Hooks, tools, shortcuts, headless/RPC
commands, subagents, and a transitioning UI raise
`omp.SessionTransitionDenied` without creating anything. Pre-durability failure
rolls back and leaves the old session current. If durability or switch
acknowledgement is ambiguous, Core fuses the generation- and invocation-bound
idempotency identity and raises `omp.SessionTransitionIndeterminate`; retry
cannot create a duplicate.

No session manager or mutable journal handle crosses CONTROL. A command may
immediately queue the first turn with
`await omp.agents.inject(prompt, session=created.id)` after `create` returns;
the target is accepted only for the authenticated client that created it.
See the create → switch → inject recipe in `docs/py/12-agents.md`. Later
automation can use a durable schedule after the user reaches the new session.

| Symbol | Kind / trigger | `OperationSpec` |
|---|---|---|
| `omp.sessions.SessionSetup` | Declare / static; no manifest row | `minimum_phase=OPEN`, `durability=EPHEMERAL`, `cost=NONE`, `authority=CORE` |
| `omp.sessions.create` | Request / static; no manifest row | `minimum_phase=EFFECTS_AUTHORIZED`, `durability=DURABLE`, `cost=NONE`, `authority=CORE` |

#### Historical session mutation

Historical-session management uses named CONTROL requests; the extension never
opens, rewrites, renames, or removes journal files itself.

| Signature | Semantics | Effect channel | Failure modes |
|---|---|---|---|
| `async get(session_id) -> omp.SessionInfo` | Return the visible indexed row for one stable id. | CONTROL request; no mutation. | `omp.SessionNotFound`; access and host failures fail closed. |
| `async lineage(session_id) -> Sequence[omp.SessionLink]` | Return the durable parent chain, oldest first. | CONTROL request; no mutation. | `omp.SessionNotFound`; access and host failures fail closed. |
| `async omp.sessions.resume(session_id) -> omp.SessionInfo` | Make the historical interactive session current and return its refreshed index row. | CONTROL request; the Core journals a resume receipt before acknowledging. | `omp.SessionNotFound`; non-interactive, access, and host failures fail closed. |
| `async omp.sessions.rename(session_id, title) -> omp.SessionInfo` | Assign a user title and return the refreshed immutable index row. | CONTROL request; the Core journals the rename receipt before acknowledging. | `omp.SessionNotFound`; invalid titles, access, and host failures fail closed. |
| `async delete(session_id) -> None` | Permanently remove the session selected by an approved deletion ticket. | Approval-gated CONTROL request. | `omp.PermissionDenied` without the matching approval grant; `omp.SessionNotFound`; host failures fail closed. |

`delete` never bypasses policy. An extension offering deletion emits the durable
human-approval ticket, and the Core executes the storage mutation only after that
ticket is approved. Calling `delete` without the matching grant raises
`omp.PermissionDenied`; there is no force flag, implicit confirmation, or
extension-owned filesystem fallback.

`SessionLink` is a frozen value with `id: str`, `parent: str | None`, and
`at: int | None`. `id` uses the same stable identifier as `SessionInfo.id`,
`parent` uses the same immediate-parent projection as `SessionInfo.parent`, and
`at` is the source journal index recorded when the session was forked.

**Resolved (2026-08-20 ruling):** These CONTROL verbs, typed lineage links, and
the approval-gated deletion contract resolve the Round 4 session-mutation design
gap. Resume and rename are durable acknowledged requests: their receipts are
journaled before their refreshed rows are returned.

#### `omp.SessionInfo`

| Field | Type | Meaning |
|---|---|---|
| `id` | `str` | Stable session identifier. |
| `title` | `str \| None` | Assigned title. |
| `title_source` | `omp.TitleSource` | Who assigned it. |
| `cwd` | `omp.EnvPath` | Working directory at creation, in that session's environment namespace (`docs/py/11-env.md`). |
| `project` | `str` | Normalized project root, worktree suffixes stripped. |
| `created_ms` | `int` | Creation time. |
| `updated_ms` | `int` | Last append time. |
| `status` | `omp.SessionStatus` | Terminal disposition. |
| `kind` | `omp.SessionKind` | Interactive, subagent, or advisor. |
| `parent` | `str \| None` | Immediate lineage parent. |
| `entries` | `int` | Physical entry count, tombstones included. |
| `turns` | `int` | Completed turn receipts. |
| `usage` | `omp.Usage` | Rolled-up token counts. |
| `cost` | `omp.sessions.Cost` | Rolled-up cost. |
| `models` | `Sequence[str]` | Distinct `provider/model` used. |
| `remote` | `bool` | Whether the session's environment was remote. |

`remote` is here on purpose: an extension that assumes local files needs to be
able to see that it is wrong.

#### `omp.SessionFilter`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `project` | `str \| None` | current | Project root. `""` means every project. |
| `since_ms` | `int \| None` | `None` | Lower bound on `updated_ms`. |
| `until_ms` | `int \| None` | `None` | Upper bound on `updated_ms`. |
| `status` | `Sequence[omp.SessionStatus] \| None` | `None` | Terminal dispositions to include. |
| `kind` | `Sequence[omp.SessionKind] \| None` | `(INTERACTIVE,)` | Session kinds. Subagents are excluded by default because including them double-counts usage. |
| `contains_kind` | `str \| None` | `None` | Only sessions containing at least one entry of this kind. Lets an extension find its own sessions without scanning them. |
| `limit` | `int` | `200` | Row cap. |

#### `omp.UsageQuery`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `since_ms` | `int \| None` | `None` | Lower time bound. |
| `until_ms` | `int \| None` | `None` | Upper time bound. |
| `group_by` | `Sequence[omp.GroupBy]` | `(GroupBy.MODEL,)` | Grouping keys, applied in order. |
| `bucket` | `omp.Bucket` | `Bucket.NONE` | Time bucketing for series output. |
| `filter` | `omp.SessionFilter \| None` | `None` | Session scope. |
| `include_subagents` | `bool` | `True` | Whether subagent usage rolls into its parent. |

#### `omp.UsageReport`

| Field | Type | Meaning |
|---|---|---|
| `total` | `omp.UsageBucket` | Grand total. |
| `groups` | `Sequence[omp.UsageBucket]` | One per distinct grouping key. |
| `series` | `Sequence[omp.UsageBucket]` | One per time bucket; empty when `bucket=NONE`. |
| `sessions` | `int` | Sessions contributing. |
| `truncated` | `bool` | Whether the filter's `limit` clipped the scope. |

#### `omp.UsageBucket`

| Field | Type | Meaning |
|---|---|---|
| `key` | `Mapping[str, str]` | Grouping key values (`{"model": "anthropic/claude-opus-5"}`). |
| `start_ms` | `int \| None` | Bucket start, for series rows. |
| `usage` | `omp.Usage` | Token counts. |
| `cost` | `omp.sessions.Cost` | Cost. |
| `requests` | `int` | Inference requests. |
| `errors` | `int` | Failed requests. |
| `duration` | `omp.Duration` | Summed wall time. `omp.Duration` is the single duration value type (`docs/py/00-overview.md`); millisecond ints and float seconds are gone from public signatures. |

#### `omp.Usage`

Mirrors `omp.inference.v1.Usage` (`crates/proto/proto/omp/inference/v1/common.proto:66-90`),
which is the authoritative accounting shape. Aggregation must not flatten to a
narrower form: `reasoning_tokens` and
`premium_requests` are separately billed, and cache reads and cache writes price
differently, so collapsing any of them is how cost dashboards start lying.

| Field | Type | Meaning |
|---|---|---|
| `input` | `int` | Non-cached input tokens. |
| `output` | `int` | Generated output tokens. |
| `cache_read` | `int` | Input tokens served from a provider cache. |
| `cache_write` | `int` | Input tokens written into a provider cache. |
| `reasoning` | `int` | Reasoning/thinking output tokens, where the provider reports them separately. |
| `premium_requests` | `int` | Provider-metered premium request count. |
| `context` | `int \| None` | Context-window occupancy observed for the request. |
| `total` | `int` | Provider-reported total when present, else the sum. |
| `accuracy` | `omp.UsageAccuracy` | Whether these counts are exact, estimated, or mixed. |
| `detail` | `Mapping[str, int \| str]` | Vendor-namespaced raw breakdown, integers kept exact. |

`accuracy` is not decoration. An aggregate mixing exact provider counts with
locally estimated ones is a different number than either, and a dashboard that
cannot say which it is showing invites the user to trust it more than it deserves.

#### `omp.UsageAccuracy`

Mirrors `omp.inference.v1.Usage.Accuracy`.

| Member | Meaning |
|---|---|
| `EXACT` | Every contributing count came from the provider. |
| `ESTIMATED` | Every contributing count was computed locally. |
| `MIXED` | Both, so the aggregate is neither. |

#### `omp.sessions.Cost`

Mirrors `omp.inference.v1.Cost` (`common.proto:108-117`). Cost is carried as
**integer nano-USD**, not a float, because a summed corpus of millions of
requests through IEEE-754 loses cents and then dollars. `usd` is a convenience
for display only; never aggregate on it.

| Field | Type | Meaning |
|---|---|---|
| `nanos_usd` | `int` | Total cost in nano-USD. Authoritative. |
| `estimated` | `bool` | `True` when computed from catalog rates rather than billed in-band. |
| `input_nanos_usd` | `int \| None` | Input-side component when the provider itemizes. |
| `output_nanos_usd` | `int \| None` | Output-side component. |
| `usd` | `float` | `nanos_usd / 1e9`. Display only. |

#### `omp.SessionStatus`

| Member | Meaning |
|---|---|
| `COMPLETE` | Last turn settled with a receipt. |
| `INTERRUPTED` | User aborted the last turn. |
| `ABORTED` | Last turn settled as `TurnAbort` without a gateway outcome. |
| `ERROR` | Last turn recorded a request failure. |
| `PENDING` | A started turn has no terminal receipt; the session may be live. |
| `UNKNOWN` | Disposition not derivable. |

#### `omp.SessionKind`

| Member | Meaning |
|---|---|
| `INTERACTIVE` | A session a user drove. |
| `SUBAGENT` | Spawned by `omp.agents` (`docs/py/12-agents.md`). |
| `ADVISOR` | Background advisory session. |

#### `omp.GroupBy`

| Member | Groups by |
|---|---|
| `MODEL` | `provider/model`. |
| `PROVIDER` | Provider alone. |
| `PROJECT` | Normalized project root. |
| `SESSION` | Session id. |
| `KIND` | `omp.SessionKind`. |

#### `omp.Bucket`

| Member | Bucket width |
|---|---|
| `NONE` | No series output. |
| `HOUR` | One UTC hour. |
| `DAY` | One UTC day. |
| `WEEK` | Seven UTC days from the Unix epoch. |
| `MONTH` | One UTC calendar month. |

#### `omp.TitleSource`

Identifies which frozen Python authority assigned the indexed title.

| Member | Meaning |
|---|---|
| `USER` | Set explicitly by a person. |
| `MODEL` | Generated by a model. |
| `SYSTEM` | Assigned by the runtime. |

#### Exceptions

| Exception | Base | Raised when |
|---|---|---|
| `omp.SessionError` | `omp.OmpError` | Base for this namespace. |
| `omp.SessionNotFound` | `omp.OmpError` | No such session, or not visible to the caller. |
| `omp.SessionAccessDenied` | `omp.SessionError` | The manifest does not grant historical reads. |

### `omp.artifacts`

An artifact is a payload addressed by URL instead of embedded. The spill gate that
*decides* when a verdict becomes an artifact belongs to
`docs/py/02-verdicts.md`, along with `omp.ArtifactRef`'s field list. This section
owns the namespace: how you mint one deliberately, how you read and slice it, and
how long it lives.

#### Reachability is the retention rule

> **A blob is reachable if and only if a journal entry or a verdict references
> it.**

Content-addressing already makes writes idempotent and cross-session deduplicated
(`crates/journal/src/blob.rs`). What it does not give is a reason to keep a
blob, and that reason has to be a reference from durable truth. So:

- `omp.artifacts.put` returns an `omp.ArtifactRef` that is **not yet durable**.
- Returning it inside a `Payload` or `Fault` makes it reachable
  (`docs/py/02-verdicts.md`). The earlier route, putting the ref into an
  extension-appended journal entry, no longer exists; whether a ref carried in
  a Component or Director DOM patch counts as a garbage-collection root is
  **Unknown**.
- An unreferenced ref is swept once its lifetime window closes.

This means an extension cannot leak permanent storage by accident, and it means
GC is a mark from journal roots rather than a heuristic over mtimes. `pi-rewind`
is the counter-example: it writes working-tree snapshots into
`refs/pi-checkpoints/*` with `DEFAULT_MAX_CHECKPOINTS = 50` and requires manual
pruning, because git refs have no relationship to session truth.

#### `async omp.artifacts.put(data, *, media_type, description=None, lifetime=Lifetime.SESSION) -> omp.ArtifactRef`

Stores bytes or text and returns a reference. Idempotent: identical bytes yield an
identical hash and no rewrite.

**Arguments**

- `data: bytes | str | omp.EnvPath` — an `omp.EnvPath` (`docs/py/11-env.md`) is
  streamed from the environment without transiting the host. Raw `os.PathLike`
  is gone: a plain path cannot say which machine it names (typed locations,
  UX#2).
- `media_type: str` — MIME type. Required; it decides how `read` frames the
  content and whether the model may be shown it as media.
- `description: str | None` — short human label, surfaced in listings.
- `lifetime: omp.ArtifactLifetime` — minimum retention promise.

**Channel** DATA (bytes to the environment blob store) then CONTROL (identity).
**Latency class** per-call. **Failure** fail-closed.

```python
ref = await omp.artifacts.put(
    report_html,
    media_type="text/html",
    description="usage dashboard",
    lifetime=omp.ArtifactLifetime.SESSION,
)
# Carry `ref` in the Payload (or Fault) the device returns; that reference,
# not the put itself, is what keeps the artifact alive.
```

Returning the ref in a verdict is what makes the artifact survive. Without a
durable reference, the HTML is garbage.

#### `async omp.artifacts.open_write(*, media_type, description=None, lifetime=Lifetime.SESSION) -> omp.ArtifactWriter`

Streaming mint for payloads that should never be materialized in host memory. The
writer is an async context manager; `await writer.write(chunk)` appends and
`writer.ref` is available after the block exits. Digest and length are computed as
bytes flow, and the blob is atomically placed only once both are known — the same
discipline as `BlobStore::put_reader`.

```python
async with omp.artifacts.open_write(media_type="application/jsonl") as w:
    async for row in rows:
        await w.write(row)
ref = w.ref
```

#### `async omp.artifacts.adopt(blob, *, media_type=None, description=None, lifetime=Lifetime.SESSION) -> omp.ArtifactRef`

Promotes an `omp.BlobRef` (defined in `docs/py/11-env.md`) into an addressable
artifact. This is the bridge across the placement spill path: a worker returns
`omp.Spill(value)` (`docs/py/04-placement.md`), the environment supervisor diverts
that pickle-5 out-of-band frame straight into the blob store, and the host
receives an `omp.BlobRef` instead of bytes. `BlobRef` is content identity;
`ArtifactRef` is an addressable, slice-readable resource carrying a retention
promise. `adopt` is the only step that turns the former into the latter, which is
how gigabytes computed in a worker become an `artifact://` URL without ever
entering the host process.

**Size is never taken from the caller.** A `BlobRef` reaching `adopt` carries a
claimed size, and on the worker path that claim originates outside the host's
trust boundary. Because the store computed the digest itself while receiving the
bytes, the authoritative length is `StatResponse.size`, so `adopt` resolves the
digest through `Stat` and records *that* size. A mismatch between the claimed and
stored size raises `omp.ArtifactCorrupt` rather than being silently preferred in
either direction — the digest is the identity, the store is the authority, and the
caller's number is a hint worth checking.

Adoption is a durable request and carries the generation stamp owned by
`00-overview.md`: after a reload or a
reconnect, an adoption frame from an old generation is rejected
(`omp.StaleGeneration`), so an indeterminate adoption cannot be double-applied.

**Raises** `omp.ArtifactNotFound` when the blob is no longer present.

#### `async omp.artifacts.get(ref) -> bytes`

Whole contents. Verifies the stored length against the reference and raises
`omp.ArtifactCorrupt` on mismatch — the same check `BlobStore::get` performs.
Prefer `read` or `open` for anything you do not need entirely in memory.

#### `async omp.artifacts.open(ref) -> omp.ArtifactReader`

Async byte reader with `read(n)`, `seek(offset)`, and async iteration by chunk.
Streams over DATA; nothing is buffered whole.

#### `async omp.artifacts.read(ref, selector=None) -> str`

Reads a text artifact through the same selector grammar as a file read, which is
what makes truncation a display decision rather than data loss. `selector=None`
returns the whole text.

```python
head = await omp.artifacts.read(ref, "1-50")
raw  = await omp.artifacts.read(ref, "raw")
```

**Raises** `omp.SelectorError` on invalid syntax, `omp.ArtifactNotText` when
`media_type` is not textual.

#### `async omp.artifacts.stat(ref) -> omp.ArtifactStat`

Metadata without reading bytes.

#### `async omp.artifacts.list(*, session=None, mine=True, limit=200) -> Sequence[omp.ArtifactStat]`

Artifacts reachable from a session's journal. `mine=True` restricts to artifacts
this extension minted; `False` includes core-minted ones such as spilled verdicts
and detached-job settlements.

#### `async omp.artifacts.pin(ref, lifetime) -> None`

Raises an existing artifact's retention promise. Lowering it is not permitted —
a promise already made to another consumer cannot be withdrawn. Raises
`omp.ArtifactError` on an attempted downgrade.

#### `omp.artifacts.url(ref) -> omp.ArtifactUrl`

The typed `artifact://<id>` address for a reference (`omp.ArtifactUrl` is
defined under `omp.urls`). Pure and local; no round trip. `<id>` is a short
session-local ordinal, not the 64-hex digest, because `str(url)` ends up in
model context and a digest would cost tokens for nothing. The ordinal-to-digest
mapping is journaled, so it survives reload. Revision 1 returned a raw `str`
here; typed locations (UX#2) removed raw URL strings from every public
signature.

#### `omp.ArtifactLifetime`

Mirrors `omp_tool::ArtifactLifetime` (`crates/tool/src/lib.rs:334-344`), wire
values `"ephemeral" | "session" | "durable"`.

| Member | Retention |
|---|---|
| `EPHEMERAL` | Only until the settling call is consumed. For a settlement payload the model reads once. |
| `SESSION` | Default. Retained as long as the session's journal is retained. |
| `DURABLE` | Retained independently of session retention. Requires an external root; use it for exports a user will open next month. |

The default is `SESSION` and deliberately conservative — the same default the
Rust enum already carries.

#### `omp.ArtifactStat`

| Field | Type | Meaning |
|---|---|---|
| `ref` | `omp.ArtifactRef` | The reference itself. |
| `url` | `omp.ArtifactUrl` | The typed `artifact://<id>` address. |
| `media_type` | `str` | MIME type. |
| `byte_len` | `int` | Exact stored length. |
| `description` | `str \| None` | Human label. |
| `lifetime` | `omp.ArtifactLifetime` | Current retention promise. |
| `created_ms` | `int` | Mint time. |
| `source` | `str` | Extension or core component that minted it. |
| `reachable_from` | `Sequence[omp.EntryId]` | Journal entries referencing it. Empty means GC-eligible. |
| `lines` | `int \| None` | Line count for text artifacts; `None` otherwise. |

`reachable_from` being empty is the observable form of the retention rule, and it
is the field to check when an artifact vanished.

#### Exceptions

| Exception | Base | Raised when |
|---|---|---|
| `omp.ArtifactError` | `omp.OmpError` | Base for this namespace; also an illegal lifetime downgrade. |
| `omp.ArtifactNotFound` | `omp.ArtifactError` | Swept, never existed, or not visible. |
| `omp.ArtifactCorrupt` | `omp.ArtifactError` | Stored length disagrees with the reference. |
| `omp.ArtifactNotText` | `omp.ArtifactError` | `read` on a non-textual media type. |
| `omp.SelectorError` | `omp.UrlError` | Invalid selector syntax. The same selector vocabulary and exception are shared by artifact and URL reads. |

### `omp.urls`

One namespace, one reader, one slicing syntax. Files, devices, artifacts,
transcripts, web pages, and MCP resources are all addresses, and a result
*references* rather than embeds. This is what makes artifactization work at all:
the spilled payload needs a name the model can read back, and once that name
exists there is no reason the rest of the world should not share the namespace.

#### `async omp.urls.read(url, selector=None) -> str`

Reads any readable scheme. `url` accepts `str`, an `omp.Url`, or a typed URL or
location value (`omp.ArtifactUrl`, `omp.HistoryUrl`, `omp.AgentUrl`,
`omp.EnvPath`) — strings stay accepted because model-originated text is where
most addresses come from. Text is returned framed the way the `read` tool
frames it — line-numbered with a snapshot anchor unless the selector is `raw`.

**Raises** `omp.SchemeNotReadable`, `omp.SelectorError`, `omp.UrlError`.

**Channel** varies by scheme: `file`/`ssh` over DATA, `artifact` over DATA, the
rest over CONTROL. **Latency class** per-call. **Failure** fail-closed.

#### `omp.urls.parse(url) -> omp.Url`

Pure, local parse. Splits scheme, resource, and any trailing selector using the
same rules the read tool uses — a scheme is alphanumeric with `+`, `.`, `-`, and
only schemes whose resource grammar permits it have selectors split off, so a
`mcp://` URI containing colons is not mangled.

#### `omp.Url`

| Field | Type | Meaning |
|---|---|---|
| `scheme` | `omp.Scheme` | Parsed scheme. |
| `raw_scheme` | `str` | The caller's spelling, case preserved. |
| `resource` | `str` | Everything after `://`, selector removed. |
| `selector` | `omp.Selector \| None` | Parsed selector when present. |
| `text` | `str` | The original string. |
| `value` | `omp.ArtifactUrl \| omp.HistoryUrl \| omp.AgentUrl \| None` | The typed URL value for schemes that define one; `None` otherwise. |

#### Typed URL values: `omp.ArtifactUrl`, `omp.HistoryUrl`, `omp.AgentUrl`

Raw URL strings are gone from every public signature; these three typed values
are owned here. Their cousins live with their subsystems: `omp.EnvPath`,
`omp.ClientPath`, and `omp.BlobRef` in `docs/py/11-env.md`, `omp.ToolPath` in
`docs/py/01-devices.md`, `omp.WorkspaceUri` in `docs/py/14-deploy.md`. Each is
a frozen value: `str()` yields the wire form, `.selector` carries a parsed
selector when present, `.with_selector(sel)` derives a sliced address, and
`await url.read()` is sugar for `omp.urls.read(url)`.

| Type | Wire form | Minted by |
|---|---|---|
| `omp.ArtifactUrl` | `artifact://<id>` | `omp.artifacts.url(ref)`; the core, for spilled verdicts. |
| `omp.HistoryUrl` | `history://<id>` | The core; addresses a read-only agent transcript. |
| `omp.AgentUrl` | `agent://<id>` | The core, when a subagent settles (`docs/py/12-agents.md`). |

They are types and not strings for the same reason `EnvPath` is: a string does
not say which session, machine, or namespace it names, so every consumer
re-parses and some consumer eventually guesses. `omp.urls.parse` returns the
typed value in `omp.Url.value` for these schemes; APIs accept either the typed
value or `str` at the model boundary, where text is all there is.

#### `omp.Scheme`

Every member, with what an extension may do with it. **Mint** means the extension
can bring a new address of that scheme into existence.

| Member | Wire | Read | Mint | Resource |
|---|---|---|---|---|
| `FILE` | none / `file://` | yes | yes, via `omp.env` | Workspace or environment path. Bare paths parse as this. |
| `HTTP` | `http://`, `https://` | yes | no | Reader-mode extraction to markdown; large bodies spill. |
| `ARTIFACT` | `artifact://` | yes | **yes**, via `omp.artifacts.put` | Session-local artifact ordinal. Typed value: `omp.ArtifactUrl`. |
| `HISTORY` | `history://` | yes | no | Read-only agent transcripts; bare form lists the roster. Typed value: `omp.HistoryUrl`. |
| `AGENT` | `agent://` | yes | no | Subagent output artifacts and nested children (`docs/py/12-agents.md`). Typed value: `omp.AgentUrl`. |
| `LOCAL` | `local://` | yes | **yes**, via `omp.env` | Session scratchpad, containment-checked. |
| `MEMORY` | `memory://` | yes | no | Project memory files (`docs/py/08-context.md`). |
| `MCP` | `mcp://` | yes | indirectly, by mounting a server | MCP resource URIs. No selector splitting — MCP owns its grammar. |
| `SKILL` | `skill://` | yes | no | Skill content by name, traversal-confined. |
| `RULE` | `rule://` | yes | no | Rule content by name. |
| `OMP` | `omp://` | yes | no | Bundled harness documentation. |
| `ISSUE` | `issue://` | yes | no | Forge issues, cached. Numbered reads use the forge host. |
| `PR` | `pr://` | yes | no | Forge change requests, cached. Numbered reads use the forge host. |
| `SSH` | `ssh://` | yes | yes, via `omp.env` | Remote file read/write and host listing. |
| `SECURITY` | `security://` | yes, when granted | no | Scan results, findings, coverage. Manifest-gated. |
| `VAULT` | `vault://` | yes, when granted | yes, when granted | Obsidian vault files and operators. Manifest-gated. |
| `JOB` | `job://` | yes | no | Detached-job settlement address. Core-minted only. |
| `UNKNOWN` | any other | no | no | Syntactically valid, unhandled. `read` raises `omp.SchemeNotReadable`. |

**Extensions cannot register new schemes.** The scheme set is a schema the model
sees, so it is versioned with the harness and owned by it (Lesson #8). pi had no
`registerProtocol` either — but by accident rather than by decision, which is why
extensions instead returned `/tmp` paths and hoped.

The sanctioned way to add capability is a device. This is worth being exact
about, because it is the one place where minting an address and registering a
schema are easy to confuse: `@omp.device` places a typed `omp.ToolPath`
(`docs/py/01-devices.md`) in the device catalog behind the `dyn` shell builtin,
with docs and a JSON schema the model fetches on demand with
`dyn <name> --help` and discovers with `dyn` or `dyn --q <text>`. It adds **zero**
registered tool slots to any request; invocation runs `dyn <name> [args…]` inside
the core `shell` tool, where the schema-derived CLI maps arguments into one nested
JSON document. No URL scheme is ever writable by declaring a device. Availability
changes arrive as one
system-notification thread item, never as a mutation of the request's tool array,
so the prompt prefix cache survives (`docs/py/01-devices.md`). An extension never
registers anything with the model. (Rev 2 modeled the device catalog as a mintable
read/write URL scheme with its own row in the table above; the Rev 2.1 ruling
deletes that scheme entirely, so the row is removed and the flip is recorded
here.)

#### `omp.Selector`

Parsed line selection. The grammar is shared with file reads, so anything you
learned reading `src/main.rs:50-200` works on `artifact://7` and
`history://Scout`.

| Field | Type | Meaning |
|---|---|---|
| `ranges` | `Sequence[tuple[int, int \| None]]` | Sorted, merged, one-based inclusive ranges. `None` end means to EOF. |
| `raw` | `bool` | Numbering and framing disabled. |
| `conflicts` | `bool` | Summarize unresolved merge-conflict regions only. |

Accepted forms: `N`, `N-M`, `N-`, `N+K`, `N..M`, `N..`, comma-separated multi-range
(`5-16,960-973`), `raw`, `conflicts`, and `raw` combined with ranges in either
order. Lines are one-based; `0` is an error, not a silent clamp.

#### `omp.urls.parse_selector(text) -> omp.Selector`

Pure parse of a selector fragment. **Raises** `omp.SelectorError`.

#### `omp.urls.schemes() -> Mapping[omp.Scheme, omp.SchemeInfo]`

The live scheme table, including which are readable and mintable in the current
trust tier. `omp.SchemeInfo` carries `readable: bool`, `mintable: bool`,
`selectors: bool`, and `description: str`. Read it rather than hardcoding the
table above — a thin client talking to a remote workspace may not expose the same
set.

#### Exceptions

| Exception | Base | Raised when |
|---|---|---|
| `omp.UrlError` | `omp.OmpError, ValueError` | Base for this namespace; it is both an omp exception and a value/parsing error. |
| `omp.SchemeNotReadable` | `omp.UrlError` | Scheme has no reader in this deployment. |
| `omp.SelectorError` | `omp.UrlError` | Invalid selector syntax or out-of-bounds range. |

**Resolved (2026-08-20 ruling):** `SelectorError` remains one class under `UrlError`,
shared by artifact and URL readers. `UrlError` itself derives from both `omp.OmpError` and
`ValueError`.

### `omp.schemes`

Extension-declared URL schemes ([ADR 0050](../adr/0050-extension-declared-url-schemes.md)
S1–S5). An extension claims its schemes in the manifest `schemes` table
([00-overview.md](00-overview.md)) and registers them at activation. Registration gates
on the loaded manifest's claims; envd folds live claims into one `SchemeGeneration`
served by the unknown-scheme fallback. `omp.urls.schemes()` keeps returning the built-in
table only, and a declared scheme still parses as the `UNKNOWN` member of `omp.Scheme`.
The package-root name `omp.schemes` used to be an unexported alias of the callable
`omp.urls.schemes` with no users; that alias is dropped, so `omp.schemes` is now this
module, and `omp.urls.schemes()` is unchanged.

#### `omp.schemes.Declaration(name, description=None, immutable=False, writable=False)`

Frozen value mirroring one manifest `[[schemes]]` entry. `name` is normalized to its one
canonical spelling, with no aliases: lowercased with ASCII-only folding (U+212A KELVIN
SIGN is not folded to `k`), then matched in full against `^[a-z][a-z0-9+.-]*$` (a
trailing newline is a miss), at most `omp.schemes.MAX_SCHEME_BYTES` (64) bytes, and never
a built-in wire name of the URL vocabulary that `omp.urls` loads, `https` and `pr`
included. `description` is at most `omp.schemes.MAX_DESCRIPTION_BYTES` (4096) UTF-8
bytes. **Raises** `TypeError` for a wrongly typed field.

#### `omp.schemes.register(*declarations, read=None) -> tuple[omp.schemes.Declaration, ...]`

Registers `omp.schemes.Declaration` values or bare spellings, additively across calls.
A spelling repeated after normalization raises `omp.schemes.DuplicateSchemeError`; more
than `omp.schemes.MAX_SCHEMES` (32) in total raises `omp.schemes.SchemeLimitError`. A
refused call registers nothing. Optional `read` is invoked by CONTROL `omp.schemes.read`.

#### `omp.schemes.declared() -> tuple[omp.schemes.Declaration, ...]`

This extension's process-local registrations, in registration order. Separate from the
built-in `omp.urls.schemes()` table and from the Environment-wide live listing.

#### `async omp.schemes.live() -> tuple[omp.schemes.LiveDeclaration, ...]`

Every scheme currently live in the Environment generation (CONTROL `omp.schemes.live`),
including `owner` and fold-time `fetch` / `credentials` flags. Requires the CONTROL
bridge (`omp.NotWiredError` when absent). Built-in schemes never appear here.

#### Exceptions

| Exception | Base | Raised when |
|---|---|---|
| `omp.schemes.SchemeError` | `omp.UrlError` | Base for a refused declaration. |
| `omp.schemes.SchemeGrammarError` | `omp.schemes.SchemeError` | The spelling misses the grammar after ASCII lowercasing. |
| `omp.schemes.BuiltinSchemeError` | `omp.schemes.SchemeError` | The spelling is a built-in wire name. |
| `omp.schemes.DuplicateSchemeError` | `omp.schemes.SchemeError` | The spelling is already declared. |
| `omp.schemes.SchemeLimitError` | `omp.schemes.SchemeError` | A byte limit or the 32-scheme count is exceeded. |

### `omp.state_dir`

#### `async omp.state_dir() -> omp.EnvPath`

Returns this extension's private state directory as a typed `omp.EnvPath`
(`docs/py/11-env.md` owns the type), in the **environment's** namespace.
Created on first call. Every filesystem verb you use against it — reading,
writing, opening, spawning a process inside it — belongs to `omp.env` and is
documented in `docs/py/11-env.md`; this function only establishes the
directory's identity and the rules for what may live in it.

Revision 1 returned `str`, and its worked example passed that string straight
to a local `sqlite3.connect()`. The review is right that this was not
remote-safe: it worked only when the host process and the Environment happened
to be colocated, and it silently named a directory on the wrong machine for
any client-layer extension attached to a remote workspace. A raw string cannot
say which machine it names. `EnvPath` can — and its `local_path()` escape
hatch is placement-checked, raising `omp.PlacementError` unless the calling
code is truly colocated with the Environment *and* the sandbox scope covers
the directory.

**Identity.** The path is derived from the extension id and is stable across
restarts and upgrades within a major version. Two extensions never share one,
and an extension cannot name another's.

**Scoping.** Because it rides DATA, the state dir lives wherever the
Environment lives. An extension declared by a remote workspace gets a
directory on the remote machine, beside the files it indexes — which is the
entire point, since shipping a million file chunks across a socket to build an
index is the thing `place="env"` exists to avoid (`docs/py/04-placement.md`).
A thin client and a remote workspace therefore have *different* state dirs for
the same extension, and neither is authoritative. Anything that must agree
across them belongs in the session tree.

**What may live here.** Derived data only: SQLite indexes, FTS tables,
embedding stores, parsed caches, downloaded model weights. Every file must be
reconstructible by replaying the journal (read through `omp.sessions.journal`)
from a recorded watermark. The sanctioned way to operate on it is shape 1 below, and
"format the path into a local library call" is not it.

**Shape 1 — an env-colocated named worker.** The body that touches the
filesystem runs where the filesystem is (`site=omp.Site.ENV`,
`docs/py/04-placement.md`), and only such a body may call `local_path()`:

```python
import omp
import omp_remote

@omp_remote.remote
def watermark(state: omp.EnvPath) -> str | None:
    import sqlite3
    db = sqlite3.connect(state.local_path() / "index.db")
    db.execute("CREATE TABLE IF NOT EXISTS obs(idx INTEGER PRIMARY KEY, text TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
    row = db.execute("SELECT v FROM meta WHERE k='watermark'").fetchone()
    return row[0] if row else None

@omp_remote.remote
def apply_rows(state: omp.EnvPath, rows: list[tuple[int, str]], mark: str) -> None:
    import sqlite3
    db = sqlite3.connect(state.local_path() / "index.db")
    db.executemany("INSERT OR REPLACE INTO obs(idx, text) VALUES(?, ?)", rows)
    db.execute("INSERT OR REPLACE INTO meta VALUES('watermark', ?)", (mark,))
    db.commit()

omp.workers.declare(omp.WorkerSpec(name="index", site=omp.Site.ENV))

@omp.hook("extension_activate")
async def rebuild(event: omp.ExtensionActivateEvent, ctx: omp.Context) -> None:
    state = await omp.state_dir()                     # omp.EnvPath, not a str
    worker = await omp.workers.get("index")
    raw = await worker.call(watermark, state)
    mark = omp.EntryId.parse(raw) if raw else None
    rows: list[tuple[int, str]] = []
    async for entry in omp.sessions.journal(omp.sessions.current().id, since=mark):
        rows.append((entry.id.index, entry.raw.decode("utf-8")))
        mark = entry.id
    if rows:
        await worker.call(apply_rows, state, rows, str(mark))
```

If `index.db` is deleted, this rebuilds it. If the journal is deleted, nothing
rebuilds it — which is the difference between the two, stated as code.

**Shape 2 — no filesystem at all** was the scoped store
(`state.fold(...)`). It was removed (see *The removed `state` namespace* above), so there
is exactly one sanctioned shape.

**Channel** DATA. **Latency class** per-session. **Failure** fail-closed — an
extension that cannot obtain its state dir does not load.

`@omp.hook` and the `extension_activate` event are defined in
`docs/py/05-hooks.md`. Revision 1 hung this rebuild on `session_start` and
said that was right "because it also fires after a host crash and restart" —
under the settled lifecycle that firing was the bug, not the feature:
`session_start` is reserved for the real session transition and is observed
only by eagerly activated extensions, while a lazily activated extension sees
`extension_activate(reason=FIRST_REACH | RESTART | HOT_RELOAD, ...)`.
`RESTART` is the crash-recovery firing, which is exactly when an index may be
behind its journal.

## Superseded

The earlier revision of this chapter (last present at commit `b697571a73`; read it with
`git show b697571a73:docs/py/09-journal.md`) is not reproduced here. Its parts and what replaced
them:

| Earlier section | Status | Read instead |
|---|---|---|
| "One entry, three projections", `@entry_kind` (`data` / `render` / `project`, `lift`, `rev`) | Removed. Extensions cannot define journal kinds; Components consume the engine's closed kind vocabulary. | [`15-directors.md`](15-directors.md), ADR 0003 |
| `journal.append`, `append_many`, `append_atomic`, `entries`, `latest`, `fold`, `label`, `label_of` | Removed, including their runtime-symbol rows and the `journal.appends` quota. Only DOM patch builders, `decode`, and `raw_bytes` remain; `decode` is the one `omp.journal` function that keeps a runtime-symbol row. | `omp.journal` above |
| `MAX_INLINE_BYTES`, `MAX_ENTRY_BYTES`, `MAX_LABEL_BYTES`, `MAX_ATOMIC_ENTRIES`, `EntryKindConflict`, `UnknownEntryKind` | Removed. | none |
| `state` scoped log and CAS, `StateScope`, `StateScopeDenied`, `StateEntry`, `StateEntryId` | Removed. No host ever handled the `state.*` requests; the Python object, native vocabulary, and runtime-symbol rows were deleted. | *The removed `state` namespace* above |
| Consistency rules 5, 7, 8 (fail-closed appends, stamped authorship, per-invocation-phase append legality) | Written for appends. Generation fencing is still owned by `00-overview.md`. | [`00-overview.md`](00-overview.md) |
| "Patterns" (four pi-extension case studies) | Removed: each rewrote a state file into `journal.append` / `journal.entries` / `state.fold`. | ADR 0003 "Context" for the failures they illustrated |
| "What this requires us to build" (`crates/storage`, `crates/agent` journal owner, `toolhost/v1` frames, `crates/tools` URL resolution), feature-map reconciliation, performance, failure semantics, open questions, Revisions 2 to 2.2 | Removed: an implementation plan against a tree that no longer exists (`crates/storage` is gone). | `crates/journal`, `crates/session`, `crates/dom`, [`docs/architecture/crates.md`](../architecture/crates.md), ADR 0003, ADR 0004, ADR 0036 |

The `omp.sessions`, `omp.artifacts`, `omp.urls`, and `omp.state_dir` sections above are retained from
the earlier revision with the references to removed APIs corrected. They were not otherwise
re-audited against the host in this pass; their symbols resolve in the frozen package, but
behavioral claims about the write-time sessions index, artifact garbage collection, and the URL
readers are as the earlier revision stated them.
