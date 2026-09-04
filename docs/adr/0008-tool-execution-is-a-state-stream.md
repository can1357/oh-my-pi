# 0008. A tool call is one element whose state streams; no three-callback contract

Status: accepted
Date: 2026-09-02
Area: runtime

## Context

pi's tool contract, kept mostly intact in omp v1, is three callbacks:

```typescript
renderCall(args, theme, context)          // during argument streaming, before execute()
async execute(_id, params)                // -> string
renderResult(result, options, theme, context)  // after execute() settles
```

It looks small, but one operation — preview, execution, model-facing result, human-facing result,
diagnostics, streaming updates, cancellation, journal record — is split into three phases that do
not share an object. Measured on `Edit`:

- `renderCall` opens the file, applies the edits, renders a diff, and has nowhere sanctioned to
  cache any of it.
- `execute` opens the file again, applies again, writes, and returns a diff serialized for the model.
- `renderResult` receives that string and must parse it back, because the human wants syntax
  colour and line numbers. The alternative is stuffing the richer object into `details`, which
  duplicates what is journaled.

The costs: file I/O twice; the edit application recomputed on every streamed character (`renderCall`
is not a coroutine and re-runs from scratch); ser/de over an ad-hoc format just to cross from
`execute` to `renderResult`. Reactivity is opt-in — even a preview that never changes shape has to
duplicate the presentation logic. Doing it efficiently requires an externally driven coroutine, a
place to store its handle, and the same result deserialization anyway.

Two further gaps follow from the same absence. There is no structured channel for warnings or
truncation notices, so tools append prose to the data:

```ts
text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (…)]`)}`;
```

and the model must guess where tool data ends and harness commentary begins. And because `execute`
is not a generator, streaming output needs yet another protocol over the update channel.

The root cause: the contract has no authoritative object whose state moves from "arguments
streaming" through "running" to "settled". Every implementation invents a side channel for it.

## Decision

A tool call MUST be represented as one element in the session tree (0003), and execution MUST be a
bounded, cancellable stream of state mutations to that element — never an async function that
returns text.

The element shape:

```xml
<Edit id="e41" status="running" version="3">
   <input i="Update the parser without changing the public API">…</input>
   <result>…streaming structured state…</result>
   <diag severity="warn">…</diag>
   <usage tokens="0" elapsed-ms="842"/>
</Edit>
```

- The executor MUST mutate this element while it runs: streaming output mutates the `<result>`
  body; a warning creates a `<diag severity="…">` child; cost lands in `<usage>`.
- `status` MUST move through argument streaming → running → settled on the element itself. No side
  channel carries lifecycle.
- While running, clients receive patches to this state. On settle, the final diff against the
  previous state is journaled — once. No client re-parses a result string to recover the object.
- The model, user, journal, remote client, and test harness MUST observe projections of the same
  element (0005). A projection NEVER becomes a second source of truth.
- Argument streaming MUST be consumed live by the executor. Preview work happens once, as the
  arguments arrive, and is reused by the commit; recomputing per character is prohibited.
- Harness notices (`<diag>`) MUST NEVER be interpolated into `<result>` data (0009).

## Consequences

- `Edit` opens the file once, computes the diff once, and both the model projection and the
  coloured human projection derive from the same structured result.
- Cancellation, timeouts, and detachment are states of the element, so every tool gets them
  without opting in (0010, 0011).
- Prohibited: tool APIs with separate render-before / execute / render-after entry points;
  `details` blobs that duplicate journaled state; truncation prose appended to output.
- Cost accepted: the engine owns a patch stream and a settle step per call, and tool authors write
  against a typed event stream instead of returning a string. That is the complexity moving to its
  one owner (0002).

## Status in omp

**Implemented.** Primary implementation: `crates/agent/src/dispatch.rs`. Tool calls stream through one
versioned element and settle through the journal-first session API. Authorization (committed args on
`tool.call`, or `kernel=ready` after streaming), execution start (`kernel=started`), and the terminal
result are separate ordered journal entries;
the start marker replays as `execution-started=true`, so skipped sibling placeholders never claim
effects while a forcibly terminated started call records uncertainty. Lifecycle-hook approval
requirements and native tool-admission requirements are merged before filing, producing one durable
prompt per invocation; timeout or cancellation settles the call as never-started and replay
reconstructs the same decided or withdrawn ticket and skipped terminal.

The `<diag>` channel is typed end to end. `omp_tool::Diag` (`crates/tool/src/diag.rs`) carries
`severity`, a closed native `DiagKind` vocabulary, `text`, and the typed facts a consumer acts on
without parsing prose: `continuation` (selector or argument fetching the next slice), `artifact`
(full-result address), and `omitted` (count + unit). Native tools yield `Ev::Diag` before their
terminal; erasure serializes it as the `{"diag": …}` update envelope that extension tools and the
dispatcher's own `output_bounded` notice also emit, so one journal shape folds into one `<diag>`
child with `severity`/`kind`/`text`/`continuation`/`recovery`/`omitted`/`unit` props. The model
projection (`crates/session/src/projection.rs`) renders every non-terminal diag as one trailing
`<diag severity kind continuation artifact omitted>text</diag>` part after the result — the channel
was previously card-only, which is why tools had appended prose to their data. Environment-side
facts (exec sandbox policy, dynamic-device notices, stale GitHub cache, path recovery) cross
`env/v1` as `ToolDiag` and are yielded by the owning tool, never written into process output or
document bytes.

## References

- The Harness Playbook, "The runtime" — "What omp taught us: one call, three disconnected APIs",
  "The callback split duplicates work", "What omp² changes: execution is a state stream"
- 0003 (session tree), 0005 (projections), 0009 (bounding), 0010 (job primitive), 0011
  (cancellation), 0031 (typed component model for the projections)
- `crates/tool/src/lib.rs` (`Ev`, `ToolTerminal`, `CallOutcome`), `crates/tool/src/incoming.rs`
  (`IncomingParams`), `crates/agent/src/batch.rs` (`SpeculativeCall`)
