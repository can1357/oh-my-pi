# ACP tool-call presentation architecture

This document describes how a tool call's output reaches an ACP client (or the
TUI/RPC consumers that share the same pipeline): the typed event stream a tool
produces, how it's reduced into wire frames, and how it's persisted and
replayed. For the rules, enforced invariants, and probe-testing workflow for
this subsystem, see [`acp-development.md`](./acp-development.md).

## What this subsystem is

A tool call has **one** structured representation. Every string a consumer
sees — the model-facing body, the ACP terminal bytes, the TUI card, a replayed
session — is a projection of that structure; nothing downstream parses a
string back into facts. Two packages own the two halves:

- `packages/agent/src/presentation/` — the protocol and type algebra: the
  event stream a tool emits, the fact/outcome vocabulary, and the scoped
  producer handle. Provider- and client-agnostic.
- `packages/coding-agent/src/presentation/` — persistence: zod schemas, the
  session journal, the legacy-result parse boundary, and the shared
  model/TUI/ACP projections built on top of the typed structure.
- `packages/coding-agent/src/modes/acp/view/` — the ACP-specific reducer,
  frame union, and wire encoder built on top of both.

## Data flow

```
tool ──▶ ToolPresentationProducer ──▶ ToolPresentationEvent stream
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
         LiveToolPresentationRecord   reduceAcpToolView      renderModelContent /
         (retained record, journal)   (ACP frames + receipts) renderTuiPresentation
                    │                       │
                    ▼                       ▼
         session journal (v4) /    encodeToolFrame ──▶ SessionNotification
         hydrate.ts (replay)              │
                                    outbound coordinator (per-session FIFO)
                                           │
                                           ▼
                                     ACP client
```

The agent loop is the sole owner of `started` and `settled`; a tool only ever
holds a scoped producer handle that can append, declare facts, attach, and
freeze. The third branch — `renderModelContent`/`renderTuiPresentation` as the
model/TUI leg of that flow — is the type-level contract these projections are
built to satisfy, not yet a wired production path: today they have no `src/`
caller, only test callers (`presentation-model-goldens.test.ts`,
`presentation-model-parity.test.ts`, `presentation-hydrate.test.ts`, and the
journal tests), which is the entire enforcement of the projection guarantee
until the golden-locked cutover phase wires a real caller in.

## The presentation event stream

`ToolPresentationEvent` (`presentation/events.ts`) is a closed union:
`started`, `terminal_append`, `terminal_gap`, `live_terminal_attached`,
`fact`, `attachment`, `display_output`, `settled`. Events are **deltas**:
`terminal_append` carries only the newly produced bytes plus the absolute
UTF-8 byte offset they start at, so continuity is a declared, checked property
of the stream (strictly increasing `Sequence`, contiguous `ByteOffset`) rather
than something a consumer infers from repeated text. `terminal_gap` is
first-class: only an explicitly bounded queue that actually dropped
undelivered live bytes may emit one, naming the exact missing range.

- **Facts** (`presentation/facts.ts`) are the closed `ToolFactBody` union —
  `wall_time`, `truncation`, `limit`, `diagnostics`, `artifact`,
  `model_guidance`, `stop_annotation`, `capability_notice`,
  `unreported_annotation`, and the `notice` escape hatch. `FACT_AUDIENCE`
  derives each kind's audience (`model` / `human` / `all`) exhaustively —
  a producer cannot relabel a fact's audience.
- **Outcome** (`presentation/outcome.ts`) is `ToolOutcome`:
  `succeeded` / `failed` / `interrupted`, each optionally carrying a
  `ProcessTermination`. Rendering severity and terminal status are always
  *derived* from it (`presentationSeverity`, `statusChangeForOutcome`), never
  passed alongside it. `mintToolOutcome`/`isMintedToolOutcome` brand
  in-tree-authored outcomes so `coerceToolResult` cannot trust a forged
  `outcome` crossing an MCP/subprocess/extension boundary. `outcome` itself is
  still optional on `AgentToolResult` today, alongside the older `isError`
  flag — see "Known limitations" below.
- **Display output** (`ToolDisplayOutput`) carries an eval cell's structured
  human-visible values (JSON, image dimensions); the producer supplies values
  only, a projection owns labels and layout.

## The producer contract

A tool never receives a raw event emitter. The dispatcher hands it a
`ToolProgressProtocol<TSnapshot>` (`presentation/protocol.ts`) — a
discriminated union of `legacy_snapshot` (the old cumulative-callback route)
or `presentation_events` (a `ToolPresentationProducer`) — exactly one per
call, so a call can never deliver the same output through both a live stream
and a resent snapshot. The producer handle (`presentation/producer.ts`) can
append terminal bytes, declare facts, attach non-text output, register a
flusher, and `freeze()`; it cannot choose its own sequence/offset, emit
`started`/`settled`, or declare a gap. `freeze()` is the flush-before-settlement
barrier the agent loop calls in every settlement path, including throws and
aborts.

## Retention and persistence

Live delivery is uncapped by construction; **retention** is bounded
separately. `LiveToolPresentationRecord`
(`coding-agent/src/presentation/live-record.ts`) folds the live event stream
into the compact `ToolPresentationRecord` (`presentation/record.ts`): one
retained stream window (capped at 1 MiB, with an honest `truncation` fact on
the cut), the ordered facts, attachments, and displays. This record — never
the live event log — is what gets persisted and what drives replay and the
final projections.

The session journal is version 4 (`presentation/journal.ts`): a
`tool_execution_started` entry owns the call descriptor, and a matching
`tool_execution_settled` entry references it by `executionId` rather than
duplicating it. A `started` entry with no following `settled` entry folds to
an explicit `interrupted` `ReplayableToolExecution` — the process can die
mid-call, and that state is representable rather than assumed away. Both
session-loader paths validate every journal entry against its zod schema and
fail closed on a malformed or too-new `recordVersion`.

The exact model-facing content that entered LLM history is frozen separately
as a version-tagged `FrozenModelProjection`, read by context rebuild/
compaction — so a later formatter change can't rewrite historical prompts.
Display replay reads the structured record instead; the two never compete as
display authority.

## Replay

`hydrate.ts`'s versioned adapter turns one `ReplayableToolExecution` back into
a canonical `ToolPresentationEvent` sequence, fed through the **same**
`reduceAcpToolView` live execution uses — `session/load`, branch, rewind/fork,
and compaction all replay through this one adapter. A record has no chunk
granularity (it retained one window, not an event log), so replay emits one
append per retained window/gap/display boundary rather than fabricating
synthetic chunk boundaries. Pre-v4 sessions carry only snapshot-shaped
partials; their replay renders the settled body only, never attempting
byte-stream reconstruction.

## The ACP view

`reduceAcpToolView` (`modes/acp/view/reducer.ts`) is the single state machine
that owns every ACP tool frame. State (`AcpToolViewState`) is one of
`unstarted` / `plain` / `meta_terminal` / `live_terminal` / `settled`; the
channel is chosen once at `started` (`selectAcpToolRenderMode`) and changed
only by explicit typed transitions (e.g. `meta_terminal → content` when an
attachment arrives). Every fact/event the reducer accepts gets a
`DeliveryReceipt` — delivered on a named channel, or explicitly suppressed
with a typed reason (`audience_model_only` / `no_capable_channel`) — so a
dropped fact is a compile-time-exhaustive bug, not a missing case.

`AcpToolFrame` (`modes/acp/view/frames.ts`) is an exclusive union —
`terminal` / `content` / `terminal_control` / `status` — so a terminal frame
structurally cannot carry sibling content, and any `_meta.terminal_*` write
requires a `TerminalMetaCap` witness minted only from capability negotiation.
Status (`completed`/`failed`) is always derived from the typed outcome.
`encodeToolFrame` (`modes/acp/view/encoder.ts`) is the sole place a frame
becomes an SDK `SessionNotification`; it's also the only place `rawOutput` can
be set, and only as the bounded `AcpToolDiagnostic` marker some clients (Zed)
need for refusal classification — never the tool's raw result.

Frames are batched and drained through a per-session FIFO
(`modes/acp/view/outbound-coordinator.ts`): the reducer runs synchronously
before any `await`, and the coordinator serializes whole batches so a
multi-frame transition can't interleave with an unrelated call's frames. A
permission request for a call is enqueued behind that same call's `started`
batch. The first failed send poisons the coordinator — every later enqueue
fails without a wire attempt, so no frame implies the client recovered.

## The legacy compatibility path

Not every result enters the pipeline as typed events. `parseLegacyToolResult`
(`presentation/known-tool-result.ts`) is the one place an untyped tool result
— from an external/MCP tool, or a built-in without a presentation adapter —
becomes a `KnownToolResult`, a closed union every downstream consumer
switches on exhaustively (`satisfies never`). `modes/acp/view/legacy-bash.ts`,
`legacy-edit.ts`, and `legacy-eval.ts` adapt each recognized shape into
synthesized presentation events for the same reducer. `edit`/`patch`/
`apply_patch`, the MCP-proxied eval-shaped tool, and external/MCP tools stay
on this path permanently — see "Known limitations" below for why.

## Known limitations

These are permanent properties of the design, not staged work — noted here so
they read as intentional rather than as gaps to file an issue against.

- **`renderModelContent`/`renderTuiPresentation` have no production caller**
  (see "Data flow" above). Wiring them in would change the exact bytes an
  LLM sees mid-conversation for the tools that are migrated so far
  (`bash`, `eval`), which is a materially higher-risk change than any wire
  or display change in this subsystem, so it stays test-enforced
  (golden/parity suites) until a caller is added deliberately.
- **`edit`, `patch`, and `apply_patch` never get a presentation adapter.**
  They stay on `parseLegacyToolResult` and the projected legacy details bag
  (`edit/legacy-bag.ts`) permanently. The presentation protocol composes a
  call's title before execution and declares `locations` only at `started`;
  `edit`'s title needs the caller's intent (stripped before the tool runs),
  and its real locations (workspace-suffix resolution, move destinations)
  are only known after execution completes. Extending the protocol for
  those two capabilities would also cost multi-file edits their
  intermediate progress frames, since the reducer's plain-content state
  only emits a frame at settlement. `EditFileOutcome`/`AvailableFileChange`
  (`edit/types.ts`) still model the correctness contract as a closed union
  internally — only the wire path stays on the legacy bag.
- **The MCP-proxied eval-shaped tool stays on `legacy_snapshot`.** It's an
  external tool that happens to share eval's interface, not the built-in
  `eval` executor — the same category as any other external/MCP producer,
  not a migration gap in the built-in.
- **`missingNoticeLines` (`modes/acp/acp-event-mapper.ts`) is permanent**
  for external/MCP tools and for any built-in without a presentation
  adapter whose result spills to an artifact (`read`/`grep`/`glob`/`fetch`
  are common instances). It reconciles rendered notice text against an
  already-rendered body because those producers have no structural fact to
  compare against — only rendered text. `bash`/`eval`/`edit` never reach
  it: their notices are intercepted upstream or declared as typed facts.
- **`rawOutput` still carries a tool's raw, untyped result on the two
  mapper code paths above** (external/MCP tools and legacy built-in
  results). `encodeToolFrame` never allows this — every frame it produces
  can only carry the bounded `AcpToolDiagnostic` marker — but those two
  paths bypass the encoder entirely. A real client (Zed) reads
  `raw_output` for refusal classification and as a last-resort render, so
  removing it there would break that client with no typed replacement to
  offer instead.
- **`PresentationDeliveryLedger` (`test/helpers/acp-delivery-ledger.ts`)
  only exists in tests.** Most of it compares typed `DeliveryReceipt`s,
  which would be fine in production. But it also checks whether eval's
  echoed source text reached some rendered channel, and source echo
  carries no fact id — there is no structural record for that one check,
  only rendered frame text to search. Production code must never search
  rendered text to answer a structural question; that's the one thing
  this design exists to make unnecessary. The check stays in the test
  harness, where searching rendered output to catch a regression is fine.
- **`AgentToolResult.outcome` (`packages/agent/src/types.ts`) is optional**,
  alongside the older `isError` flag, not yet the mandatory, sole-authority
  field the rest of this design assumes. External and extension producers
  cannot author `outcome` at all today; `coerceToolResult` derives it from
  `isError` when it's absent, and a producer can currently construct a
  value where an explicit `outcome` and `isError` disagree — the explicit
  `outcome` wins.

## Module map

`packages/agent/src/presentation/`:

| File | Owns |
| --- | --- |
| `events.ts` | `ToolPresentationEvent`, `ToolCallPresentation`, `ToolAttachment`, `ToolDisplayOutput`, `LiveTerminalBinding` |
| `facts.ts` | `ToolFact`/`ToolFactBody`, `FACT_AUDIENCE` |
| `outcome.ts` | `ToolOutcome`, `ProcessTermination`, outcome provenance minting |
| `record.ts` | `ToolPresentationRecord` and its persisted-safe siblings |
| `producer.ts` | `ToolPresentationProducer`, `ToolPresentationStream`, `freeze`/flush |
| `protocol.ts` | `ToolProgressProtocol` (`legacy_snapshot` \| `presentation_events`) |
| `brands.ts` | `ByteOffset`, `Sequence`, `StreamId`, `FactId`, `PresentationVersion` |

`packages/coding-agent/src/presentation/`:

| File | Owns |
| --- | --- |
| `journal.ts` | `PersistedToolJournal`, `ReplayableToolExecution`, `FrozenModelProjection` |
| `known-tool-result.ts` | `parseLegacyToolResult`, `KnownToolResult` |
| `live-record.ts` | `LiveToolPresentationRecord` — live events → retained record |
| `hydrate.ts` | Replay: `ReplayableToolExecution` → canonical event sequence |
| `projections.ts` | `renderModelContent`, `renderTuiPresentation`, shared fact rendering — implemented and golden/parity-tested, but not yet called from `src/`; see the data-flow note above |
| `display-json.ts` | Canonical JSON rendering for `ToolDisplayItem` |
| `utf8.ts` | Shared UTF-8-boundary helpers (`utf8PrefixWithin`) |
| `schemas/` | zod mirrors of the above, for persisted JSON |

`packages/coding-agent/src/modes/acp/view/`:

| File | Owns |
| --- | --- |
| `reducer.ts` | `reduceAcpToolView`, `AcpToolViewState`, `DeliveryReceipt` |
| `frames.ts` | `AcpToolFrame`, `TerminalMetaCap`, status/exit derivation |
| `encoder.ts` | `AcpToolFrame` → `SessionNotification` |
| `outbound-coordinator.ts` | Per-session FIFO frame delivery, permission ordering |
| `legacy-bash.ts` / `legacy-edit.ts` / `legacy-eval.ts` | Legacy-compatibility adapters per producer family |
