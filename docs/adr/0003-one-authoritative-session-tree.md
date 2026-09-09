# 0003. One authoritative session tree; the journal is its patch stream

Status: accepted
Date: 2026-09-02
Area: state

## Context

Anything that must be durable, rewindable, crash-tolerant, and forkable has three ways to survive:
preserve the history that produces it, preserve the changes to the properties that matter, or
preserve the machine itself. The Source Engine networks the second: one entity list is the only
authority, every delta is an entity delta, and `replay(.dem) == original`. Session globals are not
special — `CCSGameRules` is a singleton entity.

omp v1 and pi used none of the three consistently. There are events, but state is not sourced from
them, which violates the first rule of event sourcing: state must be derivable from the events
alone. The result is two authorities:

| | Source Engine | pi-style harness |
| --- | --- | --- |
| source of truth | the entity list | the message tree **plus** todo state, retry counters, subagent registry, streaming flags |
| unit of delta | `{ Δ entity }`, covering every field | `message` / `custom` / `custom_message`, no engine-owned fold |
| globals | one entity, no special cases | three tiers, one of which works |
| plugin state | entity fields, replayed by default | module closures: `let turnCount = 0`, `new Map()`, `new Set()` |
| replay | seek `.dem` to a tick and re-derive | leaf pointer moves; other authorities reset or survive arbitrarily |

The three tiers of globals: journaled tree entries (three blessed types; replays correctly),
journalable `custom` entries (every extension hand-rolls its own derivation; roughly fifteen
lifecycle bugs), and not journaled at all (`AGENTS.md`, extension set, tool roster, settings,
provider config, MCP servers; cannot branch, cannot rewind).

Measured against the 78 official pi extension examples: 60 are stateless; of the 17 that hold
state, 2 are correct under rewind, fork, and resume. Representative failures (Appendix A):

- `status-line.ts` keeps `turnCount` in a closure: rewind from turn 3 to turn 1 yields turn 4;
  resume starts at zero.
- `git-checkpoint.ts` keeps stash refs in a transient `Map` that `agent_settled` clears before
  `/fork` can read it.
- `dynamic-tools.ts` writes only to the live registry: a tool survives rewind, then disappears
  after `--continue`.
- `tic-tac-toe.ts` writes user moves as `custom` entries but restores only from tool results; a
  crash between X and O erases X.

Source's correctness did not come from a careful reconciler or good documentation. It made
non-replayable state unrepresentable. Documentation would not repair this distribution of bugs;
the API permits them (0002).

## Decision

The whole session materializes as **one tree**. XML/DOM is the chosen representation because it
composes, inspects, and debugs easily; an ECS or another representation is acceptable provided
there is exactly one authority.

```xml
<meta>
   <todo>…</todo>          <!-- persistent components, journal-derived -->
   <jobs>…</jobs>
</meta>
<body>                     <!-- the live chain, entries as elements -->
   <user id="e12">…</user>
   <ai id="e13">…</ai>
   <Read id="e14" status="ok">
      <input path="src/main.rs:1-80"/>
      <result lines="80">…</result>
   </Read>
</body>
<queues>
   <steering>…</steering>
   <prompts>…</prompts>
</queues>
```

Rules:

1. The tree is the authority. The journal stores its incremental changes as a property-change
   stream; there is no second entry vocabulary and no engine-less fold.

   ```text
   : todo.done
   event: patch@1
   by: e41
   data: {"ops":[["set",412,"status","completed"],["set",415,"status","in_progress"]]}
   ```

2. Every piece of session state MUST be derivable from the journal alone. At any journal point the
   harness MUST be able to materialize, and therefore snapshot, the whole session.
3. Non-replayable state MUST be unrepresentable. Session globals (todo, jobs, active tool roster,
   extension set, settings, provider config) are elements or attributes of the tree, not a
   separate tier. There is no API through which an extension can hold authoritative state outside
   the tree.
4. Runtime objects MAY cache or index the tree (registries, live sets, hash maps for lookup) but
   NEVER become a second place where truth lives. A cache that disagrees with the tree is a bug in
   the cache.
5. Templates (system prompt, `AGENTS.md`) are stored by hash plus variables, not repeated per
   entry; a storage optimization inside the one authority, not an exemption from it.

## Consequences

- Rewind, fork, resume, replication, prompts, and rendering become operations on one structure
  (0004, 0005); a stateful feature adds an element, never a reconciler.
- Extensions lose the ability to keep `Map`s and counters as truth; they gain state that is
  journaled, branched, and replayed by default.
- Prohibited: `custom` entries with author-owned derivation, per-feature restore hooks as the
  mechanism of correctness, config that cannot be rewound because it was never journaled.
- Cost accepted: the engine owns a DOM, a patch codec, and materialization; the journal format
  carries op-level granularity rather than whole messages. That machinery replaces roughly
  fifteen scattered lifecycle bugs.

## Status in omp

**Implemented.** Primary implementation: `crates/session/src/fold.rs`. Live writes and replay use the same journal-to-DOM fold; replay and Appendix A laws passed P2. `crates/journal/src/gc.rs` derives attachment, assistant-media, compaction, tool-artifact, child-job, checkpoint, and imported-session blob roots across every journal in a project/session namespace. Collection holds an exclusive namespace lease from the authoritative inventory through the CAS sweep, refuses live writers, retains complete branch history unless that same run first prunes it, and fails closed on malformed data, cancellation, or traversal bounds. `crates/journal/src/blob.rs` gives dry-run and apply identical age/candidate selection, serializes collection with atomic placement, and reports eligible separately from reclaimed bytes.

Work-pool presentation is likewise replay-derived: `omp_journal::data::WorkpoolObservation`
converts the producer-authenticated transition into the same typed IRC notice folded by
`omp_agent::append_irc_traffic`; the process-local producer registry never owns durable history.

## References

- The Harness Playbook, "The state" — "What must survive", "What omp taught us: two
  authorities", "The evidence: correctness is optional in the API", "What omp² changes: one
  materialized session"; Appendix A for the nine failures
- 0001 (one authoritative session), 0002 (one owner), 0004 (lifecycle derived from the tree),
  0005 (views as projections), 0034 (transcript protocol)
- `docs/architecture/agent-loop.md` — "Events, storage, and presentation"; `AGENTS.md` Locked
  Deviations from pi
- Source Engine networking (entity deltas, `.dem` replay); event sourcing's derivability rule
