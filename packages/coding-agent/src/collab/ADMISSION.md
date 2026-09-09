# Collab send-queue admission policy

`CollabSocket` holds one FIFO of pending sends shared by every peer in the room.
Frames are admitted one at a time in `#enqueueSend`, and drained by a single
sealing loop, so the head of the queue delays everything behind it. That is the
whole reason this policy exists: the queue is a shared resource, most of its
contents are caused by untrusted guests, and it is not always drainable.

This note states the properties the policy is meant to hold so a reviewer can
check the code against them rather than re-deriving them. It describes what is
there today, including where the shape is awkward.

## The three invariants

**Addressing.** Every queue entry with a non-zero `targetPeer` is work for a peer
the socket is still serving. Violated, a batch for a departed peer holds the head
of the shared queue and is transmitted in full at an id the relay drops, delaying
every other guest's welcome.

**Causation.** The host-generated work an untrusted peer can cause _to be queued_
is bounded, whether or not that work is addressed to them. Violated, a guest
floods the queue with work no per-peer accounting can attribute — one join-notice
broadcast per `hello` — until a broadcast-only backlog reaches the terminal path
and ends sharing for everyone.

Queued work only. The queue is the shared resource this policy governs, and it
governs nothing else a request costs: `hello` re-serializes the whole snapshot
before any admission decision, and `fetch-transcript` reads up to 4 MiB per reply
with no bound on how many reads one peer has in flight or how long a read takes.
Both are inbound work the policy cannot see, so the invariant is about the queue
and cannot be claimed for the host's work in general — see Known gaps.

**Atomicity.** Frames that are only meaningful together are admitted together.
Violated, a guest receives one welcome's `header`/`state`/`entryCount` followed by
chunks built from a different snapshot, and finalizes a replica it believes is
complete — silently, since `#accumulateSnapshotChunk` completes on `final` _or_
`entries.length >= entryCount`.

Addressing and causation are enforced by predicates at the admission point.
Atomicity is enforced structurally: `CollabHost#handleHello` yields the welcome as
the first frame of the snapshot generator, so welcome and chunks are one entry and
a partial admission cannot be expressed.

## The two classifications

**Replica-bearing vs advisory.** A frame is _advisory_ when losing it costs a
transcript line and nothing else; everything else carries replica state whose loss
desynchronizes a guest.

| Frame                                                        | Class                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `event` mirroring a `notice`                                 | advisory                                                                    |
| `welcome` + `snapshot-chunk` train                           | replica-bearing                                                             |
| `entry`, `event` (agent events), `bus`                       | replica-bearing                                                             |
| `state`, `agents`                                            | advisory (level-triggered: re-sent on the next change, so a lost one heals) |
| `transcript`, `ui-request`, `ui-request-end`, `error`, `bye` | replica-bearing                                                             |

**Level- vs edge-triggered.** A _level-triggered_ frame carries a full snapshot of
some state and is re-sent whenever that state changes, so a lost one is corrected
by the next. An _edge-triggered_ frame is a delta; losing one leaves a permanent
hole. `state` and `agents` are level-triggered. `entry`, `event`, `bus` and
`snapshot-chunk` are edge-triggered. `notice` mirrors are edge-triggered, which is
why they are only safe to drop because they are advisory, not because they heal.

The two axes are independent, and the policy currently keys on the first.

## Admission order in `#enqueueSend`

1. **Not being served** — refuse. Covers a peer that has left and the window
   between a shed and its report.
2. **Emitted while reporting a shed, and over capacity** — drop. Anything a report
   causes must not cause another shed; `AgentSession#emit` dispatches listeners
   synchronously, so the host's notice mirror lands inside this scope.
3. **A batch when the peer already has one** — supersede its own previous
   welcome+snapshot, newest wins, no report.
4. Then, by target:
   - **Broadcast** — see the shed order below.
   - **Targeted, at or over the peer's share** — shed that peer and report it.
   - **Targeted, within its share but over capacity** — if it is a welcome batch,
     shed the heaviest _other_ holder and retry, and drop if none exists;
     otherwise drop. The reservation is for a join, not for every response a peer
     can ask for.

## Shed order for a broadcast, and why

```
existing advisory backlog  ->  the incoming frame if advisory  ->  heaviest peer  ->  #failOverload
```

Advisory backlog first because a transcript line is the cheapest thing in the
system to lose, and it is the one kind of broadcast a guest can cause at will.
The incoming frame next, _before_ shedding anyone: a frame classified as safe to
lose must never buy its own admission with a quota-abiding peer's backlog. The
heaviest peer after that, because a broadcast that cannot be admitted otherwise
would end the room, and one guest's replication is worth less than everyone's
session. `#failOverload` last, reached only when the queue holds nothing but
replica-bearing broadcasts — the one state that is genuinely the host's own
overload, where silent loss would leave a guest wrong about whether a command ran.

A shed is never the requesting peer itself: that would discard its backlog to make
room for its own frame and then report it as overloaded.

## What a guest observes

| Outcome                                 | Guest sees                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refused, peer not served                | Nothing; the peer has left or is one microtask from being told to rejoin                                                                                                                                 |
| Advisory dropped                        | One missing transcript line. The roster comes from `state`, which is re-sent on the next change — but `state` is itself advisory, so a guest can hold a stale roster until then                          |
| Advisory shed to admit replica state    | Same                                                                                                                                                                                                     |
| Batch superseded                        | The older snapshot stops before its terminator; the newer welcome re-primes the accumulator                                                                                                              |
| Peer shed for exceeding its share       | A targeted `error` telling it to rejoin, best-effort: under saturation that frame is itself droppable, and the guest's 30 s first-welcome timer and snapshot-progress timer are the client-side backstop |
| Heaviest peer shed to admit a broadcast | Same as above                                                                                                                                                                                            |
| Pair not admittable at all              | No welcome and no chunks; the first-welcome timer fires                                                                                                                                                  |
| A `ui-request` no writable peer took    | No dialog. The host's `requestGuestUi` resolves `unavailable` rather than awaiting an answer nobody was asked for                                                                                        |
| An ask whose last recipient is gone     | A `ui-request-end` for anyone still in the room; `requestGuestUi` resolves `unavailable` rather than waiting on the peer that was shed or left                                                           |
| A reply computed after the asker left   | Nothing, and nothing for whoever holds the id now                                                                                                                                                        |
| Room recreated by a reconnect           | Every guest was closed with the fatal 4001 and must rejoin; the host discards its targeted queue, its retirement records and its peer identities                                                         |
| `#failOverload`                         | Sharing ends with an explicit reason naming what to check                                                                                                                                                |

## An exchange the host started has to end

Two asymmetries between asking and answering.

A registration is not delivery, and a delivery does not stay one. `requestGuestUi`
registers in `#pendingUi` and sends the ask to every writable peer, and the caller
awaits it with no timeout of its own — `ExtensionUIController#requestGuestUiString`
has no local race to settle it either. So `send()` reports admission and the ask
records _which_ peers it was admitted for, in `recipients`; an ask no writable peer
took resolves `unavailable` at the send site. A partial delivery still stands,
since one guest holding the dialog can answer it — which is why the recipients are
tracked rather than counted.

The set only shrinks from there, and emptying it settles the ask. A peer that
leaves, is shed, or gives up write permission on a later `hello` stops being able
to answer anything it was handed, and admission is not a promise that outlives the
peer. `#handleHello` puts a peer back in when it re-poses a pending ask to a new
writable guest, so a joiner can inherit a question nobody left in the room could
answer. A recreated room settles every ask outright, because the relay closed
everyone who could answer at once.

A reply is addressed to a peer incarnation, not an id. `#handleFetchTranscript`
reads a file before it has anything to say, and `isServing` at the reply site
cannot decide the question on its own: retirement records are a bounded
structure, so churn can evict the one that remembers the departure, and a
recreated room clears every record and reissues the ids. Either way the id reads
as served again. `CollabSocket#addressee` captures the addressee up front — it
holds the record against eviction and remembers which room it belongs to — and
reports at the reply site whether the reply still goes to the peer that asked.

A capture is bookkeeping on shared mutable state, so releasing one is as
load-bearing as taking it, and both rules live in the release path. The verdict is
read _before_ the release, because the release drops this capture's own protection
and the trim that follows would otherwise forget the retirement the verdict turns
on — reporting the departed asker as still served. And a release only ever touches
its own room's bookkeeping: a recreated room clears the map, so an old-room
capture has nothing of its own left to release, while the id it held may now carry
a live capture for the new room's occupant.

Retention is why that is safe, so it is only for work whose length the host
controls. The one lease holder is a transcript read: a `stat` plus one read of at
most `TRANSCRIPT_READ_CAP`, local file I/O with no model call and no network in
it. That bounds the work per read, not the wall clock — a slow or contended
filesystem pins one record per outstanding read for as long as it takes, which
`#trimRetired` honours deliberately rather than capping. A prompt or an
`agent-cmd` is unbounded in kind rather than in latency: it can fail a whole model
turn later, which is too long to pin a record for, so those error replies take
`CollabSocket#bestEffortAddressee` instead: it keeps the room and holds nothing. A
departure the record still remembers suppresses the reply, and so does any room
boundary — without the latter a reissued id's own share of the queue pays for the
errors of whoever held it before, and a burst of them is enough to shed the new
occupant mid-snapshot. What is left is the record's own bound: past eviction,
inside one room, a retired id reads as served again. A relay never reissues an id
inside a room, so that costs one stale line the relay drops on arrival.

## Reconnect is a room boundary

A transient host drop destroys the room: `local-relay.ts` closes every guest with
the fatal 4001 and a reconnecting host gets a fresh room that issues peer ids from
1 again, with no `peer-left` for anyone. So a reconnect invalidates _every_ peer id
at once, and three things must be discarded together on reopen, before the socket
reports the open and therefore before any frame from the new room can be
dispatched:

- **Queued targeted work**, which is undeliverable and would otherwise keep a lazy
  batch iterating at a reissued id.
- **Retirement records**, which would permanently refuse a reissued id.
- **The owner's peer identities**, because `CollabHost#peers` is the _permission_
  registry as well as the roster. Leaving it populated let whoever took a reissued
  id inherit the `canWrite` of the guest that held it, and `#handleFrame` admits a
  frame before its sender has said hello — so a read-only link was enough to run a
  `prompt`, `abort` or `agent-cmd`, or to answer a pending `ui-request`.
- **Outstanding guest asks**, settled as `{ kind: "unavailable" }`. The relay closed
  everyone who could answer, so leaving one pending hangs a caller that awaits it
  without racing a local dialog, and `#handleHello` re-poses every pending request to
  the next writable guest — a different occupant of a different room. The request-id
  counter is deliberately _not_ reset, so a late response cannot settle an unrelated
  new request.

The third is why `onRoomRecreated` exists: the socket owns the reconnect signal and
the identities live on the host, so the boundary has to be reported across.

## What a byte charge means

One charge per entry, levied at admission and refunded when the entry leaves the
queue or is discarded. For a frame it is the serialized length in bytes. For a
lazy batch it is the size of the data the iterator keeps reachable — the caller
declares it, because only the caller knows what its generator closed over, and
`CollabHost` passes the size of the snapshot it retained, re-measured after image
stripping.

What that declaration is, exactly: `Buffer.byteLength(JSON.stringify(snapshot))`,
the serialized form in UTF-8 bytes — the unit a frame is charged in and the unit
the budget is named in. Not measured retained memory: a JS string costs 1 byte per
character while it stays Latin-1 and 2 once it does not, so for CJK text this
figure over-reads the heap by about 1.5x, where the UTF-16 code-unit count it
replaced under-read it by 2x. Both directions of error cost something.
Over-declaring refuses joins the budget has room for and sheds other guests to
make room for memory nobody is holding, which is why the host measures after
stripping and not before. Under-declaring lets the queue hold more memory than the
nominal budget: the bound is on declared charge, which is a proxy for the heap and
not a measurement of it.

`WELCOME_IMAGE_STRIP_THRESHOLD` deliberately keeps comparing UTF-16 code units,
against the same serialization. It is not a queue charge and it was tuned in that
unit; in bytes it would fire at roughly a third of the true size on a session
written in CJK and take that guest's images out of replicated history three times
sooner. Stripping is lossy, so the two comparisons use different units on purpose.

That matters because a batch is one entry that can hold a whole cloned session:
`snapshotForReplication()` deep-clones per call, and the clone stays reachable
until the last chunk drains. Charged as nothing, repeated joins stacked clone on
clone — 321 MB of heap growth for a 3.8 MB session, measured over the in-memory
relay — while the 16 MiB budget reported an empty queue. Bytes serialized as
chunks pass through are _not_ charged again: one chunk is materialized at a time,
so the retained charge is the larger and the longer-lived of the two.
`SNAPSHOT_CHUNK_BYTES` is a _soft_ cap on a chunk — `#snapshotChunks` always puts
at least one entry in a chunk, so an entry larger than the cap ships in a chunk of
its own — and the per-entry ceiling behind it is softer than it looks.
`shrinkForReplication` compares `JSON.stringify(entry).length` with
`MAX_REPLICATED_PAYLOAD_BYTES`, so that 1 MiB is 1 Mi UTF-16 code units: measured,
a CJK entry of 700,112 code units comes back unchanged at 2,100,112 bytes, and
`#snapshotChunks` measures its own target in code units too. The last shrink pass
is returned whether or not it fits, as well. So the transient is bounded by up to
3x the nominal figure on non-ASCII text — still comfortably under the relay's
16 MB frame cap, but not the margin the number reads as.

Two consequences worth stating. An entry with nothing ahead of it is admitted
whatever it costs, so a session larger than the whole budget is still shareable
and the real ceiling is the budget plus one entry. And a discard refunds exactly
what was levied, which is only true because there is one charge: a per-chunk
charge levied by the drain loop could not be refunded by an evictor that could
not see it.

The first consequence is load-bearing and easy to lose: with a snapshot that only
the empty-queue exception can admit, the host must put nothing ahead of it and
everything the same `hello` generates behind it must be droppable. The welcome is
inside the batch for the first reason. The join notice is advisory for the second
— as a replica-bearing broadcast it takes the terminal path on a queue that the
snapshot it just admitted has spoken for, which ends sharing for the guest that
was joining.

## Bounds

| Bound                                                 | Value                   | Why this number                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAX_PENDING_SENDS`                                   | 256                     | Entries, not bytes. Deep enough to ride out a reconnect without buffering a session's worth of live traffic                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MAX_PENDING_SEND_BYTES`                              | 16 MiB                  | Declared charge, once per entry, as a proxy for retained memory — a `transcript` reply alone can be 4 MiB and a welcome batch holds a whole session clone. Enough for several concurrent joins on a normal session; a lone entry is admitted past it so an unusually large one still ships. The invariant is on the declarations, not on the heap and not on cumulative work: for finite non-negative declarations the queue holds at most this much charge, or one oversized entry                                                                                |
| `MAX_PEER_PENDING_SENDS`                              | 32                      | Legitimate targeted traffic for one peer is a welcome-plus-snapshot and a handful of `ui-request`s, so a peer holding this many is spamming or hopelessly behind                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MAX_PEER_PENDING_BATCHES`                            | 1                       | A batch always follows a welcome that re-primes the guest's accumulator, so only the newest welcome+snapshot pair is self-consistent. With the welcome inside the generator this reads as one snapshot per peer                                                                                                                                                                                                                                                                                                                                                    |
| `MAX_RETIRED_PEERS`                                   | 256                     | A memory backstop, not the correctness bound. Correctness is an _ordering_ obligation — a record must outlive the frames already on `#recvChain` when the departure arrived — and connection churn can cross any count while an earlier frame is still decrypting, so eviction skips records whose obligation is unmet — undispatched frames, or a reply still being computed for the id — and this bounds only the remainder. Capped at all because relay ids climb for the room's lifetime, and a client with the view link can connect and disconnect in a loop |
| `WS_BACKPRESSURE_THRESHOLD` / `_DRAIN_` / `_RETRY_MS` | 64 KiB / 32 KiB / 25 ms | Hysteresis on the socket's own buffer, so the sender parks and resumes rather than spinning                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Known gaps

- **`hello` re-serializes the whole snapshot.** Every `hello` runs
  `snapshotForReplication()` and `JSON.stringify` over it for the image-strip
  threshold, before any admission decision. A guest can repeat `hello` at will, so
  this is unbounded inbound CPU that the queue policy cannot see. The natural fix
  is to reject a second `hello` from a peer already in `#peers` — a reconnecting
  guest always gets a fresh relay id, so a repeat from a live id is never
  legitimate — but it changes join semantics and is not done here.
- **A transcript read pins a retirement record for as long as it takes.** Each
  `fetch-transcript` reply is capped at `TRANSCRIPT_READ_CAP` (4 MiB) and costs the
  asker one queue entry, so the queue side is accounted for and the work per read
  is bounded. The wall clock is not, and neither is the count: a peer may have any
  number of reads in flight, on files of any size, and each holds an exact capture,
  so a slow filesystem keeps that many records alive. The `stat`/`open`/`read` cost
  is also inbound work the admission policy never sees, which is why the causation
  invariant is stated for queued work only.
- **A batch's charge is declared, not measured.** The queue trusts what
  `sendBatch` was told, so a caller that under-declares under-charges, and there
  is no longer a per-chunk charge to notice runaway output as it passes through.
  One production caller exists and it declares the snapshot it serialized and
  stripped. The figure is also only a proxy for the object graph, loose in both
  directions: Bun shares immutable strings across a `structuredClone`, while every
  entry adds per-property overhead the serialized form does not show. Measured at
  ~1.2x serialized size on an entry-heavy fixture.
- **Fairness is coarse.** `#shedHeaviestPeer` picks by raw entry count with no notion of fault, so a broadcast under pressure can evict a quota-abiding peer and hand it a "rejoin to resync" error. That is a deliberate trade, not an oversight: shedding one peer's backlog and asking it to rejoin is strictly better than ending the session for everyone, which is the only other way to admit that broadcast. A guest that is shed recovers by rejoining; a room that is ended does not recover at all. Attributing broadcast pressure to a cause would let the choice be fault-based instead.
